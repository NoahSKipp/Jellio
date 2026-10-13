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
using MediaBrowser.Model.Entities;
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

    // How long after the last watched episode a show that is still airing
    // (or has no status) keeps being checked for a next season. Gaps of two
    // to three years are common for TV (Severance, Stranger Things, The
    // Boys); anime sequels often take longer still (Jujutsu Kaisen, Frieren,
    // Vinland Saga), so anime gets five. A title only reaches the calendar
    // once TMDB has an announced air date, so a long window costs a few
    // cached lookups, not noise.
    public static readonly TimeSpan SeriesWindow = TimeSpan.FromDays(3 * 365);
    public static readonly TimeSpan AnimeSeriesWindow = TimeSpan.FromDays(5 * 365);

    private static readonly TimeSpan MonitoredCacheTtl = TimeSpan.FromMinutes(30);
    private readonly ConcurrentDictionary<Guid, (DateTime At, IReadOnlyList<BaseItem> Items)> _monitoredCache = new();

    /// <summary>
    /// Whether a series the user has watched some of is checked for new
    /// episodes. lastWatched is the newest episode the user played or
    /// paused; null (played without a date) counts as recent.
    /// </summary>
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

    /// <summary>
    /// Every title checked for upcoming releases or air dates: the user's
    /// Watchlist (IsFavorite), plus every series they have watched an
    /// episode of that ShouldMonitorSeries keeps. Jellyfin records plays on
    /// episodes, not on the series, so the last watched date comes from the
    /// user's episode history.
    /// </summary>
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

        var result = monitored.Values.ToList();
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
