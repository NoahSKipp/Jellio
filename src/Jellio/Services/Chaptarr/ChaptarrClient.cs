using System;
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
