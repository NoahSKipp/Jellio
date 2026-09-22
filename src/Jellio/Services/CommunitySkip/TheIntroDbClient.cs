using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

// C# port of TheIntroDB's own real official Jellyfin plugin
// (github.com/TheIntroDB/jellyfin-plugin, GPL-3.0, the same real
// license this whole plugin already carries, TheIntroDbClient.cs read
// directly before writing this, not guessed at): a genuinely public,
// free, community timestamp database, general TV/movie coverage, not
// anime only the way AniSkip/Anime-Skip below already are. Keyed
// directly off ProviderIds.Tmdb, no Simkl id-resolution round trip
// needed at all, and every Gelato import already carries one
// (PluginConfiguration.cs's own existing TmdbAccessToken comment
// already confirmed this live).
public class TheIntroDbClient(IHttpClientFactory httpClientFactory, ILogger<TheIntroDbClient> logger)
{
    private const string BaseUrl = "https://api.theintrodb.org/v3/media";

    // Same real ceiling their own client enforces (30 requests per 10s,
    // clamped a touch under it here): every single episode/movie this
    // plugin's own player screen opens hits this tier first now, real
    // responsible use of a real shared community service matters more
    // here than it would for a one-off call.
    private static readonly TimeSpan MinDelayBetweenRequests = TimeSpan.FromMilliseconds(400);
    private static readonly SemaphoreSlim RateLimitLock = new(1, 1);
    private static DateTime _lastRequestUtc = DateTime.MinValue;
    private static DateTime _rateLimitedUntilUtc = DateTime.MinValue;

    public async Task<MediaResponse?> GetSegmentsAsync(
        int tmdbId,
        bool isMovie,
        int? season,
        int? episode,
        long? durationMs,
        CancellationToken cancellationToken)
    {
        if (DateTime.UtcNow < _rateLimitedUntilUtc)
        {
            logger.LogWarning("Jellio: TheIntroDB rate limit still active until {Until} UTC, skipping", _rateLimitedUntilUtc);
            return null;
        }

        if (!isMovie && (season is null || episode is null))
        {
            return null;
        }

        var query = "?tmdb_id=" + tmdbId;
        if (!isMovie)
        {
            query += "&season=" + season + "&episode=" + episode;
        }

        if (durationMs is > 0)
        {
            query += "&duration_ms=" + durationMs;
        }

        var requestUri = new Uri(BaseUrl + query, UriKind.Absolute);

        try
        {
            await WaitForRateLimitAsync(cancellationToken).ConfigureAwait(false);

            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, requestUri);
            var apiKey = JellioPlugin.Instance?.Configuration.TheIntroDbApiKey;
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey.Trim());
            }

            request.Headers.TryAddWithoutValidation("Accept", "application/json");

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);

            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                var retryAfterSeconds = response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 300;
                _rateLimitedUntilUtc = DateTime.UtcNow.AddSeconds(Math.Clamp(retryAfterSeconds, 1, 24 * 60 * 60));
                logger.LogWarning("Jellio: TheIntroDB rate limited, backing off until {Until} UTC", _rateLimitedUntilUtc);
                return null;
            }

            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                return null;
            }

            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: TheIntroDB request failed, {StatusCode} for {Uri}", response.StatusCode, requestUri);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            return await JsonSerializer.DeserializeAsync<MediaResponse>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: TheIntroDB request threw for {Uri}", requestUri);
            return null;
        }
    }

    private static async Task WaitForRateLimitAsync(CancellationToken cancellationToken)
    {
        await RateLimitLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var earliestSend = _lastRequestUtc == DateTime.MinValue ? DateTime.UtcNow : _lastRequestUtc + MinDelayBetweenRequests;
            var wait = earliestSend - DateTime.UtcNow;
            if (wait > TimeSpan.Zero)
            {
                await Task.Delay(wait, cancellationToken).ConfigureAwait(false);
            }

            _lastRequestUtc = DateTime.UtcNow;
        }
        finally
        {
            RateLimitLock.Release();
        }
    }
}

// JSON shapes matching TheIntroDB API's own real GET /media response
// exactly (Api/MediaResponse.cs and Api/SegmentTimestamp.cs, read
// directly from their own real source before writing this): intro/
// recap keep start_ms optional (defaults to the real start of the
// episode) but require end_ms; credits/preview require start_ms but
// leave end_ms optional (means "runs to the real end of the media").
public class MediaResponse
{
    [JsonPropertyName("intro")]
    public List<SegmentTimestamp> Intro { get; set; } = [];

    [JsonPropertyName("recap")]
    public List<SegmentTimestamp> Recap { get; set; } = [];

    [JsonPropertyName("credits")]
    public List<SegmentTimestamp> Credits { get; set; } = [];

    [JsonPropertyName("preview")]
    public List<SegmentTimestamp> Preview { get; set; } = [];
}

public class SegmentTimestamp
{
    [JsonPropertyName("start_ms")]
    public long? StartMs { get; set; }

    [JsonPropertyName("end_ms")]
    public long? EndMs { get; set; }
}
