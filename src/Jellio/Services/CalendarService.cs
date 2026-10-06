using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public record CalendarEntry(DateTime Date, string Kind, string? Detail);

// Real shape Controllers/CalendarController.cs's own real response
// already carried before this method existed, moved here rather than
// left duplicated: Controllers/NotificationsController.cs's own real
// watchlist scan needs the exact same real per item TMDB lookup this
// file's own GetMovieEntryAsync/GetSeriesEntryAsync already do, not a
// second copy of the same real ProviderIds.Tmdb plus SemaphoreSlim
// throttle logic.
public record WatchlistCalendarItem(Guid ItemId, string Name, string Type, DateTime Date, string Kind, string? Detail);

/// <summary>
/// TMDB lookups for Controllers/CalendarController.cs's own real per user
/// Watchlist scan: every Gelato imported Movie/Series already carries a
/// real ProviderIds.Tmdb (confirmed live against a real sample of
/// imports before any of this was written, ProviderIds.Imdb never once
/// present even on mainstream titles, so this goes straight to TMDB's
/// own id rather than the Imdb-keyed /find lookup a first pass here
/// assumed it would need). Sent as a real Bearer token
/// (PluginConfiguration.TmdbAccessToken, a v4 "API Read Access Token"),
/// never a query string api_key, so it never sits in a server access
/// log. Cached in memory only, same real ephemeral tradeoff
/// GroupWatchChatService's own header already explains: a release date
/// does not change minute to minute, and a plugin restart just means
/// the next real request pays for a fresh lookup, not a lost one.
/// </summary>
public class CalendarService(
    IHttpClientFactory httpClientFactory,
    ILibraryManager libraryManager,
    IUserDataManager userDataManager,
    ILogger<CalendarService> logger
)
{
    private const string BaseUrl = "https://api.themoviedb.org/3";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly ConcurrentDictionary<string, (DateTime CachedAt, CalendarEntry? Entry)> _cache = new();

    /// <summary>
    /// Returns all library items that should be monitored for upcoming releases or air dates:
    /// 1. Items on the user's Watchlist (IsFavorite = true) - both movies and series.
    /// 2. Currently watched / continuing TV shows:
    ///    - Continuing/airing series where user has watched episodes, even if all currently
    ///      available local episodes are watched (userData.Played = true).
    ///    - In-progress series where unplayed episodes remain and the user has actively watched recently.
    /// </summary>
    public IReadOnlyList<BaseItem> GetMonitoredItems(User user)
    {
        var monitored = new Dictionary<Guid, BaseItem>();

        // 1. Explicit watchlist (favorites)
        var watchlist = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IsFavorite = true,
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
        });

        foreach (var item in watchlist)
        {
            monitored[item.Id] = item;
        }

        // 2. Currently watched & ongoing/airing series
        var allSeries = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Series],
        });

        var now = DateTime.UtcNow;
        var inProgressCutoff = now.AddDays(-180); // 6 months active window for in-progress series
        var continuingCutoff = now.AddDays(-365); // 1 year active window for caught-up continuing series

        foreach (var item in allSeries)
        {
            if (monitored.ContainsKey(item.Id))
            {
                continue;
            }

            if (item is not Series series)
            {
                continue;
            }

            var userData = userDataManager.GetUserData(user, series);
            if (userData == null)
            {
                continue;
            }

            var hasWatched = userData.Played || userData.PlayCount > 0 || userData.LastPlayedDate.HasValue || userData.PlaybackPositionTicks > 0;
            if (!hasWatched)
            {
                continue;
            }

            // Definitively ended series that the user already completed
            if (series.Status == MediaBrowser.Model.Entities.SeriesStatus.Ended && userData.Played)
            {
                continue;
            }

            // Continuing / actively airing shows:
            // Even if the user finished all currently available episodes (userData.Played == true),
            // the show is still airing new episodes. Respect continuing status and keep monitoring.
            if (series.Status == MediaBrowser.Model.Entities.SeriesStatus.Continuing)
            {
                if (!userData.LastPlayedDate.HasValue || userData.LastPlayedDate.Value >= continuingCutoff)
                {
                    monitored[series.Id] = series;
                    continue;
                }
            }
            else if (series.Status != MediaBrowser.Model.Entities.SeriesStatus.Ended && userData.Played)
            {
                // Unspecified status but completed recently (within 90 days): monitor in case next season airs
                if (userData.LastPlayedDate.HasValue && userData.LastPlayedDate.Value >= now.AddDays(-90))
                {
                    monitored[series.Id] = series;
                    continue;
                }
            }

            // In-progress shows (unplayed episodes still remain in library)
            if (!userData.Played)
            {
                // In-progress episode currently paused
                if (userData.PlaybackPositionTicks > 0)
                {
                    monitored[series.Id] = series;
                    continue;
                }

                // Or played recently (or play count > 0 with no timestamp)
                if (!userData.LastPlayedDate.HasValue || userData.LastPlayedDate.Value >= inProgressCutoff)
                {
                    monitored[series.Id] = series;
                    continue;
                }
            }
        }

        return monitored.Values.ToList();
    }

    // Moved verbatim from Controllers/CalendarController.cs's own
    // former Get(): a concurrency cap rather than a bare Task.WhenAll,
    // TMDB's own real rate limit is generous but not unlimited, and a
    // large watchlist should not fire every request in one real burst.
    // A cache hit above skips the real round trip entirely regardless
    // of how many callers (CalendarController, NotificationsController)
    // ask for the same real item the same day.
    public async Task<List<WatchlistCalendarItem>> GetWatchlistCalendarAsync(
        IReadOnlyList<BaseItem> watchlist,
        string accessToken
    )
    {
        using var throttle = new SemaphoreSlim(8);
        var entryTasks = watchlist
            .Select(async item =>
            {
                // ProviderIds is a plain Dictionary<string, string> (real
                // shape confirmed against BaseItem.cs before writing this,
                // no GetProviderId/MetadataProvider helper actually exists
                // on this Jellyfin version to wrap it). "Tmdb" is the real
                // literal key GelatoManager itself writes, confirmed live
                // against a real sample of imported items rather than
                // assumed: ProviderIds.Imdb never once present, even on
                // mainstream titles.
                if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) || string.IsNullOrEmpty(tmdbId))
                {
                    return null;
                }

                await throttle.WaitAsync().ConfigureAwait(false);
                try
                {
                    var entry = item is Movie
                        ? await GetMovieEntryAsync(tmdbId, accessToken).ConfigureAwait(false)
                        : item is Series
                            ? await GetSeriesEntryAsync(tmdbId, accessToken).ConfigureAwait(false)
                            : null;
                    if (entry == null)
                    {
                        return null;
                    }

                    return new WatchlistCalendarItem(item.Id, item.Name, item is Movie ? "Movie" : "Series", entry.Date, entry.Kind, entry.Detail);
                }
                finally
                {
                    throttle.Release();
                }
            })
            .ToList();

        var entries = await Task.WhenAll(entryTasks).ConfigureAwait(false);
        return entries.Where(entry => entry != null).Select(entry => entry!).OrderBy(entry => entry.Date).ToList();
    }

    private HttpClient CreateClient(string accessToken)
    {
        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(BaseUrl + "/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    public async Task<CalendarEntry?> GetMovieEntryAsync(string tmdbId, string accessToken)
    {
        var cacheKey = "movie:" + tmdbId;
        if (TryGetCached(cacheKey, out var cached))
        {
            return cached;
        }

        CalendarEntry? entry = null;
        try
        {
            using var client = CreateClient(accessToken);
            using var response = await client.GetAsync("movie/" + tmdbId + "/release_dates").ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream).ConfigureAwait(false);
                entry = PickDigitalRelease(doc);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Jellio: could not fetch TMDB release dates for movie {TmdbId}", tmdbId);
        }

        _cache[cacheKey] = (DateTime.UtcNow, entry);
        return entry;
    }

    public async Task<CalendarEntry?> GetSeriesEntryAsync(string tmdbId, string accessToken)
    {
        var cacheKey = "tv:" + tmdbId;
        if (TryGetCached(cacheKey, out var cached))
        {
            return cached;
        }

        CalendarEntry? entry = null;
        try
        {
            using var client = CreateClient(accessToken);
            using var response = await client.GetAsync("tv/" + tmdbId).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream).ConfigureAwait(false);
                entry = PickNextEpisode(doc);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Jellio: could not fetch TMDB next episode for series {TmdbId}", tmdbId);
        }

        _cache[cacheKey] = (DateTime.UtcNow, entry);
        return entry;
    }

    private bool TryGetCached(string key, out CalendarEntry? entry)
    {
        if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.CachedAt < CacheTtl)
        {
            entry = hit.Entry;
            return true;
        }

        entry = null;
        return false;
    }

    // release_dates groups by region (iso_3166_1), each with its own list
    // of typed release events: 1 Premiere, 2 Theatrical (limited), 3
    // Theatrical, 4 Digital, 5 Physical, 6 TV, real TMDB enum confirmed
    // against its own real API docs before writing this. Digital is the
    // one real date "when can I actually watch this at home" maps to;
    // US preferred since that region carries the most complete real data
    // on TMDB, any region's own Digital date still beats none at all.
    private static CalendarEntry? PickDigitalRelease(JsonDocument doc)
    {
        if (!doc.RootElement.TryGetProperty("results", out var results))
        {
            return null;
        }

        JsonElement? bestRegion = null;
        foreach (var region in results.EnumerateArray())
        {
            if (region.TryGetProperty("iso_3166_1", out var code) && code.GetString() == "US")
            {
                bestRegion = region;
                break;
            }

            bestRegion ??= region;
        }

        if (bestRegion == null || !bestRegion.Value.TryGetProperty("release_dates", out var dates))
        {
            return null;
        }

        DateTime? nearest = null;
        foreach (var release in dates.EnumerateArray())
        {
            if (!release.TryGetProperty("type", out var typeProp) || typeProp.GetInt32() != 4)
            {
                continue;
            }

            if (!release.TryGetProperty("release_date", out var dateProp))
            {
                continue;
            }

            if (DateTime.TryParse(dateProp.GetString(), out var parsed) && parsed >= DateTime.UtcNow.Date)
            {
                if (nearest == null || parsed < nearest)
                {
                    nearest = parsed;
                }
            }
        }

        return nearest == null ? null : new CalendarEntry(nearest.Value, "digital-release", "Digital release");
    }

    // next_episode_to_air is null once a show has nothing real scheduled
    // yet (between seasons, cancelled, ended), real TMDB field confirmed
    // against its own real /tv/{id} response shape, not guessed at.
    private static CalendarEntry? PickNextEpisode(JsonDocument doc)
    {
        if (!doc.RootElement.TryGetProperty("next_episode_to_air", out var next) || next.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!next.TryGetProperty("air_date", out var dateProp) || !DateTime.TryParse(dateProp.GetString(), out var airDate))
        {
            return null;
        }

        if (airDate < DateTime.UtcNow.Date)
        {
            return null;
        }

        string? detail = null;
        var hasSeason = next.TryGetProperty("season_number", out var seasonProp);
        var hasEpisode = next.TryGetProperty("episode_number", out var episodeProp);
        if (hasSeason && hasEpisode)
        {
            detail = "S" + seasonProp.GetInt32() + "E" + episodeProp.GetInt32();
        }

        return new CalendarEntry(airDate, "episode", detail);
    }
}
