using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
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
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public record CalendarEntry(DateTime Date, string Kind, string? Detail);

public record WatchlistCalendarItem(Guid ItemId, string Name, string Type, DateTime Date, string Kind, string? Detail);

public class CalendarService(
    IHttpClientFactory httpClientFactory,
    ILibraryManager libraryManager,
    IUserDataManager userDataManager,
    UpcomingHiddenStore upcomingHidden,
    ILogger<CalendarService> logger
)
{
    private const string BaseUrl = "https://api.themoviedb.org/3";
    private const int MaxCacheEntries = 5000;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly ConcurrentDictionary<string, (DateTime CachedAt, CalendarEntry? Entry)> _cache = new();
    private readonly ConcurrentDictionary<string, (DateTime CachedAt, IReadOnlyList<CalendarEntry> Entries)> _seriesScheduleCache = new();

    public static readonly TimeSpan SeriesWindow = TimeSpan.FromDays(3 * 365);
    public static readonly TimeSpan AnimeSeriesWindow = TimeSpan.FromDays(5 * 365);

    private static readonly TimeSpan MonitoredCacheTtl = TimeSpan.FromMinutes(30);
    private readonly ConcurrentDictionary<Guid, (DateTime At, IReadOnlyList<BaseItem> Items)> _monitoredCache = new();

    public static bool ShouldMonitorSeries(SeriesStatus? status, DateTime? lastWatched, bool isAnime, DateTime now)
    {
        if (status == SeriesStatus.Ended)
        {
            return false;
        }

        if (!lastWatched.HasValue)
        {
            return true;
        }

        return now - lastWatched.Value <= (isAnime ? AnimeSeriesWindow : SeriesWindow);
    }

    public void ForgetMonitored(Guid userId) => _monitoredCache.TryRemove(userId, out _);

    public IReadOnlyList<BaseItem> GetMonitoredItems(User user)
    {
        if (_monitoredCache.TryGetValue(user.Id, out var hit) && DateTime.UtcNow - hit.At < MonitoredCacheTtl)
        {
            return hit.Items;
        }

        var monitored = new Dictionary<Guid, BaseItem>();

        var watchlist = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IsFavorite = true,
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
        });

        foreach (var item in watchlist)
        {
            monitored[item.Id] = item;
        }

        var lastWatched = LastWatchedBySeries(user);
        var anime = AnimeCatalog.GetIds(libraryManager);
        var now = DateTime.UtcNow;
        foreach (var (seriesId, watchedAt) in lastWatched)
        {
            if (monitored.ContainsKey(seriesId) || libraryManager.GetItemById(seriesId) is not Series series)
            {
                continue;
            }

            if (ShouldMonitorSeries(series.Status, watchedAt, anime.Contains(series.Id), now))
            {
                monitored[series.Id] = series;
            }
        }

        // Taken out of Upcoming by the user: no row entry, no notification.
        var hidden = upcomingHidden.Load(user.Id);
        var result = monitored.Values.Where(item => !hidden.Contains(item.Id)).ToList();
        if (_monitoredCache.Count >= MaxCacheEntries)
        {
            _monitoredCache.Clear();
        }

        _monitoredCache[user.Id] = (DateTime.UtcNow, result);
        logger.LogInformation(
            "Jellio: calendar watches {Count} titles for {User} ({Watched} watched series)",
            result.Count,
            user.Username,
            lastWatched.Count);
        return result;
    }

    // Series id to the newest LastPlayedDate among its played or paused
    // episodes (null when an episode was played without a date).
    private Dictionary<Guid, DateTime?> LastWatchedBySeries(User user)
    {
        var result = new Dictionary<Guid, DateTime?>();
        var played = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Episode],
            IsPlayed = true,
            Recursive = true,
        });
        var paused = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Episode],
            IsResumable = true,
            Recursive = true,
        });

        foreach (var episode in played.Concat(paused).OfType<Episode>())
        {
            var seriesId = episode.SeriesId;
            if (seriesId == Guid.Empty)
            {
                continue;
            }

            var date = userDataManager.GetUserData(user, episode)?.LastPlayedDate;
            if (!result.TryGetValue(seriesId, out var known))
            {
                result[seriesId] = date;
            }
            else if (known.HasValue && (!date.HasValue || date.Value > known.Value))
            {
                result[seriesId] = date;
            }
        }

        return result;
    }

    public async Task<List<WatchlistCalendarItem>> GetWatchlistCalendarAsync(
        IReadOnlyList<BaseItem> watchlist,
        string accessToken,
        User? user = null
    )
    {
        using var throttle = new SemaphoreSlim(8);
        var entryTasks = watchlist
            .Select(async item =>
            {
                if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) || string.IsNullOrEmpty(tmdbId))
                {
                    return null;
                }

                await throttle.WaitAsync().ConfigureAwait(false);
                try
                {
                    var playedEpisodes = GetPlayedEpisodes(user, item);
                    var entry = item is Movie
                        ? await GetMovieEntryAsync(tmdbId, accessToken).ConfigureAwait(false)
                        : item is Series
                            ? await GetSeriesEntryAsync(tmdbId, accessToken, playedEpisodes).ConfigureAwait(false)
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

    private HashSet<(int Season, int Episode)>? GetPlayedEpisodes(User? user, BaseItem item)
    {
        if (user == null || item is not Series series)
        {
            return null;
        }

        try
        {
            var played = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                AncestorIds = [series.Id],
                IncludeItemTypes = [BaseItemKind.Episode],
                IsPlayed = true,
            });

            var set = new HashSet<(int Season, int Episode)>();
            foreach (var ep in played.OfType<Episode>())
            {
                if (ep.ParentIndexNumber.HasValue && ep.IndexNumber.HasValue)
                {
                    set.Add((ep.ParentIndexNumber.Value, ep.IndexNumber.Value));
                }
            }

            return set;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not query played episodes for series {SeriesId}", series.Id);
            return null;
        }
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

        if (_cache.Count >= MaxCacheEntries)
        {
            _cache.Clear();
        }

        _cache[cacheKey] = (DateTime.UtcNow, entry);
        return entry;
    }

    public void ForgetCachedSeries(string tmdbId)
    {
        _cache.TryRemove("tv:" + tmdbId, out _);
        _seriesScheduleCache.TryRemove("tv:" + tmdbId, out _);
    }

    public async Task<CalendarEntry?> GetSeriesEntryAsync(
        string tmdbId,
        string accessToken,
        ISet<(int Season, int Episode)>? playedEpisodes = null,
        DateTime? nowUtc = null)
    {
        var today = (nowUtc ?? DateTime.UtcNow).Date;
        var cacheKey = "tv:" + tmdbId;
        if (TryGetCachedSeriesSchedule(cacheKey, today, out var cachedSchedule))
        {
            return PickFirstUnplayed(cachedSchedule, today, playedEpisodes);
        }

        var schedule = new List<CalendarEntry>();
        try
        {
            using var client = CreateClient(accessToken);
            using var response = await client.GetAsync("tv/" + tmdbId).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream).ConfigureAwait(false);
                var nextEp = PickNextEpisode(doc, nowUtc);
                if (nextEp != null)
                {
                    schedule.Add(nextEp);
                }

                var seasonNumber = PickSeasonNumberToSearch(doc);
                if (seasonNumber.HasValue)
                {
                    using var seasonResp = await client.GetAsync("tv/" + tmdbId + "/season/" + seasonNumber.Value).ConfigureAwait(false);
                    if (seasonResp.IsSuccessStatusCode)
                    {
                        using var seasonStream = await seasonResp.Content.ReadAsStreamAsync().ConfigureAwait(false);
                        using var seasonDoc = await JsonDocument.ParseAsync(seasonStream).ConfigureAwait(false);
                        foreach (var ep in PickUpcomingEpisodesFromSeason(seasonDoc, nowUtc))
                        {
                            if (!schedule.Any(existing => existing.Detail == ep.Detail && existing.Date == ep.Date))
                            {
                                schedule.Add(ep);
                            }
                        }
                    }
                }

                schedule.Sort((a, b) => a.Date.CompareTo(b.Date));
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Jellio: could not fetch TMDB next episode for series {TmdbId}", tmdbId);
        }

        if (_seriesScheduleCache.Count >= MaxCacheEntries)
        {
            _seriesScheduleCache.Clear();
        }

        _seriesScheduleCache[cacheKey] = (DateTime.UtcNow, schedule);
        return PickFirstUnplayed(schedule, today, playedEpisodes);
    }

    private bool TryGetCachedSeriesSchedule(string key, DateTime today, out IReadOnlyList<CalendarEntry> entries)
    {
        if (_seriesScheduleCache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.CachedAt < CacheTtl)
        {
            if (hit.Entries.Count == 0 || hit.Entries.Any(e => e.Date >= today))
            {
                entries = hit.Entries;
                return true;
            }
        }

        entries = Array.Empty<CalendarEntry>();
        return false;
    }

    private static CalendarEntry? PickFirstUnplayed(
        IReadOnlyList<CalendarEntry> schedule,
        DateTime today,
        ISet<(int Season, int Episode)>? playedEpisodes)
    {
        foreach (var entry in schedule)
        {
            if (entry.Date < today)
            {
                continue;
            }

            var (s, e) = ParseSeasonEpisode(entry.Detail);
            if (s.HasValue && e.HasValue && playedEpisodes != null && playedEpisodes.Contains((s.Value, e.Value)))
            {
                continue;
            }

            return entry;
        }

        return null;
    }

    private bool TryGetCached(string key, out CalendarEntry? entry)
    {
        if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.CachedAt < CacheTtl)
        {
            if (hit.Entry == null || hit.Entry.Date >= DateTime.UtcNow.Date)
            {
                entry = hit.Entry;
                return true;
            }
        }

        entry = null;
        return false;
    }

    internal static (int? Season, int? Episode) ParseSeasonEpisode(string? detail)
    {
        if (string.IsNullOrEmpty(detail) || !detail.StartsWith('S'))
        {
            return (null, null);
        }

        var eIndex = detail.IndexOf('E', StringComparison.OrdinalIgnoreCase);
        if (eIndex <= 1)
        {
            return (null, null);
        }

        var sPart = detail.Substring(1, eIndex - 1);
        var ePart = detail.Substring(eIndex + 1);
        if (int.TryParse(sPart, NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) &&
            int.TryParse(ePart, NumberStyles.Integer, CultureInfo.InvariantCulture, out var e))
        {
            return (s, e);
        }

        return (null, null);
    }

    internal static int? PickSeasonNumberToSearch(JsonDocument seriesDoc)
    {
        if (seriesDoc == null || seriesDoc.RootElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (seriesDoc.RootElement.TryGetProperty("next_episode_to_air", out var next) &&
            next.ValueKind == JsonValueKind.Object &&
            next.TryGetProperty("season_number", out var nextSeason) &&
            nextSeason.TryGetInt32(out var ns) && ns > 0)
        {
            return ns;
        }

        if (seriesDoc.RootElement.TryGetProperty("last_episode_to_air", out var last) &&
            last.ValueKind == JsonValueKind.Object &&
            last.TryGetProperty("season_number", out var lastSeason) &&
            lastSeason.TryGetInt32(out var ls) && ls > 0)
        {
            return ls;
        }

        if (seriesDoc.RootElement.TryGetProperty("seasons", out var seasons) &&
            seasons.ValueKind == JsonValueKind.Array)
        {
            int? maxSeason = null;
            foreach (var season in seasons.EnumerateArray())
            {
                if (season.ValueKind == JsonValueKind.Object &&
                    season.TryGetProperty("season_number", out var sProp) &&
                    sProp.TryGetInt32(out var s) && s > 0)
                {
                    if (maxSeason == null || s > maxSeason.Value)
                    {
                        maxSeason = s;
                    }
                }
            }

            return maxSeason;
        }

        return null;
    }

    internal static List<CalendarEntry> PickUpcomingEpisodesFromSeason(
        JsonDocument seasonDoc,
        DateTime? nowUtc = null)
    {
        var results = new List<CalendarEntry>();
        if (seasonDoc == null || seasonDoc.RootElement.ValueKind != JsonValueKind.Object)
        {
            return results;
        }

        if (!seasonDoc.RootElement.TryGetProperty("episodes", out var episodes) ||
            episodes.ValueKind != JsonValueKind.Array)
        {
            return results;
        }

        var today = (nowUtc ?? DateTime.UtcNow).Date;
        foreach (var ep in episodes.EnumerateArray())
        {
            if (ep.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (!ep.TryGetProperty("air_date", out var dateProp) ||
                dateProp.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var dateStr = dateProp.GetString();
            if (string.IsNullOrEmpty(dateStr) ||
                !DateTime.TryParse(dateStr, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var airDate))
            {
                continue;
            }

            if (airDate.Date < today)
            {
                continue;
            }

            int? seasonNumber = ep.TryGetProperty("season_number", out var sProp) && sProp.TryGetInt32(out var s) ? s : null;
            int? episodeNumber = ep.TryGetProperty("episode_number", out var eProp) && eProp.TryGetInt32(out var e) ? e : null;

            string? detail = null;
            if (seasonNumber.HasValue && episodeNumber.HasValue)
            {
                detail = "S" + seasonNumber.Value + "E" + episodeNumber.Value;
            }

            results.Add(new CalendarEntry(airDate.Date, "episode", detail));
        }

        return results;
    }

    internal static CalendarEntry? PickNextEpisodeFromSeason(
        JsonDocument seasonDoc,
        DateTime? nowUtc = null,
        ISet<(int Season, int Episode)>? playedEpisodes = null)
    {
        var today = (nowUtc ?? DateTime.UtcNow).Date;
        var upcoming = PickUpcomingEpisodesFromSeason(seasonDoc, nowUtc);
        return PickFirstUnplayed(upcoming, today, playedEpisodes);
    }

    internal static CalendarEntry? PickNextEpisode(
        JsonDocument doc,
        DateTime? nowUtc = null,
        ISet<(int Season, int Episode)>? playedEpisodes = null)
    {
        if (doc == null || doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!doc.RootElement.TryGetProperty("next_episode_to_air", out var next) || next.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!next.TryGetProperty("air_date", out var dateProp) ||
            !DateTime.TryParse(dateProp.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var airDate))
        {
            return null;
        }

        var today = (nowUtc ?? DateTime.UtcNow).Date;
        if (airDate.Date < today)
        {
            return null;
        }

        int? seasonNumber = next.TryGetProperty("season_number", out var seasonProp) && seasonProp.TryGetInt32(out var s) ? s : null;
        int? episodeNumber = next.TryGetProperty("episode_number", out var episodeProp) && episodeProp.TryGetInt32(out var e) ? e : null;

        if (seasonNumber.HasValue && episodeNumber.HasValue &&
            playedEpisodes != null && playedEpisodes.Contains((seasonNumber.Value, episodeNumber.Value)))
        {
            return null;
        }

        string? detail = null;
        if (seasonNumber.HasValue && episodeNumber.HasValue)
        {
            detail = "S" + seasonNumber.Value + "E" + episodeNumber.Value;
        }

        return new CalendarEntry(airDate.Date, "episode", detail);
    }

    internal static CalendarEntry? PickDigitalRelease(JsonDocument doc, DateTime? nowUtc = null)
    {
        if (doc == null || doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        JsonElement? bestRegion = null;
        foreach (var region in results.EnumerateArray())
        {
            if (region.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (region.TryGetProperty("iso_3166_1", out var code) &&
                code.ValueKind == JsonValueKind.String &&
                code.GetString() == "US")
            {
                bestRegion = region;
                break;
            }

            bestRegion ??= region;
        }

        if (bestRegion == null ||
            !bestRegion.Value.TryGetProperty("release_dates", out var dates) ||
            dates.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var today = (nowUtc ?? DateTime.UtcNow).Date;
        DateTime? earliestFuture = null;

        foreach (var release in dates.EnumerateArray())
        {
            if (release.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (!release.TryGetProperty("type", out var typeProp) ||
                typeProp.ValueKind != JsonValueKind.Number ||
                !typeProp.TryGetInt32(out var releaseType) ||
                releaseType is not (4 or 5))
            {
                continue;
            }

            if (!release.TryGetProperty("release_date", out var dateProp) ||
                dateProp.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var dateStr = dateProp.GetString();
            if (string.IsNullOrEmpty(dateStr) ||
                !DateTime.TryParse(dateStr, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var parsed))
            {
                continue;
            }

            if (parsed.Date < today)
            {
                return null;
            }

            if (releaseType == 4 && (earliestFuture == null || parsed.Date < earliestFuture))
            {
                earliestFuture = parsed.Date;
            }
        }

        return earliestFuture == null
            ? null
            : new CalendarEntry(earliestFuture.Value, "digital-release", "Digital release");
    }
}
