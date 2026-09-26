using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Data.Enums;
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

    public record ShelfInfo(string? Authors, IReadOnlyList<string> Genres, int? Year, string? SeriesTitle);

    // The first shelf load of a big library can't wait on every
    // unmatched book's Chaptarr lookup; whatever resolves in time is
    // returned and the rest fills in on a later load, from the cache.
    private static readonly TimeSpan ShelfInfoBudget = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Author, genres, year and series for every book and audiobook in one
    /// library, keyed by item id, for the Books/Audiobooks shelf's author
    /// and series rows. Jellyfin's own fields win; Chaptarr fills gaps.
    /// </summary>
    [HttpGet("~/Jellio/books/shelf-info")]
    public async Task<IActionResult> GetShelfInfo([FromQuery] Guid parentId)
    {
        var user = GetUser();
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        if (libraryManager.GetItemById(parentId) is not Folder folder || !folder.IsVisible(user))
        {
            return NotFound();
        }

        var items = folder.GetItemList(new InternalItemsQuery(user)
        {
            Recursive = true,
            IncludeItemTypes = [BaseItemKind.Book, BaseItemKind.AudioBook],
        });

        // Not disposed: lookups past the time budget still release it.
        var throttle = new SemaphoreSlim(4);
        var lookups = items.Select(async item =>
        {
            var authors = metadataService.KnownAuthor(item);
            var genres = item.Genres ?? [];
            var year = item.ProductionYear;
            var series = (item as IHasSeries)?.SeriesName;
            if (authors is null || genres.Length == 0 || year is null)
            {
                await throttle.WaitAsync().ConfigureAwait(false);
                try
                {
                    var metadata = await metadataService.GetAsync(item).ConfigureAwait(false);
                    if (metadata is not null)
                    {
                        authors ??= metadata.Authors;
                        genres = genres.Length > 0 ? genres : metadata.Genres.ToArray();
                        year ??= metadata.Year;
                        series ??= metadata.SeriesTitle;
                    }
                }
                finally
                {
                    throttle.Release();
                }
            }

            return (Id: item.Id.ToString("N"), Info: new ShelfInfo(authors, genres, year, string.IsNullOrWhiteSpace(series) ? null : series));
        }).ToList();

        await Task.WhenAny(Task.WhenAll(lookups), Task.Delay(ShelfInfoBudget)).ConfigureAwait(false);

        var result = new Dictionary<string, ShelfInfo>(StringComparer.Ordinal);
        for (var i = 0; i < items.Count; i++)
        {
            var lookup = lookups[i];
            if (lookup.IsCompletedSuccessfully)
            {
                result[lookup.Result.Id] = lookup.Result.Info;
                continue;
            }

            var item = items[i];
            result[item.Id.ToString("N")] = new ShelfInfo(
                metadataService.KnownAuthor(item),
                item.Genres ?? [],
                item.ProductionYear,
                (item as IHasSeries)?.SeriesName);
        }

        return Ok(result);
    }

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

    private User? GetUser() =>
        HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
                ? userManager.GetUserById(userId)
                : null;

    private BaseItem? GetVisibleBook(Guid itemId)
    {
        var user = GetUser();
        if (user is null)
        {
            return null;
        }

        var item = libraryManager.GetItemById(itemId);
        return item is (Book or AudioBook) && item.IsVisible(user) ? item : null;
    }
}
