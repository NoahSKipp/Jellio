using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using Jellio.Services.Grouplist;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// A real single elimination bracket (GroupWatchRankingService.cs's own
/// header explains the format and why round resolution is a flat timer)
/// over every current Group Watch member's own pooled Grouplist. Same
/// real trust model GroupWatchChatController/GroupWatchInviteController
/// already document for this whole feature area: participant user ids
/// come from the caller (components/groupWatch.js's own real
/// publicUsersByName lookup, the one real place a group's own
/// Participants array, plain display names, ever resolves to a real
/// user id at all), not re-derived here, no server side SyncPlay
/// membership check this plugin has never needed before either.
/// </summary>
[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchRankingController(GroupWatchRankingService rankingService, GrouplistStore grouplistStore) : ControllerBase
{
    public record StartRequest(List<Guid>? ParticipantUserIds);

    public record VoteRequest(Guid ItemId);

    [HttpPost("{groupId}/ranking/start")]
    public IActionResult Start([FromRoute] Guid groupId, [FromBody] StartRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var participantIds = (request.ParticipantUserIds ?? new List<Guid>()).Append(userId).Distinct();
        var pooled = new List<Guid>();
        var seen = new HashSet<Guid>();
        foreach (var participantId in participantIds)
        {
            foreach (var itemId in grouplistStore.Load(participantId))
            {
                if (seen.Add(itemId))
                {
                    pooled.Add(itemId);
                }
            }
        }

        if (pooled.Count < 2)
        {
            return BadRequest("Not enough titles across the group's own Grouplists to start a pick.");
        }

        var session = rankingService.Start(groupId, userId, pooled);
        return Ok(session);
    }

    [HttpGet("{groupId}/ranking")]
    public IActionResult Get([FromRoute] Guid groupId)
    {
        return Ok(rankingService.Get(groupId));
    }

    [HttpPost("{groupId}/ranking/vote")]
    public IActionResult Vote([FromRoute] Guid groupId, [FromBody] VoteRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var session = rankingService.Vote(groupId, userId, request.ItemId);
        if (session is null)
        {
            return NotFound();
        }

        return Ok(session);
    }

    [HttpPost("{groupId}/ranking/cancel")]
    public IActionResult Cancel([FromRoute] Guid groupId)
    {
        rankingService.Cancel(groupId);
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
