using System;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Backs screens/player.js's own "Waiting for X to finish loading in"
/// banner, GroupWatchJoinSyncService's own header explains why this is
/// separate from real SyncPlay's own Buffering/Ready signal rather than
/// reusing it. Same real trust model GroupWatchChatController's own
/// header already states: any authenticated user, not scoped to real
/// group membership server side.
/// </summary>
[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchJoinSyncController(GroupWatchJoinSyncService joinSyncService, IUserManager userManager) : ControllerBase
{
    public record StartRequest(Guid PlaylistItemId);

    [HttpPost("{groupId}/join-sync/start")]
    public IActionResult Start([FromRoute] Guid groupId, [FromBody] StartRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var userName = userManager.GetUserById(userId)?.Username ?? "Someone";
        joinSyncService.Start(groupId, userId, userName, request.PlaylistItemId);
        return Ok();
    }

    [HttpPost("{groupId}/join-sync/clear")]
    public IActionResult Clear([FromRoute] Guid groupId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        joinSyncService.Clear(groupId, userId);
        return Ok();
    }

    [HttpGet("{groupId}/join-sync")]
    public IActionResult Get([FromRoute] Guid groupId, [FromQuery] Guid playlistItemId)
    {
        var entries = joinSyncService.Get(groupId, playlistItemId).Select(e => new
        {
            e.UserId,
            e.UserName,
        });

        return Ok(entries);
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
