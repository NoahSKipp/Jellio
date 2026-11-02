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

public class TmdbExternalIdResolver(IHttpClientFactory httpClientFactory, ILogger<TmdbExternalIdResolver> logger)
{
    private readonly ConcurrentDictionary<int, string?> _cache = new();

    private bool _warnedMissingToken;

    public async Task<string?> ResolveTvImdbIdAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(tmdbId, out var cached))
        {
            return cached;
        }

        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            if (!_warnedMissingToken)
            {
                _warnedMissingToken = true;
                logger.LogInformation(
                    "Jellio: IntroDB's own Skip Intro/Credits tier needs TmdbAccessToken configured to resolve an IMDb id, none set - that tier stays skipped until it is");
            }

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
                logger.LogWarning("Jellio: TMDB external_ids request failed, {StatusCode} for tmdbId {TmdbId}", response.StatusCode, tmdbId);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var payload = await JsonSerializer.DeserializeAsync<TmdbExternalIdsResponse>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            var imdbId = string.IsNullOrWhiteSpace(payload?.ImdbId) ? null : payload.ImdbId;
            _cache[tmdbId] = imdbId;
            logger.LogInformation("Jellio: TMDB external_ids for tmdbId {TmdbId} resolved to imdbId {ImdbId}", tmdbId, imdbId ?? "(none)");
            return imdbId;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: TMDB external_ids request threw for tmdbId {TmdbId}", tmdbId);
            return null;
        }
    }

    private class TmdbExternalIdsResponse
    {
        [JsonPropertyName("imdb_id")]
        public string? ImdbId { get; set; }
    }
}
