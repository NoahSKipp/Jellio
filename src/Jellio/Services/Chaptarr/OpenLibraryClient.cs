using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Chaptarr;

public record DiscoverBook(string WorkId, string Title, string? Author, int? Year, string? CoverUrl);

/// <summary>
/// Book discovery for the Books/Audiobooks shelves. Chaptarr only looks
/// books up; it has nothing to browse. Open Library's free, keyless APIs
/// do (trending, subjects, an author's works), and their work ids are one
/// of Chaptarr's own provider prefixes ("ol:OL45883W"), so anything found
/// here can be requested through Chaptarr unchanged. Results are cached,
/// Open Library asks clients not to hammer it.
/// </summary>
public class OpenLibraryClient(IHttpClientFactory httpClientFactory, ILogger<OpenLibraryClient> logger)
{
    public const int PageSize = 36;
    private const string BaseUrl = "https://openlibrary.org";
    private const int MaxCacheEntries = 500;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<DiscoverBook> Books)> _cache = new(StringComparer.Ordinal);

    public Task<IReadOnlyList<DiscoverBook>?> TrendingAsync(int page, CancellationToken cancellationToken) =>
        FetchAsync("/trending/weekly.json?limit=" + PageSize + "&page=" + (page + 1), "works", cancellationToken);

    public Task<IReadOnlyList<DiscoverBook>?> SubjectAsync(string subject, int page, CancellationToken cancellationToken) =>
        FetchAsync(
            "/subjects/" + Uri.EscapeDataString(subject) + ".json?limit=" + PageSize + "&offset=" + (page * PageSize),
            "works",
            cancellationToken);

    // Most-published first, which is a fair proxy for an author's best-known
    // books.
    public Task<IReadOnlyList<DiscoverBook>?> AuthorAsync(string author, int page, CancellationToken cancellationToken) =>
        FetchAsync(
            "/search.json?author=" + Uri.EscapeDataString(author) + "&sort=editions&limit=" + PageSize + "&offset=" + (page * PageSize)
                + "&fields=key,title,author_name,first_publish_year,cover_i",
            "docs",
            cancellationToken);

    private async Task<IReadOnlyList<DiscoverBook>?> FetchAsync(string pathAndQuery, string listField, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(pathAndQuery, out var cached) && DateTime.UtcNow - cached.At < CacheTtl)
        {
            return cached.Books;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(OpenLibraryClient));
            using var request = new HttpRequestMessage(HttpMethod.Get, BaseUrl + pathAndQuery);
            // Open Library asks API clients to identify themselves.
            request.Headers.TryAddWithoutValidation("User-Agent", "Jellio/1.0 (Jellyfin plugin; https://github.com/NoahSKipp/Jellio)");
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Open Library {Path} failed, {StatusCode}", pathAndQuery, response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var list = JsonNode.Parse(body)?[listField] as JsonArray;
            var books = new List<DiscoverBook>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var work in list?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>())
            {
                var book = ToBook(work);
                if (book is not null && seen.Add(book.WorkId))
                {
                    books.Add(book);
                }
            }

            if (_cache.Count >= MaxCacheEntries)
            {
                _cache.Clear();
            }

            _cache[pathAndQuery] = (DateTime.UtcNow, books);
            return books;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Open Library {Path} threw", pathAndQuery);
            return null;
        }
    }

    // Trending/search results and subject results describe the same work
    // with different field names (author_name vs authors[].name, cover_i
    // vs cover_id).
    private static DiscoverBook? ToBook(JsonObject work)
    {
        var key = ChaptarrClient.ReadString(work["key"]);
        var title = ChaptarrClient.ReadString(work["title"]);
        if (key is null || title is null || !key.StartsWith("/works/", StringComparison.Ordinal))
        {
            return null;
        }

        var author = (work["author_name"] as JsonArray)?.Select(ChaptarrClient.ReadString).FirstOrDefault(name => name is not null)
            ?? (work["authors"] as JsonArray)?.OfType<JsonObject>().Select(a => ChaptarrClient.ReadString(a["name"])).FirstOrDefault(name => name is not null);
        var coverId = ReadLong(work["cover_i"]) ?? ReadLong(work["cover_id"]);
        return new DiscoverBook(
            "ol:" + key["/works/".Length..],
            title,
            author,
            ReadInt(work["first_publish_year"]),
            coverId is > 0 ? "https://covers.openlibrary.org/b/id/" + coverId.Value.ToString(CultureInfo.InvariantCulture) + "-M.jpg" : null);
    }

    private static long? ReadLong(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<long>(out var number) ? number : null;

    private static int? ReadInt(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<int>(out var number) ? number : null;
}
