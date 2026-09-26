using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Chaptarr;

/// <summary>
/// Metadata record for one owned book, as shown on the Books shelf and
/// the detail page. CoverSource never leaves the server: it is either a
/// Chaptarr media cover path or the metadata provider's https image, and
/// only BookMetadataController's cover endpoint fetches it.
/// </summary>
public record BookMetadata(
    string Title,
    string? Authors,
    string? Overview,
    IReadOnlyList<string> Genres,
    string? Publisher,
    int? PageCount,
    int? Year,
    string? Isbn,
    string? SeriesTitle,
    string? CoverSource);

/// <summary>
/// Jellyfin's own book metadata is usually empty: Bookshelf's Google Books
/// provider can't authenticate, and its Epub provider never applies to a
/// PDF. Chaptarr already holds real covers and edition data, so an owned
/// Book/AudioBook is matched to Chaptarr by title (and author when Jellyfin
/// knows one): first against the books Chaptarr tracks, then its metadata
/// lookup. Results are cached per item, and concurrent requests for the
/// same book (a whole shelf of covers loading at once) share one lookup.
/// </summary>
public partial class BookMetadataService(ChaptarrClient chaptarrClient, ILibraryManager libraryManager, ILogger<BookMetadataService> logger)
{
    private static readonly TimeSpan MatchTtl = TimeSpan.FromHours(12);
    private static readonly TimeSpan NoMatchTtl = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan FailureTtl = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan IndexTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(30);
    private static readonly string[] LeadingArticles = ["the ", "a ", "an "];

    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
    private readonly object _indexLock = new();
    private (Task<JsonArray?> Task, DateTime CreatedUtc)? _index;

    private sealed record CacheEntry(Task<Resolution> Task, DateTime CreatedUtc);

    private sealed record Resolution(BookMetadata? Metadata, bool Failed);

    private sealed record Query(string Title, string? Author);

    public async Task<BookMetadata?> GetAsync(BaseItem item)
    {
        if (!ChaptarrClient.IsConfigured)
        {
            return null;
        }

        var queries = BuildQueries(item);
        if (queries.Count == 0)
        {
            return null;
        }

        // Keyed by what is looked up, not by item: every track file of one
        // audiobook shares the same title and author, so one lookup.
        var key = queries[0].Title + "|" + queries[0].Author;
        while (true)
        {
            var entry = _cache.GetOrAdd(key, _ => new CacheEntry(ResolveWithTimeoutAsync(queries), DateTime.UtcNow));
            if (!IsExpired(entry))
            {
                return (await entry.Task.ConfigureAwait(false)).Metadata;
            }

            _cache.TryRemove(new KeyValuePair<string, CacheEntry>(key, entry));
        }
    }

    private static bool IsExpired(CacheEntry entry)
    {
        if (!entry.Task.IsCompleted)
        {
            return false;
        }

        var age = DateTime.UtcNow - entry.CreatedUtc;
        if (!entry.Task.IsCompletedSuccessfully)
        {
            return true;
        }

        var result = entry.Task.Result;
        return age > (result.Failed ? FailureTtl : result.Metadata is null ? NoMatchTtl : MatchTtl);
    }

    // Shared by every caller waiting on the same item, so it runs on its
    // own timeout rather than any one request's cancellation.
    private async Task<Resolution> ResolveWithTimeoutAsync(IReadOnlyList<Query> queries)
    {
        using var cts = new CancellationTokenSource(ResolveTimeout);
        try
        {
            return await ResolveAsync(queries, cts.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Chaptarr metadata match failed for {Title}", queries[0].Title);
            return new Resolution(null, true);
        }
    }

    private async Task<Resolution> ResolveAsync(IReadOnlyList<Query> queries, CancellationToken cancellationToken)
    {
        var index = await GetIndexAsync().ConfigureAwait(false);
        foreach (var query in queries)
        {
            var tracked = index is null ? null : BestMatch(index, query);
            if (tracked is null)
            {
                continue;
            }

            JsonArray? editions = null;
            if (tracked["id"] is JsonValue idValue && idValue.TryGetValue<int>(out var bookId) && bookId > 0)
            {
                editions = await chaptarrClient.GetEditionsAsync(bookId, cancellationToken).ConfigureAwait(false);
            }

            return new Resolution(ToMetadata(tracked, editions ?? tracked["editions"] as JsonArray), false);
        }

        var lookupFailed = false;
        foreach (var query in queries)
        {
            var term = query.Author is null ? query.Title : query.Title + " " + query.Author;
            var lookup = await chaptarrClient.LookupAsync(term, null, cancellationToken).ConfigureAwait(false);
            if (lookup is null)
            {
                lookupFailed = true;
                continue;
            }

            var found = BestMatch(lookup, query);
            if (found is not null)
            {
                return new Resolution(ToMetadata(found, found["editions"] as JsonArray), false);
            }
        }

        return new Resolution(null, lookupFailed || index is null);
    }

    // Chaptarr's whole tracked-book index, fetched once and shared by every
    // item matched against it for a few minutes.
    private Task<JsonArray?> GetIndexAsync()
    {
        lock (_indexLock)
        {
            if (_index is { } current
                && (!current.Task.IsCompleted || (current.Task.IsCompletedSuccessfully && current.Task.Result is not null && DateTime.UtcNow - current.CreatedUtc < IndexTtl)))
            {
                return current.Task;
            }

            var task = LoadIndexAsync();
            _index = (task, DateTime.UtcNow);
            return task;
        }
    }

    private async Task<JsonArray?> LoadIndexAsync()
    {
        using var cts = new CancellationTokenSource(ResolveTimeout);
        try
        {
            return await chaptarrClient.GetBooksAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private static JsonObject? BestMatch(JsonArray books, Query query)
    {
        var titleKeys = TitleKeys(query.Title);
        var authorKey = query.Author is null ? null : Normalize(query.Author);
        JsonObject? fallback = null;
        foreach (var book in books.OfType<JsonObject>())
        {
            var bookKeys = TitleKeys(ChaptarrClient.ReadString(book["title"]));
            if (!bookKeys.Overlaps(titleKeys))
            {
                continue;
            }

            var bookAuthor = AuthorName(book);
            if (authorKey is null || bookAuthor is null)
            {
                fallback ??= book;
                continue;
            }

            if (AuthorsMatch(authorKey, Normalize(bookAuthor)))
            {
                return book;
            }
        }

        // With an author known, a same-titled book by someone else is a
        // different book; without one, the first title match is the best
        // there is.
        return authorKey is null ? fallback : null;
    }

    // Surname overlap is enough: "Aristotle" vs "Aristotle", "J. R. R.
    // Tolkien" vs "Tolkien, J.R.R.".
    private static bool AuthorsMatch(string a, string b)
    {
        if (a.Length == 0 || b.Length == 0)
        {
            return true;
        }

        var aWords = a.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(w => w.Length > 2).ToHashSet(StringComparer.Ordinal);
        return b.Split(' ', StringSplitOptions.RemoveEmptyEntries).Any(aWords.Contains);
    }

    private static string? AuthorName(JsonObject book) =>
        ChaptarrClient.ReadString(book["author"]?["authorName"]) ?? ChaptarrClient.ReadString(book["authorTitle"]);

    private static BookMetadata ToMetadata(JsonObject book, JsonArray? editions)
    {
        var edition = PickEdition(editions);
        var imageLists = new List<JsonNode?>();
        if (edition is not null)
        {
            imageLists.Add(edition["images"]);
        }

        imageLists.Add(book["images"]);
        if (editions is not null)
        {
            imageLists.AddRange(editions.OfType<JsonObject>().Where(e => !ReferenceEquals(e, edition)).Select(e => e["images"]));
        }

        var genres = book["genres"] is JsonArray genreArray
            ? genreArray.Select(ChaptarrClient.ReadString).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList()
            : new List<string>();

        return new BookMetadata(
            ChaptarrClient.ReadString(book["title"]) ?? string.Empty,
            AuthorName(book),
            ChaptarrClient.ReadString(book["overview"]) ?? ChaptarrClient.ReadString(edition?["overview"]),
            genres,
            ChaptarrClient.ReadString(edition?["publisher"]),
            ReadPositiveInt(edition?["pageCount"]) ?? ReadPositiveInt(book["pageCount"]),
            ReadYear(edition?["releaseDate"]) ?? ReadYear(book["releaseDate"]),
            ChaptarrClient.ReadString(edition?["isbn13"]) ?? ChaptarrClient.ReadString(edition?["isbn10"]),
            ChaptarrClient.ReadString(book["seriesTitle"]),
            ChaptarrClient.PickCover(imageLists, edition?["remoteCover"] ?? book["remoteCover"]));
    }

    // The monitored edition is the one Chaptarr actually tracks; otherwise
    // whichever edition carries the most real detail.
    private static JsonObject? PickEdition(JsonArray? editions)
    {
        if (editions is null)
        {
            return null;
        }

        var all = editions.OfType<JsonObject>().ToList();
        return all.FirstOrDefault(e => e["monitored"] is JsonValue v && v.TryGetValue<bool>(out var monitored) && monitored)
            ?? all.OrderByDescending(EditionDetail).FirstOrDefault();
    }

    private static int EditionDetail(JsonObject edition) =>
        (ChaptarrClient.ReadString(edition["publisher"]) is null ? 0 : 1)
        + (ChaptarrClient.ReadString(edition["isbn13"]) is null ? 0 : 1)
        + (ReadPositiveInt(edition["pageCount"]) is null ? 0 : 1)
        + (edition["images"] is JsonArray { Count: > 0 } ? 1 : 0);

    private static int? ReadPositiveInt(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<int>(out var number) && number > 0 ? number : null;

    private static int? ReadYear(JsonNode? node)
    {
        var text = ChaptarrClient.ReadString(node);
        return text is not null && DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date) && date.Year > 1
            ? date.Year
            : null;
    }

    // An audiobook's title lives on Album (one item per file); a book with
    // no embedded metadata is named after its file, which often reads
    // "Author - Title (2019) [Publisher]".
    private List<Query> BuildQueries(BaseItem item)
    {
        var rawTitle = item is AudioBook && !string.IsNullOrWhiteSpace(item.Album) ? item.Album : item.Name;
        var title = CleanTitle(rawTitle);
        if (title.Length == 0)
        {
            return [];
        }

        var author = KnownAuthor(item);
        var queries = new List<Query> { new(title, author) };
        var dash = title.IndexOf(" - ", StringComparison.Ordinal);
        if (dash > 0 && dash < title.Length - 3)
        {
            var left = title[..dash].Trim();
            var right = title[(dash + 3)..].Trim();
            queries.Add(new Query(right, author ?? left));
            queries.Add(new Query(left, author ?? right));
        }

        return queries;
    }

    public string? KnownAuthor(BaseItem item)
    {
        if (item is AudioBook audioBook && audioBook.AlbumArtists is { Count: > 0 } albumArtists)
        {
            return albumArtists[0];
        }

        try
        {
            return libraryManager.GetPeople(item).FirstOrDefault(person => person.Type == PersonKind.Author)?.Name;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: could not read authors for {ItemId}", item.Id);
            return null;
        }
    }

    private static string CleanTitle(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return string.Empty;
        }

        var cleaned = BracketedPattern().Replace(name.Replace('_', ' '), " ");
        return WhitespacePattern().Replace(cleaned, " ").Trim(' ', '-', '.', ',');
    }

    // The full title and the title without its subtitle, so "Nicomachean
    // Ethics" matches "The Nicomachean Ethics: A New Translation".
    private static HashSet<string> TitleKeys(string? title)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(title))
        {
            return keys;
        }

        AddKey(keys, title);
        var colon = title.IndexOfAny([':', ';']);
        if (colon > 0)
        {
            AddKey(keys, title[..colon]);
        }

        return keys;
    }

    private static void AddKey(HashSet<string> keys, string title)
    {
        var key = Normalize(title);
        foreach (var article in LeadingArticles)
        {
            if (key.StartsWith(article, StringComparison.Ordinal))
            {
                key = key[article.Length..];
                break;
            }
        }

        if (key.Length > 0)
        {
            keys.Add(key);
        }
    }

    private static string Normalize(string text)
    {
        var decomposed = text.Replace("&", " and ", StringComparison.Ordinal).Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            sb.Append(char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : ' ');
        }

        return WhitespacePattern().Replace(sb.ToString(), " ").Trim();
    }

    [GeneratedRegex(@"\([^)]*\)|\[[^\]]*\]|\{[^}]*\}")]
    private static partial Regex BracketedPattern();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespacePattern();
}
