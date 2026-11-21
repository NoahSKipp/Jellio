using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

// Creates "new episode" and release notifications once the media can be
// played, not on the air date. A due calendar entry waits in a per-user
// state file; each run asks the server for the media's playback sources
// (what the clients' stream check asks too, resolved by Gelato for virtual
// items) and notifies when a usable one exists. Gives up after 14 days.
public sealed class PlayableNotifyService(
    IUserManager userManager,
    ILibraryManager libraryManager,
    IUserDataManager userDataManager,
    IMediaSourceManager mediaSourceManager,
    CalendarService calendarService,
    ShelfStore shelfStore,
    NotificationStore notifications,
    MediaBrowser.Common.Configuration.IApplicationPaths applicationPaths,
    ILogger<PlayableNotifyService> logger) : BackgroundService
{
    private const int MaxParallelChecks = 3;
    private static readonly TimeSpan FirstRun = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(30);

    private readonly JsonUserStore<PlayableNotifyState> _state =
        new(applicationPaths, "notify-pending", () => new PlayableNotifyState());

    // Library item id to when it last had no stream.
    private readonly ConcurrentDictionary<Guid, DateTime> _negative = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(Jitter(FirstRun), stoppingToken).ConfigureAwait(false);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RunOnceAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Jellio: playable notification run failed");
                }

                await Task.Delay(Jitter(Interval), stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private static TimeSpan Jitter(TimeSpan baseline) =>
        baseline + TimeSpan.FromSeconds(Random.Shared.Next(0, 300));

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return;
        }

        foreach (var user in userManager.GetUsers().ToList())
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                await ProcessUserAsync(user, accessToken, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Jellio: playable notifications failed for {User}", user.Username);
            }
        }
    }

    private async Task ProcessUserAsync(User user, string accessToken, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var today = now.Date;
        var state = _state.Load(user.Id);
        var monitored = calendarService.GetMonitoredItems(user);
        if (monitored.Count == 0 && state.Pending.Count == 0)
        {
            return;
        }

        var known = notifications.Load(user.Id).Select(n => n.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var series = shelfStore.Load(user.Id).Series;

        var dirty = false;
        if (monitored.Count > 0)
        {
            var entries = await calendarService.GetWatchlistCalendarAsync(monitored, accessToken, user).ConfigureAwait(false);
            dirty |= PlayableNotifyLogic.Discover(state, entries, today, now, known, series) > 0;
        }

        foreach (var gaveUp in PlayableNotifyLogic.Prune(state, today, now, known))
        {
            dirty = true;
            logger.LogInformation(
                "Jellio: no stream for {Name} {Detail} within {Days} days of {Date:yyyy-MM-dd}, no notification for {User}",
                gaveUp.Name,
                gaveUp.Detail,
                PlayableNotifyLogic.GiveUpDays,
                gaveUp.Date,
                user.Username);
        }

        var due = PlayableNotifyLogic.Due(state, now, series);
        if (due.Count > 0)
        {
            var requirePlayable = JellioPlugin.Instance?.Configuration.NotifyOnlyWhenPlayable ?? true;
            using var gate = new SemaphoreSlim(MaxParallelChecks);
            var results = await Task.WhenAll(due.Select(async notice =>
            {
                await gate.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    return (Notice: notice, Result: requirePlayable
                        ? await CheckAsync(user, notice, ct).ConfigureAwait(false)
                        : CheckResult.Playable);
                }
                finally
                {
                    gate.Release();
                }
            })).ConfigureAwait(false);

            var created = new List<WatchlistNotification>();
            foreach (var (notice, result) in results)
            {
                dirty = true;
                if (result == CheckResult.Played)
                {
                    state.Pending.Remove(notice.Id);
                    state.Settled[notice.Id] = now;
                }
                else if (result == CheckResult.Playable)
                {
                    created.Add(PlayableNotifyLogic.Complete(state, notice, now));
                }
                else
                {
                    PlayableNotifyLogic.RecordFailure(notice, now);
                }
            }

            if (created.Count > 0)
            {
                notifications.UpdateIfChanged(user.Id, list =>
                {
                    var ids = list.Select(n => n.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var added = false;
                    foreach (var notification in created)
                    {
                        if (ids.Add(notification.Id))
                        {
                            list.Insert(0, notification);
                            added = true;
                        }
                    }

                    return added;
                });
                logger.LogInformation("Jellio: {Count} playable notifications created for {User}", created.Count, user.Username);
            }
        }

        if (dirty)
        {
            _state.Save(user.Id, state);
        }
    }

    private enum CheckResult
    {
        NoStream,
        Playable,
        Played,
    }

    private async Task<CheckResult> CheckAsync(User user, PendingNotice notice, CancellationToken ct)
    {
        var item = FindItem(user, notice);
        if (item == null)
        {
            return CheckResult.NoStream;
        }

        if (item is Episode && userDataManager.GetUserData(user, item)?.Played == true)
        {
            return CheckResult.Played;
        }

        var now = DateTime.UtcNow;
        if (_negative.TryGetValue(item.Id, out var failedAt) && PlayableNotifyLogic.IsNegativeCacheFresh(failedAt, now))
        {
            return CheckResult.NoStream;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CheckTimeout);
        try
        {
            var sources = await mediaSourceManager
                .GetPlaybackMediaSources(item, user, false, false, timeout.Token)
                .ConfigureAwait(false);
            var facts = sources.Select(ToFacts).ToList();
            if (PlayableNotifyLogic.HasPlayableSource(facts))
            {
                _negative.TryRemove(item.Id, out _);
                return CheckResult.Playable;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogDebug("Jellio: stream check timed out for {Name}", notice.Name);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "Jellio: stream check failed for {Name}", notice.Name);
        }

        if (_negative.Count > 5000)
        {
            _negative.Clear();
        }

        _negative[item.Id] = now;
        return CheckResult.NoStream;
    }

    // The movie itself, or the library episode a series entry (S2E5) points at.
    private BaseItem? FindItem(User user, PendingNotice notice)
    {
        if (notice.Type != "Series")
        {
            return libraryManager.GetItemById(notice.ItemId);
        }

        var (season, episode) = CalendarService.ParseSeasonEpisode(notice.Detail);
        if (!season.HasValue || !episode.HasValue)
        {
            return null;
        }

        return libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            AncestorIds = [notice.ItemId],
            IncludeItemTypes = [BaseItemKind.Episode],
            ParentIndexNumber = season.Value,
            IndexNumber = episode.Value,
            Recursive = true,
        }).FirstOrDefault();
    }

    private static SourceFacts ToFacts(MediaSourceInfo source)
    {
        var streams = source.MediaStreams ?? [];
        var video = streams.Any(s => s.Type == MediaStreamType.Video && ((s.Width ?? 0) > 0 || (s.Height ?? 0) > 0 || (s.BitRate ?? 0) > 0));
        var audio = streams.Any(s => s.Type == MediaStreamType.Audio && (!string.IsNullOrEmpty(s.Codec) || (s.Channels ?? 0) > 0));
        return new SourceFacts(source.Name, source.Size, video, audio);
    }
}
