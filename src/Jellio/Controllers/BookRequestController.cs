using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Claims;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// Book search and requests for the Books shelf, straight against Chaptarr
/// (Services/Chaptarr/ChaptarrClient.cs). The browser only ever sends a
/// work id and a format: the server looks that work up again itself and
/// sends Chaptarr's own lookup result back, so a reader can't slip their
/// own root folder, profile or monitoring mode into the add call.
/// </summary>
[ApiController]
[Route("Jellio/books")]
[Authorize]
public partial class BookRequestController(ChaptarrClient chaptarrClient, IUserManager userManager, ILogger<BookRequestController> logger) : ControllerBase
{
    private static readonly string[] AuthorFieldsToReset =
    [
        "rootFolderPath",
        "audiobookRootFolderPath",
        "ebookRootFolderPath",
        "qualityProfileId",
        "audiobookQualityProfileId",
        "ebookQualityProfileId",
        "metadataProfileId",
        "audiobookMetadataProfileId",
        "ebookMetadataProfileId",
    ];

    public record BookSearchResult(string WorkId, string Title, string? Author, int? Year, string? CoverUrl, string? SeriesTitle, bool HasEbook, bool HasAudiobook);

    public record RequestBookBody(string WorkId, string BookType);

    public record RequestBookResult(string Status, string? Message);

    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q, [FromQuery(Name = "mediaType")] string? scope, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return BadRequest("q is required");
        }

        // The Books shelf searches ebooks only, the Audiobooks shelf
        // audiobooks only.
        var scopedType = scope?.Trim().ToLowerInvariant();
        if (scopedType is not (null or "" or "ebook" or "audiobook"))
        {
            return BadRequest("mediaType must be ebook or audiobook");
        }

        var lookup = await chaptarrClient.LookupAsync(q.Trim(), string.IsNullOrEmpty(scopedType) ? null : scopedType, cancellationToken).ConfigureAwait(false);
        if (lookup is null)
        {
            return StatusCode(502, "Chaptarr search failed or is not configured");
        }

        // Chaptarr returns separate ebook/audiobook instances of the same
        // work; one card per work, with both formats' library state merged.
        var byWork = new Dictionary<string, BookSearchResult>(StringComparer.OrdinalIgnoreCase);
        var order = new List<string>();
        foreach (var book in lookup.OfType<JsonObject>())
        {
            var workId = ChaptarrClient.ReadString(book["foreignBookId"]);
            var title = ChaptarrClient.ReadString(book["title"]);
            if (workId is null || title is null)
            {
                continue;
            }

            var mediaType = ChaptarrClient.ReadString(book["mediaType"]);
            var inLibrary = IsInLibrary(book);
            var hasEbook = HasLocal(book["localEbookBooks"]) || (inLibrary && mediaType == "ebook");
            var hasAudiobook = HasLocal(book["localAudiobookBooks"]) || (inLibrary && mediaType == "audiobook");

            if (byWork.TryGetValue(workId, out var existing))
            {
                byWork[workId] = existing with
                {
                    HasEbook = existing.HasEbook || hasEbook,
                    HasAudiobook = existing.HasAudiobook || hasAudiobook,
                };
                continue;
            }

            order.Add(workId);
            byWork[workId] = new BookSearchResult(
                workId,
                title,
                ChaptarrClient.ReadString(book["author"]?["authorName"]),
                ReadYear(book["releaseDate"]),
                CoverUrl(book),
                ChaptarrClient.ReadString(book["seriesTitle"]),
                hasEbook,
                hasAudiobook);
        }

        return Ok(order.Take(20).Select(workId => byWork[workId]));
    }

    [HttpPost("request")]
    public async Task<IActionResult> RequestBook([FromBody] RequestBookBody body, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var bookType = body?.BookType?.Trim().ToLowerInvariant();
        if (bookType is not ("ebook" or "audiobook"))
        {
            return BadRequest("BookType must be ebook or audiobook");
        }

        var workId = body!.WorkId?.Trim() ?? string.Empty;
        if (!WorkIdPattern().IsMatch(workId))
        {
            return BadRequest("WorkId must be a provider-prefixed id such as hc:12345");
        }

        var lookup = await chaptarrClient.LookupAsync(workId, bookType, cancellationToken).ConfigureAwait(false);
        if (lookup is null)
        {
            return StatusCode(502, "Chaptarr lookup failed or is not configured");
        }

        var book = lookup.OfType<JsonObject>()
            .FirstOrDefault(b => string.Equals(ChaptarrClient.ReadString(b["foreignBookId"]), workId, StringComparison.OrdinalIgnoreCase))
            ?? lookup.OfType<JsonObject>().FirstOrDefault();
        if (book is null)
        {
            return Ok(new RequestBookResult("error", "Chaptarr could not find this book"));
        }

        var alreadyLocal = bookType == "ebook" ? HasLocal(book["localEbookBooks"]) : HasLocal(book["localAudiobookBooks"]);
        if (alreadyLocal || IsInLibrary(book))
        {
            return Ok(new RequestBookResult("exists", "Already in Chaptarr"));
        }

        PrepareForAdd(book);
        var result = await chaptarrClient.AddBookAsync(book, bookType, cancellationToken).ConfigureAwait(false);

        var title = ChaptarrClient.ReadString(book["title"]) ?? workId;
        var requester = userManager.GetUserById(userId)?.Username ?? userId.ToString("N");
        if (result.Success)
        {
            logger.LogInformation("Jellio: {User} requested the {BookType} of {Title} ({WorkId}) from Chaptarr", requester, bookType, title, workId);
            return Ok(new RequestBookResult(result.Pending ? "pending" : "added", result.Message));
        }

        logger.LogWarning("Jellio: {User}'s {BookType} request for {Title} ({WorkId}) failed: {Message}", requester, bookType, title, workId, result.Message);
        return Ok(new RequestBookResult("error", result.Message));
    }

    // Monitor this one book and search for it now. Author-level folders and
    // profiles are cleared so Chaptarr fills them from its own root folder
    // defaults (BookController.NormalizeReadarrSingleFields), and a new
    // author is added watching only this book - never their whole catalogue.
    private static void PrepareForAdd(JsonObject book)
    {
        book["monitored"] = true;
        book["addOptions"] = new JsonObject
        {
            ["addType"] = "manual",
            ["searchForNewBook"] = true,
        };

        if (book["author"] is JsonObject author)
        {
            foreach (var field in AuthorFieldsToReset)
            {
                author.Remove(field);
            }

            author["monitored"] = true;
            author["addOptions"] = new JsonObject
            {
                ["monitor"] = "specificBook",
                ["searchForMissingBooks"] = false,
            };
        }
    }

    // A lookup result Chaptarr already tracks carries its own database id.
    private static bool IsInLibrary(JsonObject book) =>
        book["id"] is JsonValue value && value.TryGetValue<int>(out var id) && id > 0;

    private static bool HasLocal(JsonNode? node) => node is JsonArray array && array.Count > 0;

    private static int? ReadYear(JsonNode? node)
    {
        var text = ChaptarrClient.ReadString(node);
        return text is not null && DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date) ? date.Year : null;
    }

    // Search results show the whole work, so any edition's cover will do.
    private static string? CoverUrl(JsonObject book)
    {
        var imageLists = new List<JsonNode?> { book["images"] };
        if (book["editions"] is JsonArray editions)
        {
            imageLists.AddRange(editions.OfType<JsonObject>().Select(edition => edition["images"]));
        }

        var cover = ChaptarrClient.PickCover(imageLists, book["remoteCover"]);
        return cover is null || cover.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            ? cover
            : "/Jellio/books/cover?path=" + Uri.EscapeDataString(cover);
    }

    [HttpGet("cover")]
    public async Task<IActionResult> GetCover([FromQuery] string path, CancellationToken cancellationToken)
    {
        var cover = await chaptarrClient.GetCoverAsync(path, cancellationToken).ConfigureAwait(false);
        if (cover is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(cover.Value.Bytes, cover.Value.ContentType);
    }

    private Guid GetUserId()
    {
        if (
            HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }

    [GeneratedRegex(@"^[A-Za-z]{2,6}:[^\s]{1,120}$")]
    private static partial Regex WorkIdPattern();
}
