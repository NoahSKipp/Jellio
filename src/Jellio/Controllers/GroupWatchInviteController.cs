using System;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Invites into a real Jellyfin SyncPlay group, backed by
/// GroupWatchInviteService's own in memory per-user queue. Same real
/// trust model GroupWatchChatController's own header already states: any
/// authenticated user, not scoped to real group membership server side.
/// </summary>
[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchInviteController(GroupWatchInviteService inviteService, IUserManager userManager) : ControllerBase
{
    public record InviteRequest(Guid ToUserId, string GroupName);

    // Real bug, audit-found: unlike chat text (500) and a profile bio
    // (240), GroupName below was stored verbatim, no cap at all, an
    // untrusted client free to send an invite carrying an arbitrarily
    // large string into GroupWatchInviteService's own per-user queue.
    private const int MaxGroupNameLength = 100;

    [HttpGet("invites")]
    public IActionResult GetInvites([FromQuery] long after = 0)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var invites = inviteService.Since(userId, after).Select(i => new
        {
            i.Id,
            i.GroupId,
            i.GroupName,
            i.FromUserId,
            i.FromUserName,
            i.Timestamp,
        });

        return Ok(invites);
    }

    [HttpPost("{groupId}/invite")]
    public IActionResult SendInvite([FromRoute] Guid groupId, [FromBody] InviteRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (request.ToUserId == Guid.Empty || request.ToUserId == userId)
        {
            return BadRequest("Invalid recipient");
        }

        var fromUserName = userManager.GetUserById(userId)?.Username ?? "Someone";
        var groupName = string.IsNullOrWhiteSpace(request.GroupName) ? "Group Watch" : request.GroupName.Trim();
        if (groupName.Length > MaxGroupNameLength)
        {
            groupName = groupName[..MaxGroupNameLength];
        }

        var invite = inviteService.Add(request.ToUserId, groupId, groupName, userId, fromUserName);
        return Ok(invite);
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
