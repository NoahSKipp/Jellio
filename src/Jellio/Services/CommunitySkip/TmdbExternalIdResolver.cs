using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

// The one real extra round trip IntroDbClient's own IMDb-keyed API
// needs that TheIntroDB/SkipMe.db do not: PluginConfiguration.cs's own
// existing TmdbAccessToken (already required for Controllers/
// CalendarController.cs's own real TMDB calls) resolves a series' own
// real TMDB id to the IMDb id IntroDB actually keys off, TMDB's own
// real documented GET /tv/{id}/external_ids. Cached per series for the
// life of this plugin instance rather than resolved again every single
// episode - a title's own real IMDb id never changes.
public class TmdbExternalIdResolver(IHttpClientFactory httpClientFactory, ILogger<TmdbExternalIdResolver> logger)
{
    private readonly ConcurrentDictionary<int, string?> _cache = new();

    public async Task<string?> ResolveTvImdbIdAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(tmdbId, out var cached))
        {
            return cached;
        }

        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return null;
        }

        var requestUri = new Uri("https://api.themoviedb.org/3/tv/" + tmdbId + "/external_ids", UriKind.Absolute);

        try
        {
            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, requestUri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken.Trim());
            request.Headers.TryAddWithoutValidation("Accept", "application/json");

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                // Not cached: a transient TMDB failure should not
                // permanently stick this series with "no IMDb id"
                // forever, only a real successful lookup (even one that
                // genuinely comes back without an imdb_id) is worth
                // remembering below.
                logger.LogDebug("Jellio: TMDB external_ids request failed, {StatusCode} for tmdbId {TmdbId}", response.StatusCode, tmdbId);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var payload = await JsonSerializer.DeserializeAsync<TmdbExternalIdsResponse>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            var imdbId = string.IsNullOrWhiteSpace(payload?.ImdbId) ? null : payload.ImdbId;
            _cache[tmdbId] = imdbId;
            return imdbId;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: TMDB external_ids request threw for tmdbId {TmdbId}", tmdbId);
            return null;
        }
    }

    private class TmdbExternalIdsResponse
    {
        [JsonPropertyName("imdb_id")]
        public string? ImdbId { get; set; }
    }
}
