using System;
using System.Collections.Generic;
using System.Security.Claims;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Real gap in stock Jellyfin: GET /Shows/NextUp has no matching endpoint
/// that hides one series from it permanently, only ever the side effect
/// of marking an episode played (which just advances that same series to
/// its own next episode, real bug reported live, components/
/// cardOptionsMenu.js's own "Remove from Up Next" button). Backed by
/// NextUpHiddenStore's own real per user JSON file. User id read from the
/// same real "Jellyfin-UserId" claim SleepTimerController already reads it
/// from, not guessed.
/// </summary>
[ApiController]
[Route("Jellio/next-up-hidden")]
[Authorize]
public class NextUpHiddenController(NextUpHiddenStore store) : ControllerBase
{
    [HttpGet]
    public ActionResult<List<string>> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(store.Load(userId));
    }

    [HttpPost("{seriesId}")]
    public IActionResult Hide(string seriesId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Hide(userId, seriesId);
        return Ok();
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
