using System;
using System.Collections.Generic;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Chaptarr-sourced metadata and covers for books already in the library
/// (Services/Chaptarr/BookMetadataService.cs), used wherever Jellyfin's own
/// fields for a Book/AudioBook are empty. The cover endpoint only ever
/// fetches the source Chaptarr's own data named for that item.
/// </summary>
[ApiController]
[Route("Jellio/books/item")]
[Authorize]
public class BookMetadataController(BookMetadataService metadataService, ChaptarrClient chaptarrClient, ILibraryManager libraryManager, IUserManager userManager) : ControllerBase
{
    public record BookMetadataResponse(
        string Title,
        string? Authors,
        string? Overview,
        IReadOnlyList<string> Genres,
        string? Publisher,
        int? PageCount,
        int? Year,
        string? Isbn,
        string? SeriesTitle,
        bool HasCover);

    [HttpGet("{itemId}/metadata")]
    public async Task<IActionResult> GetMetadata([FromRoute] Guid itemId)
    {
        var item = GetVisibleBook(itemId);
        if (item is null)
        {
            return NotFound();
        }

        var metadata = await metadataService.GetAsync(item).ConfigureAwait(false);
        if (metadata is null)
        {
            return NoContent();
        }

        return Ok(new BookMetadataResponse(
            metadata.Title,
            metadata.Authors,
            metadata.Overview,
            metadata.Genres,
            metadata.Publisher,
            metadata.PageCount,
            metadata.Year,
            metadata.Isbn,
            metadata.SeriesTitle,
            metadata.CoverSource is not null));
    }

    [HttpGet("{itemId}/cover")]
    public async Task<IActionResult> GetCover([FromRoute] Guid itemId, CancellationToken cancellationToken)
    {
        var item = GetVisibleBook(itemId);
        if (item is null)
        {
            return NotFound();
        }

        var metadata = await metadataService.GetAsync(item).ConfigureAwait(false);
        if (metadata?.CoverSource is null)
        {
            return NotFound();
        }

        var cover = await chaptarrClient.GetCoverImageAsync(metadata.CoverSource, cancellationToken).ConfigureAwait(false);
        if (cover is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(cover.Value.Bytes, cover.Value.ContentType);
    }

    private BaseItem? GetVisibleBook(Guid itemId)
    {
        var user = HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
                ? userManager.GetUserById(userId)
                : null;
        if (user is null)
        {
            return null;
        }

        var item = libraryManager.GetItemById(itemId);
        return item is (Book or AudioBook) && item.IsVisible(user) ? item : null;
    }
}
