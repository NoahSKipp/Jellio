using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Manga;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.AniSync;

public record AniSyncServiceStatusDto(
    string Id,
    string Name,
    bool Connected,
    string? Username,
    string? MaskedCredential,
    bool HasRefreshToken,
    bool HasCustomClientId,
    string? ServerClientId,
    bool SupportsPinAuth,
    DateTime? UpdatedAtUtc,
    DateTime? LastSyncAtUtc,
    string? LastSyncedTitle,
    string? LastError,
    bool HasServerClientSecret = false);

public record AniSyncLogEntryDto(
    DateTime TimestampUtc,
    string Service,
    string ItemTitle,
    int? EpisodeNumber,
    bool Success,
    string Message);

public record AniSyncSettingsDto(
    string SelectedService,
    bool Enabled,
    bool SyncAllConnected,
    bool OnlyAnimeItems,
    List<AniSyncServiceStatusDto> Services,
    List<AniSyncLogEntryDto> RecentLogs);

public class AniSyncService(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    ISessionManager sessionManager,
    ReadingProgressStore readingProgressStore,
    MangaStreamService mangaStreamService,
    TrackerStore trackerStore,
    ShelfStore shelfStore,
    AniSyncStore store,
    AniSyncProviderClients clients,
    ILogger<AniSyncService> logger) : IHostedService
{
    private static readonly TimeSpan EventDedupeWindow = TimeSpan.FromSeconds(30);
    private static readonly Regex ChapterOrVolumeRegex = new(@"(?:ch(?:apter)?|vol(?:ume)?|ep(?:isode)?|#)\s*\.?\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TrailingChapterSuffixRegex = new(@"\s+(?:ch(?:apter)?|vol(?:ume)?|#)\s*\.?\s*\d+.*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly ConcurrentDictionary<string, DateTime> _recentEvents = new();
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _userLocks = new();
    private readonly ConcurrentDictionary<string, (Guid UserId, string Service, string Verifier, string? ClientId, DateTime ExpiresAtUtc)> _pendingOAuth = new();
    private CancellationTokenSource _shutdownCts = new();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _shutdownCts = new CancellationTokenSource();
        try
        {
            userDataManager.UserDataSaved += OnUserDataSaved;
            sessionManager.PlaybackStopped += OnPlaybackStopped;
            readingProgressStore.ProgressSaved += OnReadingProgressSaved;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: could not subscribe to user data, playback, or reading events.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            userDataManager.UserDataSaved -= OnUserDataSaved;
            sessionManager.PlaybackStopped -= OnPlaybackStopped;
            readingProgressStore.ProgressSaved -= OnReadingProgressSaved;
            _shutdownCts.Cancel();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: error unsubscribing from events.");
        }

        return Task.CompletedTask;
    }

    public string? GetServerClientId(string service)
    {
        var cfg = JellioPlugin.Instance?.Configuration;
        if (cfg == null)
        {
            return null;
        }

        var id = service switch
        {
            AniSyncServices.AniList => cfg.AniListClientId,
            AniSyncServices.MyAnimeList => cfg.MyAnimeListClientId,
            AniSyncServices.Shikimori => cfg.ShikimoriClientId,
            AniSyncServices.Simkl => cfg.SimklClientId,
            _ => null,
        };

        return string.IsNullOrWhiteSpace(id) ? null : id.Trim();
    }

    public string? GetServerClientSecret(string service)
    {
        var cfg = JellioPlugin.Instance?.Configuration;
        if (cfg == null)
        {
            return null;
        }

        var secret = service switch
        {
            AniSyncServices.Shikimori => cfg.ShikimoriClientSecret,
            AniSyncServices.Simkl => cfg.SimklClientSecret,
            _ => null,
        };

        return string.IsNullOrWhiteSpace(secret) ? null : secret.Trim();
    }

    public AniSyncSettingsDto GetSanitizedSettings(Guid userId)
    {
        var record = store.Load(userId);
        var selected = AniSyncServices.Normalize(record.SelectedService) ?? AniSyncServices.AniList;

        var services = AniSyncServices.All.Select(id =>
        {
            record.Providers.TryGetValue(id, out var provider);
            var connected = provider != null && !string.IsNullOrWhiteSpace(provider.EncryptedAccessToken);
            var serverClientId = GetServerClientId(id);
            var hasServerClientSecret = !string.IsNullOrWhiteSpace(GetServerClientSecret(id));

            return new AniSyncServiceStatusDto(
                id,
                AniSyncServices.DisplayName(id),
                connected,
                provider?.Username,
                provider?.MaskedCredential,
                provider != null && !string.IsNullOrWhiteSpace(provider.EncryptedRefreshToken),
                provider != null && !string.IsNullOrWhiteSpace(provider.EncryptedClientId),
                serverClientId,
                id == AniSyncServices.Simkl && !string.IsNullOrWhiteSpace(serverClientId),
                provider?.UpdatedAtUtc,
                provider?.LastSyncAtUtc,
                provider?.LastSyncedTitle,
                provider?.LastError,
                hasServerClientSecret);
        }).ToList();

        var logs = record.RecentLogs
            .Select(l => new AniSyncLogEntryDto(l.TimestampUtc, l.Service, l.ItemTitle, l.EpisodeNumber, l.Success, l.Message))
            .ToList();

        return new AniSyncSettingsDto(selected, record.Enabled, record.SyncAllConnected, record.OnlyAnimeItems, services, logs);
    }

    public (string AuthorizeUrl, string State, string RedirectUri, bool HasClientId) BuildOAuthStartUrl(
        Guid userId,
        string service,
        string? redirectUri,
        string? customClientId)
    {
        PruneExpiredOAuth();
        var normalized = AniSyncServices.Normalize(service) ?? AniSyncServices.AniList;
        var clientId = !string.IsNullOrWhiteSpace(customClientId) ? customClientId.Trim() : (GetServerClientId(normalized) ?? string.Empty);
        var state = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var verifierBytes = RandomNumberGenerator.GetBytes(48);
        var verifier = Convert.ToBase64String(verifierBytes)
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        _pendingOAuth[state] = (userId, normalized, verifier, clientId, DateTime.UtcNow.AddMinutes(15));

        var effectiveRedirect = redirectUri?.Trim() ?? string.Empty;
        string url = normalized switch
        {
            AniSyncServices.AniList =>
                $"https://anilist.co/api/v2/oauth/authorize?client_id={Uri.EscapeDataString(clientId)}&response_type=token",
            AniSyncServices.MyAnimeList =>
                $"https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id={Uri.EscapeDataString(clientId)}&state={Uri.EscapeDataString(state)}&code_challenge={Uri.EscapeDataString(verifier)}&code_challenge_method=plain"
                + (string.IsNullOrEmpty(effectiveRedirect) ? string.Empty : $"&redirect_uri={Uri.EscapeDataString(effectiveRedirect)}"),
            AniSyncServices.Shikimori =>
                $"https://shikimori.one/oauth/authorize?client_id={Uri.EscapeDataString(clientId)}&redirect_uri={Uri.EscapeDataString(string.IsNullOrEmpty(effectiveRedirect) ? "urn:ietf:wg:oauth:2.0:oob" : effectiveRedirect)}&response_type=code&scope=user_rates&state={Uri.EscapeDataString(state)}",
            AniSyncServices.Simkl =>
                $"https://simkl.com/oauth/authorize?response_type=code&client_id={Uri.EscapeDataString(clientId)}&redirect_uri={Uri.EscapeDataString(effectiveRedirect)}&state={Uri.EscapeDataString(state)}",
            _ => string.Empty,
        };

        return (url, state, effectiveRedirect, clientId.Length > 0);
    }

    public bool TryConsumeOAuthVerifier(Guid userId, string service, string? state, out string? verifier, out string? savedClientId)
    {
        verifier = null;
        savedClientId = null;

        if (!string.IsNullOrWhiteSpace(state) && _pendingOAuth.TryRemove(state.Trim(), out var entry))
        {
            if (entry.UserId == userId && entry.Service == service && entry.ExpiresAtUtc > DateTime.UtcNow)
            {
                verifier = entry.Verifier;
                savedClientId = entry.ClientId;
                return true;
            }
        }

        // Fallback: find the newest matching pending OAuth state for this user + service.
        var latestKey = _pendingOAuth
            .Where(kv => kv.Value.UserId == userId && kv.Value.Service == service && kv.Value.ExpiresAtUtc > DateTime.UtcNow)
            .OrderByDescending(kv => kv.Value.ExpiresAtUtc)
            .Select(kv => kv.Key)
            .FirstOrDefault();

        if (latestKey != null && _pendingOAuth.TryRemove(latestKey, out var fallback))
        {
            verifier = fallback.Verifier;
            savedClientId = fallback.ClientId;
            return true;
        }

        return false;
    }

    public async Task<(bool Ok, string Message)> TestConnectionAsync(Guid userId, string service, CancellationToken ct)
    {
        var normalized = AniSyncServices.Normalize(service);
        if (normalized == null)
        {
            return (false, "Unsupported service.");
        }

        var creds = store.GetDecryptedCredentials(userId, normalized);
        if (creds == null || string.IsNullOrWhiteSpace(creds.AccessToken))
        {
            return (false, $"No saved credentials for {AniSyncServices.DisplayName(normalized)}.");
        }

        var clientId = creds.ClientId ?? GetServerClientId(normalized);
        var clientSecret = creds.ClientSecret ?? GetServerClientSecret(normalized);
        var verify = await clients.VerifyAsync(normalized, creds.AccessToken, clientId, ct).ConfigureAwait(false);

        if (!verify.Success && !string.IsNullOrWhiteSpace(creds.RefreshToken))
        {
            var refreshed = await clients.TryRefreshTokenAsync(normalized, creds.RefreshToken, clientId, clientSecret, ct).ConfigureAwait(false);
            if (refreshed.Success && !string.IsNullOrWhiteSpace(refreshed.AccessToken))
            {
                var reverify = await clients.VerifyAsync(normalized, refreshed.AccessToken, clientId, ct).ConfigureAwait(false);
                if (reverify.Success)
                {
                    store.SaveProviderCredentials(
                        userId,
                        normalized,
                        reverify.Username ?? creds.Username,
                        reverify.ExternalUserId ?? creds.ExternalUserId,
                        refreshed.AccessToken,
                        refreshed.RefreshToken ?? creds.RefreshToken,
                        creds.ClientId,
                        creds.ClientSecret,
                        refreshed.ExpiresAtUtc,
                        makeActive: false);
                    return (true, $"Connected as {reverify.Username}.");
                }
            }
        }

        store.Update(userId, rec =>
        {
            if (rec.Providers.TryGetValue(normalized, out var p))
            {
                if (verify.Success)
                {
                    p.Username = verify.Username ?? p.Username;
                    p.ExternalUserId = verify.ExternalUserId ?? p.ExternalUserId;
                    p.LastError = null;
                }
                else
                {
                    p.LastError = verify.ErrorMessage;
                }
            }
        });

        return verify.Success
            ? (true, $"Connected as {verify.Username}.")
            : (false, verify.ErrorMessage ?? "Verification failed.");
    }

    public async Task<(int SyncedCount, int FailedCount, string Message)> SyncRecentWatchedAsync(
        Guid userId,
        string? serviceOverride,
        int limit,
        CancellationToken ct,
        string? range = null)
    {
        var user = userManager.GetUserById(userId);
        if (user == null)
        {
            return (0, 0, "User not found.");
        }

        var record = store.Load(userId);
        var targets = ResolveTargetServices(record, serviceOverride);
        if (targets.Count == 0)
        {
            return (0, 0, "Connect an Ani-Sync service first.");
        }

        var normalizedRange = (range ?? "recent").Trim().ToLowerInvariant();
        DateTime? cutoffUtc = normalizedRange switch
        {
            "week" or "last_week" or "7d" => DateTime.UtcNow.AddDays(-7),
            "month" or "last_month" or "30d" => DateTime.UtcNow.AddDays(-30),
            "year" or "last_year" or "365d" => DateTime.UtcNow.AddDays(-365),
            "all" or "all_time" => null,
            _ => null,
        };
        bool isRangeSync = normalizedRange is "week" or "last_week" or "7d" or "month" or "last_month" or "30d" or "year" or "last_year" or "365d" or "all" or "all_time";
        int effectiveLimit = normalizedRange switch
        {
            "week" or "last_week" or "7d" => Math.Max(limit, 100),
            "month" or "last_month" or "30d" => Math.Max(limit, 250),
            "year" or "last_year" or "365d" => Math.Max(limit, 500),
            "all" or "all_time" => Math.Max(limit, 1000),
            _ => Math.Clamp(limit, 1, 20),
        };
        int queryLimit = isRangeSync ? Math.Clamp(effectiveLimit * 4, 200, 4000) : Math.Clamp(effectiveLimit * 4, 10, 80);

        var playedItems = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Episode, BaseItemKind.Movie],
            IsPlayed = true,
            OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
            Recursive = true,
            Limit = queryLimit,
        }) ?? [];

        int synced = 0;
        int failed = 0;
        int considered = 0;
        var seenAnimeSeries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var item in playedItems)
        {
            if (considered >= effectiveLimit)
            {
                break;
            }

            if (cutoffUtc.HasValue)
            {
                var playedAt = userDataManager.GetUserData(user, item)?.LastPlayedDate;
                if (!playedAt.HasValue || playedAt.Value.ToUniversalTime() < cutoffUtc.Value)
                {
                    continue;
                }
            }

            var syncTarget = BuildSyncTarget(item, record.OnlyAnimeItems);
            if (syncTarget == null)
            {
                continue;
            }

            if (isRangeSync)
            {
                var seriesKey = item is Episode ep && ep.SeriesId != Guid.Empty
                    ? ep.SeriesId.ToString("N")
                    : item.Id.ToString("N");
                if (!seenAnimeSeries.Add(seriesKey))
                {
                    continue;
                }
            }

            if (considered > 0)
            {
                await Task.Delay(isRangeSync ? 1200 : 300, ct).ConfigureAwait(false);
            }

            considered++;
            foreach (var service in targets)
            {
                var ok = await SyncTargetWithServiceAsync(userId, service, item, syncTarget, ct).ConfigureAwait(false);
                if (ok)
                {
                    synced++;
                }
                else
                {
                    failed++;
                }
            }
        }

        if (considered < effectiveLimit)
        {
            var seenReadSeries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var completedReadsQuery = readingProgressStore.GetAll(userId)
                .Where(kv => kv.Value.Progress >= 0.98);
            if (cutoffUtc.HasValue)
            {
                completedReadsQuery = completedReadsQuery.Where(kv => kv.Value.UpdatedAt.UtcDateTime >= cutoffUtc.Value);
            }

            var completedReads = completedReadsQuery
                .OrderByDescending(kv => kv.Value.UpdatedAt)
                .Take(queryLimit);

            foreach (var (key, _) in completedReads)
            {
                if (considered >= effectiveLimit)
                {
                    break;
                }

                if (!Guid.TryParseExact(key, "N", out var readItemId))
                {
                    continue;
                }

                var resolved = await BuildReadSyncTargetAsync(userId, readItemId, record.OnlyAnimeItems, ct).ConfigureAwait(false);
                if (resolved == null)
                {
                    continue;
                }

                var (syncTarget, seriesKey) = resolved.Value;
                if (!seenReadSeries.Add(seriesKey))
                {
                    continue;
                }

                considered++;
                foreach (var service in targets)
                {
                    var ok = await SyncResolvedTargetWithServiceAsync(userId, service, $"{seriesKey}:{service}", syncTarget, ct).ConfigureAwait(false);
                    if (ok)
                    {
                        synced++;
                    }
                    else
                    {
                        failed++;
                    }
                }
            }
        }

        if (considered == 0)
        {
            return (0, 0, "No watched anime or read manga items found for that timeframe.");
        }

        return (synced, failed, $"Processed {considered} item(s): {synced} synced, {failed} error(s).");
    }

    public async Task SyncItemForUserAsync(Guid userId, BaseItem item, CancellationToken ct)
    {
        var record = store.Load(userId);
        if (!record.Enabled)
        {
            return;
        }

        var targets = ResolveTargetServices(record, null);
        if (targets.Count == 0)
        {
            return;
        }

        var syncTarget = BuildSyncTarget(item, record.OnlyAnimeItems);
        if (syncTarget == null)
        {
            return;
        }

        var userLock = _userLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await userLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            foreach (var service in targets)
            {
                await SyncTargetWithServiceAsync(userId, service, item, syncTarget, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            userLock.Release();
        }
    }

    public async Task SyncReadItemForUserAsync(Guid userId, Guid itemId, CancellationToken ct)
    {
        var record = store.Load(userId);
        if (!record.Enabled)
        {
            return;
        }

        var targets = ResolveTargetServices(record, null);
        if (targets.Count == 0)
        {
            return;
        }

        var resolved = await BuildReadSyncTargetAsync(userId, itemId, record.OnlyAnimeItems, ct).ConfigureAwait(false);
        if (resolved == null)
        {
            return;
        }

        var (syncTarget, seriesKey) = resolved.Value;
        var userLock = _userLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await userLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            foreach (var service in targets)
            {
                await SyncResolvedTargetWithServiceAsync(userId, service, $"{seriesKey}:{service}", syncTarget, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            userLock.Release();
        }
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        try
        {
            if (e.SaveReason == UserDataSaveReason.UpdateUserRating || e.UserData is not { Played: true } || e.Item is null)
            {
                return;
            }

            EnqueueBackgroundSync(e.UserId, e.Item);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio Ani-Sync: error in OnUserDataSaved");
        }
    }

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        try
        {
            if (!e.PlayedToCompletion || e.Item is null)
            {
                return;
            }

            foreach (var user in e.Users)
            {
                EnqueueBackgroundSync(user.Id, e.Item);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio Ani-Sync: error in OnPlaybackStopped");
        }
    }

    private void OnReadingProgressSaved(Guid userId, Guid itemId, double progress)
    {
        try
        {
            if (userId == Guid.Empty || itemId == Guid.Empty || progress < 0.98)
            {
                return;
            }

            var key = $"read:{userId:N}:{itemId:N}";
            if (!TryClaimEventKey(key))
            {
                return;
            }

            var record = store.Load(userId);
            if (!record.Enabled || record.Providers.Count == 0)
            {
                return;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await SyncReadItemForUserAsync(userId, itemId, _shutdownCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Jellio Ani-Sync: background manga sync failed for user {UserId}, item {ItemId}", userId, itemId);
                }
            });
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio Ani-Sync: error in OnReadingProgressSaved");
        }
    }

    private void EnqueueBackgroundSync(Guid userId, BaseItem item)
    {
        if (userId == Guid.Empty || (item is not Episode && item is not Movie))
        {
            return;
        }

        var key = $"{userId:N}:{item.Id:N}";
        if (!TryClaimEventKey(key))
        {
            return;
        }

        var record = store.Load(userId);
        if (!record.Enabled || record.Providers.Count == 0)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await SyncItemForUserAsync(userId, item, _shutdownCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio Ani-Sync: background sync failed for user {UserId}, item {ItemId}", userId, item.Id);
            }
        });
    }

    private bool TryClaimEventKey(string key)
    {
        var now = DateTime.UtcNow;
        if (_recentEvents.TryGetValue(key, out var last) && now - last < EventDedupeWindow)
        {
            return false;
        }

        _recentEvents[key] = now;
        if (_recentEvents.Count > 500)
        {
            foreach (var oldKey in _recentEvents.Where(kv => now - kv.Value > EventDedupeWindow).Select(kv => kv.Key).ToList())
            {
                _recentEvents.TryRemove(oldKey, out _);
            }
        }

        return true;
    }

    private Task<bool> SyncTargetWithServiceAsync(
        Guid userId,
        string service,
        BaseItem item,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        var linkKey = ResolveSeriesOrItemKey(item, service);
        return SyncResolvedTargetWithServiceAsync(userId, service, linkKey, target, ct);
    }

    private async Task<bool> SyncResolvedTargetWithServiceAsync(
        Guid userId,
        string service,
        string linkKey,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        var creds = store.GetDecryptedCredentials(userId, service);
        if (creds == null)
        {
            return false;
        }

        var effectiveClientId = creds.ClientId ?? GetServerClientId(service);
        var record = store.Load(userId);
        record.MediaLinks.TryGetValue(linkKey, out var cachedRemoteId);

        var outcome = await clients.SyncProgressAsync(creds, effectiveClientId, cachedRemoteId, target, ct).ConfigureAwait(false);

        if (!string.IsNullOrWhiteSpace(outcome.NewAccessToken))
        {
            store.SaveProviderCredentials(
                userId,
                service,
                creds.Username,
                creds.ExternalUserId,
                outcome.NewAccessToken,
                outcome.NewRefreshToken,
                creds.ClientId,
                creds.ClientSecret,
                outcome.NewExpiresAtUtc,
                makeActive: false);
        }

        if (!string.IsNullOrWhiteSpace(outcome.ResolvedMediaId))
        {
            store.Update(userId, r => r.MediaLinks[linkKey] = outcome.ResolvedMediaId);
        }

        if (!outcome.Skipped || !outcome.Success)
        {
            store.RecordSyncOutcome(userId, service, target.Title, target.EpisodeNumber, outcome.Success, outcome.Message, target.IsManga);
        }

        return outcome.Success;
    }

    private async Task<(AniSyncSyncTarget Target, string SeriesKey)?> BuildReadSyncTargetAsync(
        Guid userId,
        Guid itemId,
        bool onlyAnimeItems,
        CancellationToken ct)
    {
        var item = libraryManager.GetItemById(itemId);
        if (item != null)
        {
            if (item.GetBaseItemKind() != BaseItemKind.Book)
            {
                return null;
            }

            if (onlyAnimeItems && !IsMangaBook(userId, item))
            {
                return null;
            }

            var seriesTitle = ResolveBookSeriesTitle(item);
            if (string.IsNullOrWhiteSpace(seriesTitle))
            {
                return null;
            }

            var chapterNum = item.IndexNumber ?? ParseChapterOrVolumeNumber(item.Name) ?? 1;
            var providerIds = MergeProviderIds(item, null);
            var target = new AniSyncSyncTarget(
                seriesTitle,
                item.OriginalTitle,
                item.ProductionYear,
                SeasonNumber: null,
                EpisodeNumber: chapterNum,
                IsMovie: false,
                IsCompleted: false,
                providerIds,
                IsManga: true);
            var seriesKey = $"manga:lib:{ShelfStore.SeriesKey(seriesTitle)}";
            return (target, seriesKey);
        }

        var streamed = await mangaStreamService.FindChapterAsync(itemId.ToString("N"), null, ct).ConfigureAwait(false);
        if (streamed is { } found)
        {
            var chapterNum = found.Chapter.Number >= 1 ? (int)Math.Floor(found.Chapter.Number) : 1;
            var providerIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var trackerData = trackerStore.Load(userId);
            if (trackerData.Links.TryGetValue(found.Series.Key, out var trackLink) && trackLink.MediaId > 0)
            {
                providerIds["AniList"] = trackLink.MediaId.ToString(CultureInfo.InvariantCulture);
            }

            var target = new AniSyncSyncTarget(
                found.Series.Title,
                null,
                null,
                SeasonNumber: null,
                EpisodeNumber: chapterNum,
                IsMovie: false,
                IsCompleted: false,
                providerIds,
                IsManga: true);
            return (target, $"manga:{found.Series.Key}");
        }

        return null;
    }

    private bool IsMangaBook(Guid userId, BaseItem item)
    {
        var ext = Path.GetExtension(item.Path ?? string.Empty);
        if (ext.Equals(".cbz", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".cbr", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".cb7", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".cbt", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (HasAnimeMarker(item))
        {
            return true;
        }

        if (item.Tags != null && item.Tags.Any(t => t.Equals("manga", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (item.Genres != null && item.Genres.Any(g => g.Equals("manga", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (!string.IsNullOrEmpty(item.Path) && item.Path.Contains("manga", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var shelf = shelfStore.Load(userId);
        var itemShelfKey = "i:" + item.Id.ToString("N");
        var seriesTitle = ResolveBookSeriesTitle(item);
        var seriesShelfKey = string.IsNullOrWhiteSpace(seriesTitle) ? null : ShelfStore.SeriesShelfKey(seriesTitle);
        return shelf.Categories.Any(c =>
            c.Kind == "manga"
            && (c.Items.Contains(itemShelfKey) || (seriesShelfKey != null && c.Items.Contains(seriesShelfKey))));
    }

    private string ResolveBookSeriesTitle(BaseItem item)
    {
        var parent = item.ParentId != Guid.Empty ? libraryManager.GetItemById(item.ParentId) : null;
        if (parent != null && parent.GetBaseItemKind() == BaseItemKind.Folder && !string.IsNullOrWhiteSpace(parent.Name))
        {
            // If the parent is a series folder (and not a generic root like "Manga" or "Books"), use it.
            var pName = parent.Name.Trim();
            if (!pName.Equals("manga", StringComparison.OrdinalIgnoreCase)
                && !pName.Equals("books", StringComparison.OrdinalIgnoreCase)
                && !pName.Equals("comics", StringComparison.OrdinalIgnoreCase))
            {
                return pName;
            }
        }

        var rawName = (item.Name ?? string.Empty).Trim();
        var cleaned = TrailingChapterSuffixRegex.Replace(rawName, string.Empty).Trim();
        return string.IsNullOrWhiteSpace(cleaned) ? rawName : cleaned;
    }

    private static int? ParseChapterOrVolumeNumber(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var match = ChapterOrVolumeRegex.Match(name);
        if (match.Success && int.TryParse(match.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var num) && num > 0)
        {
            return num;
        }

        return null;
    }

    private AniSyncSyncTarget? BuildSyncTarget(BaseItem item, bool onlyAnimeItems)
    {
        if (item is Episode ep)
        {
            Series? series = null;
            try
            {
                series = ep.Series;
            }
            catch
            {
            }

            series ??= ep.SeriesId != Guid.Empty ? libraryManager.GetItemById(ep.SeriesId) as Series : null;
            if (series == null)
            {
                return null;
            }

            if (onlyAnimeItems && !IsAnimeItem(series, ep))
            {
                return null;
            }

            if (ep.ParentIndexNumber == 0)
            {
                // Skip specials season 0 from numbered episode progress increments.
                return null;
            }

            var providerIds = MergeProviderIds(series, ep);
            return new AniSyncSyncTarget(
                series.Name ?? ep.SeriesName ?? ep.Name ?? "Unknown",
                series.OriginalTitle,
                series.ProductionYear,
                ep.ParentIndexNumber,
                ep.IndexNumber,
                IsMovie: false,
                IsCompleted: false,
                providerIds);
        }

        if (item is Movie movie)
        {
            if (onlyAnimeItems && !IsAnimeItem(movie, movie))
            {
                return null;
            }

            var providerIds = MergeProviderIds(movie, null);
            return new AniSyncSyncTarget(
                movie.Name ?? "Unknown",
                movie.OriginalTitle,
                movie.ProductionYear,
                SeasonNumber: null,
                EpisodeNumber: 1,
                IsMovie: true,
                IsCompleted: true,
                providerIds);
        }

        return null;
    }

    private bool IsAnimeItem(BaseItem primary, BaseItem? child)
    {
        var animeIds = AnimeCatalog.GetIds(libraryManager);
        if (animeIds.Contains(primary.Id))
        {
            return true;
        }

        if (HasAnimeMarker(primary) || (child != null && HasAnimeMarker(child)))
        {
            return true;
        }

        return false;
    }

    private static bool HasAnimeMarker(BaseItem item)
    {
        if (item.Tags != null && item.Tags.Any(t => t.Equals("anime", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (item.Genres != null && item.Genres.Any(g => g.Equals("anime", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (item.ProviderIds != null)
        {
            foreach (var key in item.ProviderIds.Keys)
            {
                if (key.Equals("AniList", StringComparison.OrdinalIgnoreCase)
                    || key.Equals("MAL", StringComparison.OrdinalIgnoreCase)
                    || key.Equals("MyAnimeList", StringComparison.OrdinalIgnoreCase)
                    || key.Equals("AniDB", StringComparison.OrdinalIgnoreCase)
                    || key.Equals("Kitsu", StringComparison.OrdinalIgnoreCase)
                    || key.Equals("Shikimori", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static Dictionary<string, string> MergeProviderIds(BaseItem primary, BaseItem? episode)
    {
        var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (primary.ProviderIds != null)
        {
            foreach (var kv in primary.ProviderIds)
            {
                if (!string.IsNullOrWhiteSpace(kv.Value))
                {
                    merged[kv.Key] = kv.Value;
                }
            }
        }

        if (episode?.ProviderIds != null)
        {
            foreach (var kv in episode.ProviderIds)
            {
                if (!string.IsNullOrWhiteSpace(kv.Value) && !merged.ContainsKey(kv.Key))
                {
                    merged[kv.Key] = kv.Value;
                }
            }
        }

        return merged;
    }

    private static string ResolveSeriesOrItemKey(BaseItem item, string service)
    {
        if (item is Episode ep && ep.SeriesId != Guid.Empty)
        {
            return $"{ep.SeriesId:N}:s{ep.ParentIndexNumber ?? 1}:{service}";
        }

        return $"{item.Id:N}:{service}";
    }

    private static List<string> ResolveTargetServices(AniSyncUserRecord record, string? serviceOverride)
    {
        var specific = AniSyncServices.Normalize(serviceOverride);
        if (specific != null)
        {
            return record.Providers.ContainsKey(specific) ? [specific] : [];
        }

        if (record.SyncAllConnected)
        {
            return AniSyncServices.All.Where(s => record.Providers.ContainsKey(s)).ToList();
        }

        var selected = AniSyncServices.Normalize(record.SelectedService) ?? AniSyncServices.AniList;
        return record.Providers.ContainsKey(selected) ? [selected] : [];
    }

    private void PruneExpiredOAuth()
    {
        var now = DateTime.UtcNow;
        foreach (var k in _pendingOAuth.Where(kv => kv.Value.ExpiresAtUtc <= now).Select(kv => kv.Key).ToList())
        {
            _pendingOAuth.TryRemove(k, out _);
        }
    }
}
