using System;
using System.Threading.Tasks;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

/// <summary>
/// Genre lists and genre rows from Services/GenreCache.cs, so the home and
/// library pages don't scan the whole library in the browser.
/// </summary>
[ApiController]
[Route("Jellio/genres")]
[Authorize]
public class GenresController(GenreCache genres, IUserManager userManager) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Counts([FromQuery] string? types, [FromQuery] Guid? parentId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var counts = await genres.GetCountsAsync(user, GenreCache.ParseTypes(types), parentId ?? Guid.Empty).ConfigureAwait(false);
        return Ok(new { Genres = counts });
    }

    [HttpGet("items")]
    public async Task<IActionResult> Items(
        [FromQuery] string genre,
        [FromQuery] string? types,
        [FromQuery] Guid? parentId,
        [FromQuery] int startIndex = 0,
        [FromQuery] int? start = null,
        [FromQuery] int limit = 20,
        [FromQuery] int? size = null,
        [FromQuery] bool? enableVirtual = null,
        [FromQuery] bool? virtualExpansion = null)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(genre))
        {
            return BadRequest("genre is required");
        }

        var offset = Math.Max(0, start ?? startIndex);
        var count = Math.Clamp(size ?? limit, 1, 200);
        var allowVirtual = enableVirtual ?? virtualExpansion ?? false;

        var (items, totalCount) = await genres.GetRowAsync(
            user,
            genre,
            GenreCache.ParseTypes(types),
            parentId ?? Guid.Empty,
            offset,
            count,
            allowVirtual,
            cancellationToken: HttpContext.RequestAborted).ConfigureAwait(false);

        return Ok(new { Items = items, TotalRecordCount = totalCount, StartIndex = offset });
    }

    private Jellyfin.Database.Implementations.Entities.User? CurrentUser()
    {
        var id = User.TryGetJellyfinUserId(out var parsed) ? parsed : Guid.Empty;
        return id == Guid.Empty ? null : userManager.GetUserById(id);
    }
}
