using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Claims;
using Jellio.Services.Reading;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Backs screens/reader.js: serves a Book item's own file to the in-browser
/// EPUB/PDF reader and stores where each reader got to (ReadingProgressStore).
/// Audiobooks never come through here - Jellyfin's own playback reporting
/// already tracks their resume position natively.
/// </summary>
[ApiController]
[Route("Jellio/reading")]
[Authorize]
public class ReadingController(ReadingProgressStore store, ILibraryManager libraryManager, IUserManager userManager) : ControllerBase
{
    private static readonly Dictionary<string, string> BookContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".epub"] = "application/epub+zip",
        [".pdf"] = "application/pdf",
        // Comic/manga volumes: a zip of page images, read by
        // screens/reader.js's comic mode.
        [".cbz"] = "application/vnd.comicbook+zip",
    };

    public record ProgressBody(string Locator, double Progress, int? TotalPages);

    [HttpGet("progress/{itemId}")]
    public IActionResult GetProgress([FromRoute] Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(store.Get(userId, itemId) ?? new ReadingProgressRecord());
    }

    [HttpPost("progress/{itemId}")]
    public IActionResult SetProgress([FromRoute] Guid itemId, [FromBody] ProgressBody body)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (body is null || string.IsNullOrWhiteSpace(body.Locator))
        {
            return BadRequest("Locator is required");
        }

        var totalPages = body.TotalPages is > 0 and < 1_000_000 ? body.TotalPages : null;
        return Ok(store.Set(userId, itemId, body.Locator, body.Progress, totalPages));
    }

    // Item ids only, most recently read first: the frontend already knows
    // how to fetch and render real items from ids, so this stays a thin list.
    [HttpGet("in-progress")]
    public IActionResult GetInProgress([FromQuery] int limit)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var entries = store.GetInProgress(userId, limit <= 0 ? 20 : Math.Min(limit, 100));
        return Ok(entries.Select(entry => new
        {
            ItemId = entry.ItemId.ToString("N"),
            entry.Record.Progress,
            entry.Record.TotalPages,
            entry.Record.UpdatedAt,
        }));
    }

    // Served here rather than through Jellyfin's own /Items/{id}/Download
    // so reading in the browser does not hinge on the user's download
    // permission. Range-enabled so pdf.js can fetch pages lazily.
    [HttpGet("file/{itemId}")]
    public IActionResult GetFile([FromRoute] Guid itemId)
    {
        var userId = GetUserId();
        var user = userId == Guid.Empty ? null : userManager.GetUserById(userId);
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        var item = libraryManager.GetItemById(itemId);
        if (item is null || !item.IsVisible(user) || string.IsNullOrEmpty(item.Path) || !System.IO.File.Exists(item.Path))
        {
            return NotFound();
        }

        if (!BookContentTypes.TryGetValue(Path.GetExtension(item.Path), out var contentType))
        {
            return StatusCode(415, "Only EPUB, PDF and CBZ books can be opened in the reader");
        }

        return PhysicalFile(item.Path, contentType, enableRangeProcessing: true);
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
}
