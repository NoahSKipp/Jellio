using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

public record MangaSeries(
    int Id,
    string Title,
    string? AltTitle,
    string? Author,
    int? Year,
    string? CoverUrl,
    string? Country,
    int? Volumes,
    string? Status,
    IReadOnlyList<string> Genres);

/// <summary>
/// Manga discovery for the Manga shelf, from AniList's free, keyless
/// GraphQL API: trending and popular manga, manhwa and manhua (by country
/// of origin), by genre, and title search. Results are cached; AniList
/// allows 90 requests a minute. Only series, never light novels or
/// one-shots, so the shelf's Discover shows comics only.
/// </summary>
public class AniListClient(IHttpClientFactory httpClientFactory, ILogger<AniListClient> logger)
{
    public const int PageSize = 36;
    private const int MaxCacheEntries = 400;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private const string Query = @"query ($page: Int, $perPage: Int, $sort: [MediaSort], $genre: String, $country: CountryCode, $search: String) {
  Page(page: $page, perPage: $perPage) {
    media(type: MANGA, format_in: [MANGA], isAdult: false, sort: $sort, genre: $genre, countryOfOrigin: $country, search: $search) {
      id
      title { english romaji userPreferred }
      coverImage { large }
      startDate { year }
      countryOfOrigin
      volumes
      status
      genres
      staff(perPage: 2, sort: RELEVANCE) { edges { role node { name { full } } } }
    }
  }
}";

    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<MangaSeries> Series)> _cache = new(StringComparer.Ordinal);

    // sort: TRENDING_DESC, POPULARITY_DESC or SCORE_DESC; country: JP
    // (manga), KR (manhwa), CN (manhua) or null for all.
    public async Task<IReadOnlyList<MangaSeries>?> BrowseAsync(string sort, string? genre, string? country, string? search, int page, CancellationToken cancellationToken)
    {
        var variables = new JsonObject
        {
            ["page"] = page + 1,
            ["perPage"] = PageSize,
            ["sort"] = new JsonArray(search is null ? sort : "SEARCH_MATCH"),
        };
        if (genre is not null)
        {
            variables["genre"] = genre;
        }

        if (country is not null)
        {
            variables["country"] = country;
        }

        if (search is not null)
        {
            variables["search"] = search;
        }

        var key = variables.ToJsonString();
        if (_cache.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.At < CacheTtl)
        {
            return cached.Series;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(AniListClient));
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://graphql.anilist.co");
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Content = new StringContent(
                new JsonObject { ["query"] = Query, ["variables"] = variables }.ToJsonString(),
                Encoding.UTF8,
                "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: AniList browse failed, {StatusCode}", response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var media = JsonNode.Parse(body)?["data"]?["Page"]?["media"] as JsonArray;
            var series = media?.OfType<JsonObject>().Select(ToSeries).OfType<MangaSeries>().ToList() ?? [];

            if (_cache.Count >= MaxCacheEntries)
            {
                _cache.Clear();
            }

            _cache[key] = (DateTime.UtcNow, series);
            return series;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: AniList browse threw");
            return null;
        }
    }

    /// <summary>
    /// A cover from AniList's image CDN, fetched by the server so covers
    /// show even when the reader's browser can't reach AniList (ad or DNS
    /// blockers, some networks). Only AniList's own CDN host is fetched.
    /// </summary>
    public async Task<(byte[] Bytes, string ContentType)?> GetCoverAsync(string url, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(uri.Host, "s4.anilist.co", StringComparison.OrdinalIgnoreCase)
            || !uri.AbsolutePath.StartsWith("/file/anilistcdn/", StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(AniListClient));
            using var response = await client.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType;
            if (!response.IsSuccessStatusCode || contentType is null || !contentType.StartsWith("image/", StringComparison.Ordinal))
            {
                logger.LogDebug("Jellio: AniList cover {Url} failed, {StatusCode}", url, response.StatusCode);
                return null;
            }

            return (await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false), contentType);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: AniList cover {Url} threw", url);
            return null;
        }
    }

    private static MangaSeries? ToSeries(JsonObject media)
    {
        if (media["id"] is not JsonValue idValue || !idValue.TryGetValue<int>(out var id))
        {
            return null;
        }

        var english = ChaptarrClient.ReadString(media["title"]?["english"]);
        var romaji = ChaptarrClient.ReadString(media["title"]?["romaji"]);
        var title = english ?? romaji ?? ChaptarrClient.ReadString(media["title"]?["userPreferred"]);
        if (title is null)
        {
            return null;
        }

        // The story/art credit, not translators or editors.
        var author = (media["staff"]?["edges"] as JsonArray)?
            .OfType<JsonObject>()
            .Where(edge => (ChaptarrClient.ReadString(edge["role"]) ?? string.Empty).Contains("Story", StringComparison.OrdinalIgnoreCase)
                || (ChaptarrClient.ReadString(edge["role"]) ?? string.Empty).Contains("Art", StringComparison.OrdinalIgnoreCase))
            .Select(edge => ChaptarrClient.ReadString(edge["node"]?["name"]?["full"]))
            .FirstOrDefault(name => name is not null);

        var genres = (media["genres"] as JsonArray)?.Select(ChaptarrClient.ReadString).OfType<string>().ToList() ?? [];
        return new MangaSeries(
            id,
            title,
            english is not null && romaji is not null && !string.Equals(english, romaji, StringComparison.OrdinalIgnoreCase) ? romaji : null,
            author,
            ReadInt(media["startDate"]?["year"]),
            ChaptarrClient.ReadString(media["coverImage"]?["large"]),
            ChaptarrClient.ReadString(media["countryOfOrigin"]),
            ReadInt(media["volumes"]),
            ChaptarrClient.ReadString(media["status"]),
            genres);
    }

    private static int? ReadInt(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<int>(out var number) ? number : null;
}
