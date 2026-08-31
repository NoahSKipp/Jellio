using System;
using System.Security.Claims;
using Jellio.Services.Grouplist;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Self only, item ids alone: no real BaseItemDto resolution lives here,
/// same real reason components/groupWatch.js's own chat watch-card
/// already just carries an ItemId and lets the frontend's own getItem()
/// resolve real display details, rather than this plugin introducing a
/// second real item-DTO resolution path no other Jellio controller has
/// needed yet. screens/home.js's own Grouplist tab resolves each id the
/// same way that watch-card already does.
/// </summary>
[ApiController]
[Route("Jellio/grouplist")]
[Authorize]
public class GrouplistController(GrouplistStore store) : ControllerBase
{
    [HttpGet]
    public IActionResult GetMine()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(new { ItemIds = store.Load(userId) });
    }

    [HttpPost("{itemId:guid}")]
    public IActionResult Add(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Add(userId, itemId);
        return Ok(new { ItemIds = store.Load(userId) });
    }

    [HttpDelete("{itemId:guid}")]
    public IActionResult Remove(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Remove(userId, itemId);
        return Ok(new { ItemIds = store.Load(userId) });
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
