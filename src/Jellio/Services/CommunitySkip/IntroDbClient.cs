using System;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

public class IntroDbClient(IHttpClientFactory httpClientFactory, ILogger<IntroDbClient> logger)
{
    private const string BaseUrl = "https://api.introdb.app/segments";

    private static readonly TimeSpan MinDelayBetweenRequests = TimeSpan.FromMilliseconds(400);
    private static readonly SemaphoreSlim RateLimitLock = new(1, 1);
    private static DateTime _lastRequestUtc = DateTime.MinValue;
    private static DateTime _rateLimitedUntilUtc = DateTime.MinValue;

    public async Task<IntroDbMediaResponse?> GetSegmentsAsync(string imdbId, int season, int episode, CancellationToken cancellationToken)
    {
        if (DateTime.UtcNow < _rateLimitedUntilUtc)
        {
            logger.LogWarning("Jellio: IntroDB rate limit still active until {Until} UTC, skipping", _rateLimitedUntilUtc);
            return null;
        }

        var requestUri = new Uri(BaseUrl + "?imdb_id=" + imdbId + "&season=" + season + "&episode=" + episode, UriKind.Absolute);

        try
        {
            await WaitForRateLimitAsync(cancellationToken).ConfigureAwait(false);

            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, requestUri);
            var apiKey = JellioPlugin.Instance?.Configuration.IntroDbApiKey;
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                request.Headers.TryAddWithoutValidation("X-API-Key", apiKey.Trim());
            }

            request.Headers.TryAddWithoutValidation("Accept", "application/json");

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);

            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                var retryAfterSeconds = response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 300;
                _rateLimitedUntilUtc = DateTime.UtcNow.AddSeconds(Math.Clamp(retryAfterSeconds, 1, 24 * 60 * 60));
                logger.LogWarning("Jellio: IntroDB rate limited, backing off until {Until} UTC", _rateLimitedUntilUtc);
                return null;
            }

            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                logger.LogInformation("Jellio: IntroDB has no data for {Uri}", requestUri);
                return null;
            }

            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: IntroDB request failed, {StatusCode} for {Uri}", response.StatusCode, requestUri);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            return await JsonSerializer.DeserializeAsync<IntroDbMediaResponse>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: IntroDB request threw for {Uri}", requestUri);
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

public class IntroDbMediaResponse
{
    [JsonPropertyName("intro")]
    public IntroDbSegment? Intro { get; set; }

    [JsonPropertyName("recap")]
    public IntroDbSegment? Recap { get; set; }

    [JsonPropertyName("outro")]
    public IntroDbSegment? Outro { get; set; }
}

public class IntroDbSegment
{
    [JsonPropertyName("start_ms")]
    public long StartMs { get; set; }

    [JsonPropertyName("end_ms")]
    public long EndMs { get; set; }
}
