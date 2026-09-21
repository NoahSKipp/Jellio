using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

public record SimklResolvedIds(long SimklId, string Type, string? Mal, string? Anilist, string? Kitsu, string? Imdb);

// C# port of NuvioTV's own real SimklIdResolver.kt, checked against its
// real source before writing this, not guessed at: Simkl's own real
// public /redirect endpoint maps any one of a real handful of provider
// ids (imdb, tmdb, tvdb, mal, anilist, ...) onto Simkl's own internal
// real id and content type via a real 302's own Location header, then a
// second real GET against that id returns every other real provider id
// Simkl itself already knows about for the same real title.
// PluginConfiguration.cs's own TmdbAccessToken comment already confirmed
// every Gelato import carries a real ProviderIds.Tmdb, never a real
// ProviderIds.Imdb, so CommunitySkipProvider below resolves from "tmdb"
// rather than NuvioTV's own real "imdb" starting point - this resolver
// itself stays source-agnostic, same as NuvioTV's own real version.
public class SimklIdResolver(IHttpClientFactory httpClientFactory, ILogger<SimklIdResolver> logger)
{
    private const string BaseUrl = "https://api.simkl.com";
    private readonly ConcurrentDictionary<string, SimklResolvedIds?> _cache = new();

    public async Task<SimklResolvedIds?> ResolveIdsAsync(string source, string id, string clientId, CancellationToken cancellationToken)
    {
        var cacheKey = source + ":" + id;
        if (_cache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        var resolved = await ResolveUncachedAsync(source, id, clientId, cancellationToken).ConfigureAwait(false);
        _cache[cacheKey] = resolved;
        return resolved;
    }

    private async Task<SimklResolvedIds?> ResolveUncachedAsync(string source, string id, string clientId, CancellationToken cancellationToken)
    {
        try
        {
            // A real named client (registered in ServiceRegistrator.cs
            // with AllowAutoRedirect: false) rather than the default
            // one: the real answer here IS the 302 itself, following it
            // would just discard the one real Location header this
            // whole method needs.
            var redirectClient = httpClientFactory.CreateClient("SimklRedirect");
            var redirectUrl = $"{BaseUrl}/redirect?to=simkl&{source}={Uri.EscapeDataString(id)}&client_id={clientId}";
            using var redirectResponse = await redirectClient.GetAsync(redirectUrl, cancellationToken).ConfigureAwait(false);
            var location = redirectResponse.Headers.Location;
            if (location is null)
            {
                return null;
            }

            var segments = location.IsAbsoluteUri
                ? location.AbsolutePath.Trim('/').Split('/')
                : location.OriginalString.Trim('/').Split('/');
            var typeIndex = Array.FindLastIndex(segments, segment => segment is "anime" or "tv" or "movies");
            if (typeIndex < 0 || typeIndex + 1 >= segments.Length || !long.TryParse(segments[typeIndex + 1], out var simklId))
            {
                return null;
            }

            var type = segments[typeIndex];
            var detailsClient = httpClientFactory.CreateClient();
            var detailsUrl = $"{BaseUrl}/{type}/{simklId}?extended=full&client_id={clientId}";
            using var detailsResponse = await detailsClient.GetAsync(detailsUrl, cancellationToken).ConfigureAwait(false);
            if (!detailsResponse.IsSuccessStatusCode)
            {
                return null;
            }

            var stream = await detailsResponse.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!document.RootElement.TryGetProperty("ids", out var idsElement))
            {
                return new SimklResolvedIds(simklId, type, null, null, null, null);
            }

            return new SimklResolvedIds(
                simklId,
                type,
                ReadStringOrNull(idsElement, "mal"),
                ReadStringOrNull(idsElement, "anilist"),
                ReadStringOrNull(idsElement, "kitsu"),
                ReadStringOrNull(idsElement, "imdb"));
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: Simkl id resolution failed for {Source}:{Id}", source, id);
            return null;
        }
    }

    private static string? ReadStringOrNull(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var text = value.GetString();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }
}
