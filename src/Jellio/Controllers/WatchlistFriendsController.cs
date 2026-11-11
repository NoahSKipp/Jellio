using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Extensions;
using Jellio.Services.Friends;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/watchlist")]
[Authorize]
public class WatchlistFriendsController(FriendsService friends) : ControllerBase
{
    public record AddToFriendsBody(string? ItemId, List<string>? UserIds);

    [HttpPost("friends")]
    public IActionResult AddToFriends([FromBody] AddToFriendsBody body)
    {
        if (!User.TryGetJellyfinUserId(out var me) || me == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (body == null || !Guid.TryParse(body.ItemId, out var itemId) || body.UserIds is not { Count: > 0 })
        {
            return BadRequest("ItemId and UserIds are required");
        }

        if (body.UserIds.Count > FriendsService.MaxUsersPerAdd)
        {
            return BadRequest("At most " + FriendsService.MaxUsersPerAdd + " users per request");
        }

        var recipients = body.UserIds
            .Select(id => Guid.TryParse(id, out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty);

        var results = friends.AddToWatchlists(me, itemId, recipients)
            .Select(r => new { UserId = r.UserId.ToString("N"), r.Result })
            .ToList();
        return Ok(new { Results = results });
    }

    [HttpGet("added-by")]
    public IActionResult AddedBy()
    {
        if (!User.TryGetJellyfinUserId(out var me) || me == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(new { Items = friends.AddedByFor(me) });
    }
}
