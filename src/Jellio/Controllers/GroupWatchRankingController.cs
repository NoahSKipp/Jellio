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
///
/// Audit-flagged, Low severity, re-examined rather than left unread: a
/// caller can name a real user's own id here who never actually joined
/// this real groupId at all, pooling their own private Grouplist into a
/// bracket they have no part in. No cheap real fix closes this without
/// either a false-negative risk or no real protection at all, both
/// checked directly before writing this rather than assumed. Real
/// SyncPlay group membership is not something this plugin can see
/// server side at all (GroupWatchRankingService.cs's own header already
/// found this, checked again here rather than trusted secondhand).
/// GroupWatchInviteService's own real invite records looked like a real
/// fit, an actual signal that two real users share a real groupId, but
/// that store is keyed by recipient only, caps at MaxPendingPerUser (20)
/// total invites ever sent to one real user with the oldest evicted
/// first, and carries no real index by groupId at all: a real, long
/// since accepted invite for exactly this pick would silently fail that
/// check the moment 20 newer ones from anywhere else arrived, blocking
/// a genuinely legitimate participant's own real pooled Grouplist,
/// worse than the real gap this would be closing. ProfileSettings'
/// own real GrouplistEnabled flag gates nothing here either: it is a
/// pure "show me this feature" UI toggle (its own header explains why),
/// never a real consent signal, and a reader who actually has real
/// Grouplist items worth leaking is exactly the reader who already has
/// it turned on, the one real case a check against it would fail to
/// protect. Left as the same real trust model the rest of this feature
/// area already accepts, real friends-only scale this plugin has never
/// needed to defend against a hostile participant at.
/// </summary>
[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchRankingController(GroupWatchRankingService rankingService, GrouplistStore grouplistStore) : ControllerBase
{
    public record StartRequest(List<Guid>? ParticipantUserIds);

    public record VoteRequest(Guid ItemId);

    // Real bug, audit-found: ParticipantUserIds came straight from the
    // caller with no cap at all, one real Grouplist file read per id
    // below, so a real caller submitting an arbitrarily large list could
    // force an arbitrarily large amount of synchronous disk I/O in one
    // real request. This plugin's own real friends-only scale never
    // needs a group anywhere near this big; picked well above any real
    // SyncPlay group this plugin has ever actually seen, not tuned down
    // to the bone.
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
            HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
