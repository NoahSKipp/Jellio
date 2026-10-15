using System;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

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
    public IActionResult Items([FromQuery] string genre, [FromQuery] string? types, [FromQuery] Guid? parentId, [FromQuery] int limit = 20)
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

        var items = genres.GetRow(user, genre, GenreCache.ParseTypes(types), parentId ?? Guid.Empty, Math.Clamp(limit, 1, 200));
        return Ok(new { Items = items, TotalRecordCount = items.Count });
    }

    private Jellyfin.Database.Implementations.Entities.User? CurrentUser()
    {
        var id = HttpContext.User.Identity is ClaimsIdentity identity && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var parsed) ? parsed : Guid.Empty;
        return id == Guid.Empty ? null : userManager.GetUserById(id);
    }
}
