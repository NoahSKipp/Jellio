using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Services;
using Jellio.Services.Grouplist;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchRankingController(GroupWatchRankingService rankingService, GrouplistStore grouplistStore) : ControllerBase
{
    public record StartRequest(List<Guid>? ParticipantUserIds);

    public record VoteRequest(Guid ItemId);

    private const int MaxParticipants = 32;

    [HttpPost("{groupId}/ranking/start")]
    public IActionResult Start([FromRoute] Guid groupId, [FromBody] StartRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var requestedParticipants = request.ParticipantUserIds ?? new List<Guid>();
        if (requestedParticipants.Count > MaxParticipants)
        {
            return BadRequest($"Too many participants. A pick can pool at most {MaxParticipants} people's own Grouplists.");
        }

        var participantIds = requestedParticipants.Append(userId).Distinct().ToList();
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

        var session = rankingService.Start(groupId, userId, pooled, participantIds.Count);
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
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
