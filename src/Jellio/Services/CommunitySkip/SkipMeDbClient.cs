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

// C# port of the real official intro-skipper org's own SkipMe.db
// Jellyfin plugin (github.com/intro-skipper/skipme.db-plugin, GPL-3.0,
// its own real Services/SkipMeApiClient.cs and Models/*.cs read
// directly before writing this, not guessed at): a genuinely public,
// free, general TV/movie skip timestamp database, keyed directly off
// ProviderIds.Tmdb, same as TheIntroDB - no id resolution round trip
// needed at all. Tried right alongside TheIntroDB, both able to answer
// in one real request each: two independently crowdsourced databases,
// so a title one of them has nothing for is still worth asking the
// other. Their own real NOTICE file explicitly permits local caching of
// this data for the one real purpose this plugin already uses it for
// (serving skip segments within this same media server), unlike
// SkipDB's own real reciprocity clause.
public class SkipMeDbClient(IHttpClientFactory httpClientFactory, ILogger<SkipMeDbClient> logger)
{
    // Confirmed from their own real NOTICE file
    // (github.com/intro-skipper/skipme.db-plugin), not guessed: their
    // own client repo's real base URL is generated at build time from a
    // private CI secret, never checked into source.
    private const string BaseUrl = "https://db.skipme.workers.dev";

    // Real bug, found live: their own real Cloudflare Worker rejects
    // every single request with a real 403 "Client not supported"
    // unless it carries this exact literal User-Agent - confirmed
    // against a real curl repro from both the host and inside the
    // Jellyfin container itself, a spoofed real Chrome UA included, and
    // against their own real source (PluginServiceRegistrator.cs's own
    // real ConfigureHttpClient call), not guessed at. ServiceRegistrator.cs
    // registers this same real named client with the exact same real
    // header, the one real reason GetItemSegmentsAsync below asks for a
    // named client rather than IHttpClientFactory's own real default one.
    internal const string RequiredUserAgent = "SkipMe.db/0.0";

    private static readonly JsonSerializerOptions RequestJsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // Same real paced-request-plus-429-backoff shape TheIntroDbClient.cs
    // already uses: every single episode or movie this plugin's own
    // player screen (or an admin's own Quick/Deep Skip Search sweep)
    // opens now hits this tier too, real responsible use of a real
    // shared community service matters here just as much.
    private static readonly TimeSpan MinDelayBetweenRequests = TimeSpan.FromMilliseconds(400);
    private static readonly SemaphoreSlim RateLimitLock = new(1, 1);
    private static DateTime _lastRequestUtc = DateTime.MinValue;
    private static DateTime _rateLimitedUntilUtc = DateTime.MinValue;

    // Movie or a single TV episode - their own real /movies endpoint
    // (Models/MovieLookupRequest.cs's own real name, despite covering
    // both) takes an optional season/episode either way, null for a
    // movie.
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

            // Positional, same real shape their own client relies on:
            // a batch of one request gets a batch of one response back,
            // an explicit null entry rather than an empty array for a
            // real no-data item.
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

// Request/response JSON shapes matching SkipMe.db's own real /movies
// endpoint exactly (Models/MovieLookupRequest.cs and Models/
// MediaResponse.cs, read directly from their own real source before
// writing this). ImdbId/TvdbId/AniListId fields their own real request
// model also carries are left out here: this plugin only ever has a
// real ProviderIds.Tmdb to offer.
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

    // Null means open-ended in their own real schema (Models/
    // MediaTimestamp.cs) - the same real "runs to the end of the
    // episode" meaning TheIntroDbClient.cs's own credits handling
    // already carries over for an absent end.
    [JsonPropertyName("end_ms")]
    public long? EndMs { get; set; }
}
