using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Chaptarr;

// Chaptarr (github.com/Chaptarr/chaptarr, the Readarr successor): routes,
// params and JSON shapes read from its own src/Chaptarr.Api.V1 source.
// Standard *arr auth (X-Api-Key), camelCase JSON. Book resources are kept
// as raw JsonObjects rather than typed DTOs: the add call has to send a
// lookup result back essentially as Chaptarr returned it, and a DTO would
// silently drop every field it didn't know about.
public class ChaptarrClient(IHttpClientFactory httpClientFactory, ILogger<ChaptarrClient> logger)
{
    public record AddResult(bool Success, bool Pending, string? Message);

    // Covers are small; anything past this is not a cover worth proxying.
    private const long MaxImageBytes = 15 * 1024 * 1024;

    public static bool IsConfigured => TryGetConfig(out _, out _);

    private static bool TryGetConfig(out string baseUrl, out string apiKey)
    {
        var cfg = JellioPlugin.Instance?.Configuration;
        baseUrl = (cfg?.ChaptarrUrl ?? string.Empty).Trim().TrimEnd('/');
        apiKey = (cfg?.ChaptarrApiKey ?? string.Empty).Trim();
        return !string.IsNullOrWhiteSpace(baseUrl) && !string.IsNullOrWhiteSpace(apiKey);
    }

    private HttpRequestMessage BuildRequest(HttpMethod method, string url, string apiKey)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("X-Api-Key", apiKey);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        return request;
    }

    // GET /api/v1/book/lookup?term=&mediaType= (BookLookupController). A
    // provider-prefixed term (hc:123, ol:OL1W, ...) is an exact work lookup;
    // anything else is a metadata text search. mediaType narrows results to
    // "ebook" or "audiobook" instances.
    public async Task<JsonArray?> LookupAsync(string term, string? mediaType, CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiKey) || string.IsNullOrWhiteSpace(term))
        {
            return null;
        }

        var url = baseUrl + "/api/v1/book/lookup?term=" + Uri.EscapeDataString(term);
        if (!string.IsNullOrWhiteSpace(mediaType))
        {
            url += "&mediaType=" + Uri.EscapeDataString(mediaType);
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(ChaptarrClient));
            using var request = BuildRequest(HttpMethod.Get, url, apiKey);
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Chaptarr book lookup failed, {StatusCode} for term {Term}", response.StatusCode, term);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return JsonNode.Parse(body) as JsonArray;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Chaptarr book lookup threw for term {Term}", term);
            return null;
        }
    }

    // GET /api/v1/book with no filter: Chaptarr's lean index of every book
    // it tracks (monitored edition only, no files).
    public async Task<JsonArray?> GetBooksAsync(CancellationToken cancellationToken) =>
        await GetJsonAsync("/api/v1/book", cancellationToken).ConfigureAwait(false) as JsonArray;

    // GET /api/v1/book/{id}: one tracked book in full, author included.
    public async Task<JsonObject?> GetBookAsync(int bookId, CancellationToken cancellationToken) =>
        await GetJsonAsync("/api/v1/book/" + bookId.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken).ConfigureAwait(false) as JsonObject;

    // GET /api/v1/edition?bookId= (EditionController): every edition of one
    // tracked book, with publisher, ISBNs, page count and edition covers.
    public async Task<JsonArray?> GetEditionsAsync(int bookId, CancellationToken cancellationToken) =>
        await GetJsonAsync("/api/v1/edition?bookId=" + bookId.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken).ConfigureAwait(false) as JsonArray;

    private async Task<JsonNode?> GetJsonAsync(string pathAndQuery, CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiKey))
        {
            return null;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(ChaptarrClient));
            using var request = BuildRequest(HttpMethod.Get, baseUrl + pathAndQuery, apiKey);
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Chaptarr {Path} failed, {StatusCode}", pathAndQuery, response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return JsonNode.Parse(body);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Chaptarr {Path} threw", pathAndQuery);
            return null;
        }
    }

    // POST /api/v1/book?mediaType= (BookController.AddBook). 201 means added,
    // 202 means Chaptarr queued it as a pending request (its own
    // PendingBookRequestResource carries a message), anything else is an
    // error whose body is either an error object or a list of validation
    // failures.
    public async Task<AddResult> AddBookAsync(JsonObject book, string mediaType, CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiKey))
        {
            return new AddResult(false, false, "Chaptarr is not configured");
        }

        var url = baseUrl + "/api/v1/book?mediaType=" + Uri.EscapeDataString(mediaType);
        try
        {
            var client = httpClientFactory.CreateClient(nameof(ChaptarrClient));
            using var request = BuildRequest(HttpMethod.Post, url, apiKey);
            request.Content = new StringContent(book.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                return new AddResult(true, true, ReadMessage(body));
            }

            if (response.IsSuccessStatusCode)
            {
                return new AddResult(true, false, null);
            }

            var message = ReadMessage(body) ?? "Chaptarr returned " + (int)response.StatusCode;
            logger.LogWarning("Jellio: Chaptarr add book failed, {StatusCode}: {Message}", response.StatusCode, message);
            return new AddResult(false, false, message);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Chaptarr add book threw");
            return new AddResult(false, false, "Could not reach Chaptarr");
        }
    }

    // Chaptarr hands covers it hasn't cached locally back as its own relative
    // /MediaCoverProxy/... path, which a browser on Jellyfin's origin can't
    // resolve. Only those cover paths are fetched here, so this never acts
    // as a general proxy into the server's network.
    public static bool IsCoverPath(string? path) =>
        !string.IsNullOrEmpty(path)
        && path.StartsWith('/')
        && !path.Contains("..", StringComparison.Ordinal)
        && (path.Contains("/MediaCoverProxy/", StringComparison.OrdinalIgnoreCase) || path.Contains("/MediaCover/", StringComparison.OrdinalIgnoreCase));

    public async Task<(byte[] Bytes, string ContentType)?> GetCoverAsync(string path, CancellationToken cancellationToken)
    {
        if (!IsCoverPath(path) || !TryGetConfig(out var baseUrl, out var apiKey) || !Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri))
        {
            return null;
        }

        // The path already carries Chaptarr's own URL base, so it replaces
        // whatever path the configured URL has rather than appending to it.
        var url = new Uri(baseUri, path).ToString();
        try
        {
            var client = httpClientFactory.CreateClient(nameof(ChaptarrClient));
            using var request = BuildRequest(HttpMethod.Get, url, apiKey);
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (!response.IsSuccessStatusCode || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            return (bytes, contentType);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Chaptarr cover fetch threw for {Path}", path);
            return null;
        }
    }

    // A cover URL Chaptarr's own metadata handed back (never one from a
    // browser): either its relative media cover path, or the metadata
    // provider's original https image.
    public async Task<(byte[] Bytes, string ContentType)?> GetCoverImageAsync(string source, CancellationToken cancellationToken)
    {
        if (IsCoverPath(source))
        {
            return await GetCoverAsync(source, cancellationToken).ConfigureAwait(false);
        }

        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            return null;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(ChaptarrClient));
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.TryAddWithoutValidation("Accept", "image/*");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (!response.IsSuccessStatusCode
                || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                || response.Content.Headers.ContentLength > MaxImageBytes)
            {
                return null;
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            return bytes.Length > MaxImageBytes ? null : (bytes, contentType);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: cover fetch threw for {Url}", uri);
            return null;
        }
    }

    // Chaptarr's remoteCover (and each image's url) is usually its own
    // relative /MediaCoverProxy/... path, not a real remote URL. Prefer the
    // original https remoteUrl the metadata provider gave, from the given
    // image lists in order, then Chaptarr's own cached copy.
    public static string? PickCover(IEnumerable<JsonNode?> imageLists, JsonNode? remoteCover)
    {
        var candidates = imageLists.SelectMany(images => CoverCandidates(images)).ToList();
        candidates.Add(ReadString(remoteCover));
        return candidates.FirstOrDefault(url => url is not null && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            ?? candidates.FirstOrDefault(IsCoverPath);
    }

    private static IEnumerable<string?> CoverCandidates(JsonNode? images)
    {
        if (images is not JsonArray array)
        {
            yield break;
        }

        foreach (var image in array.OfType<JsonObject>())
        {
            if (!string.Equals(ReadString(image["coverType"]), "cover", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            yield return ReadString(image["remoteUrl"]);
            yield return ReadString(image["url"]);
        }
    }

    private static string? ReadMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        try
        {
            var node = JsonNode.Parse(body);
            if (node is JsonObject obj)
            {
                return ReadString(obj["message"]) ?? ReadString(obj["error"]) ?? ReadString(obj["errorMessage"]);
            }

            if (node is JsonArray array)
            {
                return array.OfType<JsonObject>().Select(o => ReadString(o["errorMessage"])).FirstOrDefault(m => m is not null);
            }

            return ReadString(node);
        }
        catch (JsonException)
        {
            var text = body.Trim();
            return text.Length > 200 ? text[..200] : text;
        }
    }

    public static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) ? text : null;
}
