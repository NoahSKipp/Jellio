using System;
using System.Linq;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchInviteController(GroupWatchInviteService inviteService, IUserManager userManager, Jellio.Services.Parties.PartyService parties) : ControllerBase
{
    public record InviteRequest(Guid ToUserId, string GroupName);

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

        // An invite from someone in a private party lets the invitee in
        // without its code.
        if (parties.Get(groupId) is not { } meta || parties.IsAdmitted(meta, userId))
        {
            parties.Admit(groupId, request.ToUserId);
        }

        var invite = inviteService.Add(request.ToUserId, groupId, groupName, userId, fromUserName);
        return Ok(invite);
    }

    private Guid GetUserId()
    {
        if (
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
