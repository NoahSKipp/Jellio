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

public class TheIntroDbClient(IHttpClientFactory httpClientFactory, ILogger<TheIntroDbClient> logger)
{
    private const string BaseUrl = "https://api.theintrodb.org/v4/media";

    private static readonly TimeSpan MinDelayBetweenRequests = TimeSpan.FromMilliseconds(400);
    private static readonly SemaphoreSlim RateLimitLock = new(1, 1);
    private static DateTime _lastRequestUtc = DateTime.MinValue;
    private static DateTime _rateLimitedUntilUtc = DateTime.MinValue;

    public async Task<MediaResponse?> GetSegmentsAsync(
        TheIntroDbIds ids,
        bool isMovie,
        int? season,
        int? episode,
        string? mapping,
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

        var parameters = new List<string>();
        if (!string.IsNullOrWhiteSpace(ids.TvdbId))
        {
            parameters.Add("tvdb_id=" + Uri.EscapeDataString(ids.TvdbId));
        }

        if (ids.TmdbId is { } tmdbId)
        {
            parameters.Add("tmdb_id=" + tmdbId);
        }

        if (!string.IsNullOrWhiteSpace(ids.ImdbId))
        {
            parameters.Add("imdb_id=" + Uri.EscapeDataString(ids.ImdbId));
        }

        if (parameters.Count == 0)
        {
            return null;
        }

        var query = "?" + string.Join('&', parameters);
        if (!isMovie)
        {
            query += "&season=" + season + "&episode=" + episode;
            if (mapping is not null)
            {
                query += "&mapping=" + mapping;
            }
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
            // TheIntroDB asked clients to identify themselves.
            request.Headers.TryAddWithoutValidation("User-Agent", "Jellio/" + (JellioPlugin.Instance?.Version.ToString(3) ?? "unknown"));

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

    public static string? MappingFor(string? displayOrder)
    {
        return displayOrder?.Trim().ToLowerInvariant() switch
        {
            "aired" or "official" => "official",
            "dvd" or "altdvd" or "alternatedvd" => "dvd",
            "absolute" => "absolute",
            "alternate" or "streaming" => "alternate",
            "regional" or "production" => "regional",
            _ => null,
        };
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

public record TheIntroDbIds(int? TmdbId, string? TvdbId, string? ImdbId)
{
    public bool Any => TmdbId is not null || !string.IsNullOrWhiteSpace(TvdbId) || !string.IsNullOrWhiteSpace(ImdbId);
}

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
