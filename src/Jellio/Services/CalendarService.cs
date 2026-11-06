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
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly ConcurrentDictionary<string, (DateTime CachedAt, CalendarEntry? Entry)> _cache = new();

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
        string accessToken
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
                releaseType != 4)
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

            if (earliestFuture == null || parsed < earliestFuture)
            {
                earliestFuture = parsed;
            }
        }

        return earliestFuture == null
            ? null
            : new CalendarEntry(earliestFuture.Value, "digital-release", "Digital release");
    }

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
