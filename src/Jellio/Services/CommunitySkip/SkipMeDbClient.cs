using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

public class SkipMeDbClient(IHttpClientFactory httpClientFactory, ILogger<SkipMeDbClient> logger)
{
    private const string BaseUrl = "https://db.skipme.workers.dev";

    internal const string RequiredUserAgent = "SkipMe.db/0.0";

    private static readonly JsonSerializerOptions RequestJsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly TimeSpan MinDelayBetweenRequests = TimeSpan.FromMilliseconds(400);
    private static readonly SemaphoreSlim RateLimitLock = new(1, 1);
    private static DateTime _lastRequestUtc = DateTime.MinValue;
    private static DateTime _rateLimitedUntilUtc = DateTime.MinValue;

    public async Task<SkipMeMediaResponse?> GetItemSegmentsAsync(
        int tmdbId,
        int? season,
        int? episode,
        long? durationMs,
        CancellationToken cancellationToken)
    {
        if (DateTime.UtcNow < _rateLimitedUntilUtc)
        {
            logger.LogWarning("Jellio: SkipMe.db rate limit still active until {Until} UTC, skipping", _rateLimitedUntilUtc);
            return null;
        }

        var requestUri = new Uri(BaseUrl + "/movies", UriKind.Absolute);
        var items = new[]
        {
            new SkipMeItemLookupRequest
            {
                TmdbId = tmdbId,
                Season = season,
                Episode = episode,
                DurationMs = durationMs ?? 0,
            },
        };

        try
        {
            await WaitForRateLimitAsync(cancellationToken).ConfigureAwait(false);

            var client = httpClientFactory.CreateClient(nameof(SkipMeDbClient));
            using var response = await client
                .PostAsJsonAsync(requestUri, items, RequestJsonOptions, cancellationToken)
                .ConfigureAwait(false);

            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                var retryAfterSeconds = response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 300;
                _rateLimitedUntilUtc = DateTime.UtcNow.AddSeconds(Math.Clamp(retryAfterSeconds, 1, 24 * 60 * 60));
                logger.LogWarning("Jellio: SkipMe.db rate limited, backing off until {Until} UTC", _rateLimitedUntilUtc);
                return null;
            }

            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: SkipMe.db request failed, {StatusCode} for {Uri}", response.StatusCode, requestUri);
                return null;
            }

            var payload = await response.Content
                .ReadFromJsonAsync<List<SkipMeMediaResponse?>>(cancellationToken)
                .ConfigureAwait(false);
            return payload is { Count: > 0 } ? payload[0] : null;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: SkipMe.db request threw for {Uri}", requestUri);
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

internal class SkipMeItemLookupRequest
{
    [JsonPropertyName("tmdb_id")]
    public int? TmdbId { get; set; }

    [JsonPropertyName("season")]
    public int? Season { get; set; }

    [JsonPropertyName("episode")]
    public int? Episode { get; set; }

    [JsonPropertyName("duration_ms")]
    public long DurationMs { get; set; }
}

public class SkipMeMediaResponse
{
    [JsonPropertyName("intro")]
    public List<SkipMeTimestamp> Intro { get; set; } = [];

    [JsonPropertyName("recap")]
    public List<SkipMeTimestamp> Recap { get; set; } = [];

    [JsonPropertyName("credits")]
    public List<SkipMeTimestamp> Credits { get; set; } = [];

    [JsonPropertyName("preview")]
    public List<SkipMeTimestamp> Preview { get; set; } = [];
}

public class SkipMeTimestamp
{
    [JsonPropertyName("start_ms")]
    public long StartMs { get; set; }

    [JsonPropertyName("end_ms")]
    public long? EndMs { get; set; }
}
