using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Claims;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// The Books and Audiobooks Requests page (where each request stands in
/// Chaptarr) and removing a book from a reader's library: only from their
/// own shelf while anyone else still has it, from Chaptarr and the server
/// once nobody does.
/// </summary>
[ApiController]
[Route("Jellio/books")]
[Authorize]
public class BookLibraryController(
    ChaptarrClient chaptarrClient,
    BookMetadataService metadataService,
    BookRequestStore requestStore,
    ShelfStore shelfStore,
    ReadingProgressStore progressStore,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    ILogger<BookLibraryController> logger) : ControllerBase
{
    // Imported requests stay listed this long, so a reader can see theirs
    // arrived.
    private static readonly TimeSpan AvailableWindow = TimeSpan.FromDays(14);

    // State: searching, queued, downloading, importing, blocked, failed,
    // scanning (on disk, Jellyfin hasn't picked it up), available, missing
    // (Chaptarr no longer tracks it).
    public record RequestEntry(
        int ChaptarrBookId,
        string Title,
        string? Author,
        string? CoverUrl,
        string State,
        double? Progress,
        string? TimeLeft,
        string? Message,
        IReadOnlyList<string> RequestedBy,
        bool Mine,
        DateTimeOffset? RequestedAt,
        string? ItemId);

    public record RemoveBody(string MediaType, string? ItemId = null, int ChaptarrBookId = 0, string? Title = null);

    [HttpGet("requests")]
    public async Task<IActionResult> Requests([FromQuery] string mediaType, CancellationToken cancellationToken)
    {
        var user = GetUser();
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        if (mediaType is not ("ebook" or "audiobook"))
        {
            return BadRequest("mediaType must be ebook or audiobook");
        }

        if (!ChaptarrClient.IsConfigured)
        {
            return Ok(new { Configured = false, Items = Array.Empty<RequestEntry>() });
        }

        var queueTask = chaptarrClient.GetQueueAsync(mediaType, cancellationToken);
        var missingTask = chaptarrClient.GetMissingAsync(mediaType, cancellationToken);
        var indexTask = chaptarrClient.GetBooksAsync(cancellationToken);
        await Task.WhenAll(queueTask, missingTask, indexTask).ConfigureAwait(false);
        var queue = queueTask.Result;
        var missing = missingTask.Result;
        var index = indexTask.Result;
        if (queue is null && missing is null && index is null)
        {
            return StatusCode(502, "Chaptarr could not be reached");
        }

        var library = LibraryTitles(user, mediaType);
        var requests = AllRequests(mediaType);
        var indexById = (index ?? [])
            .OfType<JsonObject>()
            .Where(book => ChaptarrClient.ReadId(book["id"]) > 0)
            .GroupBy(book => ChaptarrClient.ReadId(book["id"]))
            .ToDictionary(group => group.Key, group => group.First());

        var entries = new Dictionary<string, RequestEntry>(StringComparer.Ordinal);

        foreach (var book in (missing ?? []).OfType<JsonObject>())
        {
            var id = ChaptarrClient.ReadId(book["id"]);
            var title = ChaptarrClient.ReadString(book["title"]);
            if (id <= 0 || title is null || !IsFormat(book, mediaType))
            {
                continue;
            }

            entries["c:" + id] = NewEntry(id, title, ChaptarrClient.ReadString(book["author"]?["authorName"]), book, "searching", null, null, null);
        }

        foreach (var record in (queue ?? []).OfType<JsonObject>())
        {
            var id = ChaptarrClient.ReadId(record["bookId"]);
            var book = record["book"] as JsonObject;
            var title = ChaptarrClient.ReadString(book?["title"]) ?? ChaptarrClient.ReadString(record["title"]);
            if (title is null)
            {
                continue;
            }

            var (state, progress, message) = QueueState(record);
            var key = id > 0 ? "c:" + id : "q:" + ChaptarrClient.ReadId(record["id"]);
            entries[key] = NewEntry(
                id,
                title,
                ChaptarrClient.ReadString(book?["author"]?["authorName"]) ?? ChaptarrClient.ReadString(record["author"]?["authorName"]),
                book,
                state,
                progress,
                ChaptarrClient.ReadString(record["timeleft"]),
                message);
        }

        foreach (var request in requests)
        {
            var id = request.Entry.ChaptarrBookId;
            var key = id > 0 ? "c:" + id : null;
            key ??= entries.FirstOrDefault(pair => SameTitle(pair.Value.Title, request.Entry.Title)).Key;
            if (key is not null && entries.ContainsKey(key))
            {
                continue;
            }

            var itemId = library.FirstOrDefault(pair => SameTitle(pair.Key, request.Entry.Title)).Value;
            indexById.TryGetValue(id, out var tracked);
            tracked ??= (index ?? []).OfType<JsonObject>()
                .FirstOrDefault(book => IsFormat(book, mediaType) && SameTitle(ChaptarrClient.ReadString(book["title"]), request.Entry.Title));

            string state;
            if (itemId is not null)
            {
                if (DateTimeOffset.UtcNow - request.Entry.RequestedAt > AvailableWindow)
                {
                    continue;
                }

                state = "available";
            }
            else if (tracked is null)
            {
                state = "missing";
            }
            else if (ChaptarrClient.IsDownloaded(tracked, mediaType))
            {
                state = "scanning";
            }
            else
            {
                state = "searching";
            }

            var trackedId = tracked is null ? id : ChaptarrClient.ReadId(tracked["id"]);
            entries[trackedId > 0 ? "c:" + trackedId : "r:" + request.Entry.WorkId + request.Entry.Title] = NewEntry(
                trackedId,
                request.Entry.Title,
                request.Entry.Author,
                tracked,
                state,
                null,
                null,
                state == "missing" ? "Chaptarr isn't tracking this any more." : null) with { ItemId = itemId };
        }

        // Who asked for each one.
        var names = new Dictionary<Guid, string>();
        string NameOf(Guid id) => names.TryGetValue(id, out var name) ? name : names[id] = userManager.GetUserById(id)?.Username ?? "Someone";
        var result = entries.Values.Select(entry =>
        {
            var askers = requests
                .Where(request => (entry.ChaptarrBookId > 0 && request.Entry.ChaptarrBookId == entry.ChaptarrBookId) || SameTitle(request.Entry.Title, entry.Title))
                .ToList();
            return entry with
            {
                RequestedBy = askers.Select(request => NameOf(request.UserId)).Distinct().ToList(),
                Mine = askers.Any(request => request.UserId == user.Id),
                RequestedAt = askers.Count > 0 ? askers.Min(request => request.Entry.RequestedAt) : null,
            };
        });

        return Ok(new
        {
            Configured = true,
            Items = result
                .OrderBy(entry => StateOrder(entry.State))
                .ThenByDescending(entry => entry.RequestedAt ?? DateTimeOffset.MinValue)
                .ThenBy(entry => entry.Title, StringComparer.OrdinalIgnoreCase)
                .ToList(),
        });
    }

    [HttpPost("requests/{bookId:int}/search")]
    public async Task<IActionResult> SearchAgain(int bookId, CancellationToken cancellationToken)
    {
        if (bookId <= 0)
        {
            return BadRequest("bookId is required");
        }

        return await chaptarrClient.SearchBookAsync(bookId, cancellationToken).ConfigureAwait(false)
            ? Ok(new { Searching = true })
            : StatusCode(502, "Chaptarr could not start a search");
    }

    [HttpPost("library/remove")]
    public async Task<IActionResult> Remove([FromBody] RemoveBody body, CancellationToken cancellationToken)
    {
        var user = GetUser();
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        var mediaType = body?.MediaType;
        if (mediaType is not ("ebook" or "audiobook"))
        {
            return BadRequest("MediaType must be ebook or audiobook");
        }

        // The library item and, for an audiobook, every file of it.
        BaseItem? item = null;
        if (!string.IsNullOrEmpty(body!.ItemId))
        {
            if (!Guid.TryParse(body.ItemId, out var itemGuid) || (item = libraryManager.GetItemById(itemGuid)) is null)
            {
                return NotFound();
            }
        }

        var items = item is null ? new List<BaseItem>() : BookFiles(item);
        var title = item is null
            ? body.Title?.Trim()
            : item is AudioBook ? BookMetadataService.AudiobookTitle(item) : item.Name;
        if (string.IsNullOrEmpty(title))
        {
            return BadRequest("ItemId or Title is required");
        }

        var key = item is null ? null : "i:" + item.Id.ToString("N");
        var chaptarrId = body.ChaptarrBookId;
        bool Matches(BookRequestEntry entry) =>
            entry.BookType == mediaType
            && ((chaptarrId > 0 && entry.ChaptarrBookId == chaptarrId) || SameTitle(entry.Title, title));

        var others = userManager.GetUsers()
            .Where(other => other.Id != user.Id && StillHas(other, key, items, Matches))
            .Select(other => other.Username)
            .ToList();

        if (others.Count > 0)
        {
            if (key is not null)
            {
                shelfStore.ForgetItem(user.Id, key, hidden: true);
            }

            progressStore.RemoveMany(user.Id, items.Select(file => file.Id));
            requestStore.Remove(user.Id, Matches);

            // Out of their Continue listening too.
            foreach (var file in items)
            {
                var data = userDataManager.GetUserData(user, file);
                if (data is not null && (data.Played || data.PlaybackPositionTicks > 0))
                {
                    data.Played = false;
                    data.PlaybackPositionTicks = 0;
                    userDataManager.SaveUserData(user, file, data, UserDataSaveReason.TogglePlayed, CancellationToken.None);
                }
            }

            logger.LogInformation("Jellio: {User} removed {Title} from their library, {Count} other readers still have it", user.Username, title, others.Count);
            return Ok(new { Mode = "personal", Others = others.Count });
        }

        // Nobody else has it: out of Chaptarr, off the disk and out of
        // Jellyfin.
        if (chaptarrId <= 0)
        {
            chaptarrId = requestStore.Load(user.Id).Where(Matches).Select(entry => entry.ChaptarrBookId).FirstOrDefault(id => id > 0);
        }

        if (chaptarrId <= 0)
        {
            var index = await chaptarrClient.GetBooksAsync(cancellationToken).ConfigureAwait(false);
            chaptarrId = (index ?? []).OfType<JsonObject>()
                .Where(book => IsFormat(book, mediaType) && SameTitle(ChaptarrClient.ReadString(book["title"]), title))
                .Select(book => ChaptarrClient.ReadId(book["id"]))
                .FirstOrDefault(id => id > 0);
        }

        var chaptarrRemoved = false;
        if (chaptarrId > 0)
        {
            var queue = await chaptarrClient.GetQueueAsync(mediaType, cancellationToken).ConfigureAwait(false);
            foreach (var record in (queue ?? []).OfType<JsonObject>().Where(record => ChaptarrClient.ReadId(record["bookId"]) == chaptarrId))
            {
                await chaptarrClient.RemoveQueueItemAsync(ChaptarrClient.ReadId(record["id"]), cancellationToken).ConfigureAwait(false);
            }

            chaptarrRemoved = await chaptarrClient.DeleteBookAsync(chaptarrId, deleteFiles: true, cancellationToken).ConfigureAwait(false);
        }

        var deleted = 0;
        var folders = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in items)
        {
            try
            {
                var path = file.Path;
                var onDisk = !string.IsNullOrEmpty(path) && (System.IO.File.Exists(path) || Directory.Exists(path));
                if (file is AudioBook && !string.IsNullOrEmpty(path) && Path.GetDirectoryName(path) is { } folder)
                {
                    folders.Add(folder);
                }

                libraryManager.DeleteItem(file, new DeleteOptions { DeleteFileLocation = onDisk });
                deleted++;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: could not delete {Path}", file.Path);
            }
        }

        // An audiobook's own folder, once its files are gone.
        foreach (var folder in folders)
        {
            try
            {
                if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any())
                {
                    Directory.Delete(folder);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: could not remove the empty folder {Folder}", folder);
            }
        }

        foreach (var id in userManager.GetUsers().Select(other => other.Id))
        {
            if (key is not null)
            {
                shelfStore.ForgetItem(id, key, hidden: false);
            }

            progressStore.RemoveMany(id, items.Select(file => file.Id));
            requestStore.Remove(id, Matches);
        }

        metadataService.InvalidateIndex();
        logger.LogInformation(
            "Jellio: {User} removed {Title} ({MediaType}) for everyone, Chaptarr book {BookId} removed: {Removed}, {Count} library items deleted",
            user.Username,
            title,
            mediaType,
            chaptarrId,
            chaptarrRemoved,
            deleted);
        return Ok(new { Mode = "full", ChaptarrRemoved = chaptarrRemoved, Deleted = deleted });
    }

    // Whether another reader still has this book: on their shelf (not
    // removed) with progress, in a category, or requested by them.
    private bool StillHas(User other, string? key, List<BaseItem> items, Func<BookRequestEntry, bool> matches)
    {
        var shelf = shelfStore.Load(other.Id);
        if (key is not null && shelf.LibraryRemoved.Contains(key))
        {
            return false;
        }

        if (requestStore.Load(other.Id).Any(matches))
        {
            return true;
        }

        if (key is not null && shelf.Categories.Any(category => category.Items.Contains(key)))
        {
            return true;
        }

        foreach (var file in items)
        {
            if (progressStore.Get(other.Id, file.Id) is { Progress: > 0 })
            {
                return true;
            }

            var data = userDataManager.GetUserData(other, file);
            if (data is not null && (data.Played || data.PlaybackPositionTicks > 0))
            {
                return true;
            }
        }

        return false;
    }

    // An audiobook split into tracks is one book: every AudioBook in its
    // folder with the same album, as the shelf groups them.
    private List<BaseItem> BookFiles(BaseItem item)
    {
        if (item is not AudioBook)
        {
            return [item];
        }

        var siblings = libraryManager.GetItemList(new InternalItemsQuery
        {
            ParentId = item.ParentId,
            IncludeItemTypes = [BaseItemKind.AudioBook],
        });
        var album = item.Album ?? string.Empty;
        var group = siblings.Where(sibling => (sibling.Album ?? string.Empty) == album).ToList();
        if (!group.Any(sibling => sibling.Id == item.Id))
        {
            group.Add(item);
        }

        return group;
    }

    // This reader's visible books of one format, by title, to tell which
    // requests have arrived.
    private List<KeyValuePair<string, string>> LibraryTitles(User user, string mediaType)
    {
        var items = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            Recursive = true,
            IncludeItemTypes = [mediaType == "audiobook" ? BaseItemKind.AudioBook : BaseItemKind.Book],
        });
        return items
            .Select(item => new KeyValuePair<string, string>(item is AudioBook ? BookMetadataService.AudiobookTitle(item) : item.Name ?? string.Empty, item.Id.ToString("N")))
            .ToList();
    }

    private List<(Guid UserId, BookRequestEntry Entry)> AllRequests(string mediaType) =>
        requestStore.UserIds()
            .SelectMany(id => requestStore.Load(id).Where(entry => entry.BookType == mediaType).Select(entry => (id, entry)))
            .ToList();

    private static RequestEntry NewEntry(int id, string title, string? author, JsonObject? book, string state, double? progress, string? timeLeft, string? message) =>
        new(id, title, author, book is null ? null : BookRequestController.CoverUrl(book), state, progress, timeLeft, message, [], false, null, null);

    // Queue records: downloading with progress, waiting or importing,
    // blocked or failed with Chaptarr's reason.
    private static (string State, double? Progress, string? Message) QueueState(JsonObject record)
    {
        var size = ReadNumber(record["size"]);
        var left = ReadNumber(record["sizeleft"]);
        double? progress = size > 0 ? Math.Clamp(1 - (left / size), 0, 1) : null;
        var messages = (record["statusMessages"] as JsonArray ?? [])
            .OfType<JsonObject>()
            .SelectMany(message => (message["messages"] as JsonArray ?? []).Select(ChaptarrClient.ReadString))
            .Where(text => !string.IsNullOrWhiteSpace(text))
            .ToList();
        var error = ChaptarrClient.ReadString(record["errorMessage"]);
        if (!string.IsNullOrWhiteSpace(error))
        {
            messages.Insert(0, error);
        }

        var message = messages.Count > 0 ? string.Join(" ", messages.Distinct()) : null;
        var tracked = ChaptarrClient.ReadString(record["trackedDownloadState"])?.ToLowerInvariant();
        var status = ChaptarrClient.ReadString(record["status"])?.ToLowerInvariant();
        return tracked switch
        {
            "importpending" or "importing" => ("importing", 1, message),
            "importblocked" => ("blocked", 1, message ?? "Chaptarr couldn't import the download."),
            "downloadfailed" or "downloadfailedpending" => ("failed", progress, message ?? "The download failed."),
            _ when status is "failed" or "warning" => (status == "failed" ? "failed" : "downloading", progress, message),
            _ when status is "queued" or "delay" or "paused" or "downloadclientunavailable" => ("queued", progress, message),
            _ => ("downloading", progress, message),
        };
    }

    private static double ReadNumber(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<double>(out var number) ? number : 0;

    private static int StateOrder(string state) => state switch
    {
        "blocked" or "failed" => 0,
        "downloading" or "importing" => 1,
        "queued" => 2,
        "scanning" => 3,
        "searching" => 4,
        "missing" => 5,
        _ => 6,
    };

    private static bool IsFormat(JsonObject book, string mediaType)
    {
        var own = ChaptarrClient.ReadString(book["mediaType"]);
        return own is null || string.Equals(own, mediaType, StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameTitle(string? a, string? b)
    {
        if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b))
        {
            return false;
        }

        var keys = BookMetadataService.TitleKeysFor(a).ToHashSet(StringComparer.Ordinal);
        return BookMetadataService.TitleKeysFor(b).Any(keys.Contains);
    }

    private User? GetUser()
    {
        if (HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId))
        {
            return userManager.GetUserById(userId);
        }

        return null;
    }
}
