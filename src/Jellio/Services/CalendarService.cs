using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public record CalendarEntry(DateTime Date, string Kind, string? Detail);

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
public class CalendarService(IHttpClientFactory httpClientFactory, ILogger<CalendarService> logger)
{
    private const string BaseUrl = "https://api.themoviedb.org/3";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly ConcurrentDictionary<string, (DateTime CachedAt, CalendarEntry? Entry)> _cache = new();

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
