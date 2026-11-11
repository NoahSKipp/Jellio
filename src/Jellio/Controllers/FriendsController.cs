using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Extensions;
using Jellio.Services.Friends;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/friends")]
[Authorize]
public class FriendsController(FriendsService friends, IUserManager userManager) : ControllerBase
{
    public record SendRequestBody(string? UserId);

    public record MuteBody(bool Muted);

    private const int MaxPeople = 50;

    [HttpGet]
    public IActionResult List()
    {
        if (!TryGetCaller(out var me))
        {
            return BadRequest("Invalid user session");
        }

        var data = friends.Snapshot();
        var entries = new List<(string Name, object Entry)>();
        foreach (var f in data.Friendships.Where(f => f.UserA == me || f.UserB == me))
        {
            var otherId = f.UserA == me ? f.UserB : f.UserA;
            var person = friends.GetPerson(otherId);
            if (person == null)
            {
                continue;
            }

            entries.Add((person.UserName, new
            {
                person.UserId,
                person.UserName,
                person.PrimaryImageTag,
                Since = f.Since,
                Muted = f.UserA == me ? f.MutedByA : f.MutedByB,
            }));
        }

        var sorted = entries.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase).Select(e => e.Entry).ToList();
        return Ok(new
        {
            Friends = sorted,
            Incoming = RequestEntries(data.Requests.Where(r => r.To == me), r => r.From),
            Outgoing = RequestEntries(data.Requests.Where(r => r.From == me), r => r.To),
        });
    }

    [HttpGet("status/{userId}")]
    public IActionResult Status(string userId)
    {
        if (!TryGetCaller(out var me) || !TryParseId(userId, out var other))
        {
            return BadRequest("Invalid user");
        }

        var (status, requestId, canRequest) = friends.StatusFor(me, other);
        return Ok(new { Status = status, RequestId = requestId, CanRequest = canRequest });
    }

    [HttpGet("people")]
    public IActionResult People([FromQuery] string? query)
    {
        if (!TryGetCaller(out var me))
        {
            return BadRequest("Invalid user session");
        }

        var data = friends.Snapshot();
        var needle = query?.Trim();
        var result = new List<(string Name, object Entry)>();
        foreach (var user in userManager.GetUsers())
        {
            if (user.Id == me || FriendsGraph.AreFriends(data, me, user.Id))
            {
                continue;
            }

            if (!string.IsNullOrEmpty(needle) && !user.Username.Contains(needle, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (friends.IsPrivate(user.Id) || friends.IsClosed(user.Id))
            {
                continue;
            }

            var person = friends.ToPerson(user);
            var status = FriendsGraph.StatusFor(data, me, user.Id).Status;
            result.Add((user.Username, new { person.UserId, person.UserName, person.PrimaryImageTag, Status = status }));
        }

        return Ok(result.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).Take(MaxPeople).Select(r => r.Entry).ToList());
    }

    [HttpPost("requests")]
    public IActionResult SendRequest([FromBody] SendRequestBody body)
    {
        if (!TryGetCaller(out var me) || body == null || !TryParseId(body.UserId, out var other))
        {
            return BadRequest("Invalid user");
        }

        if (userManager.GetUserById(other) == null)
        {
            return NotFound("That user no longer exists");
        }

        var (status, _, _) = friends.StatusFor(me, other);
        if (status is "private" or "closed")
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { Status = status });
        }

        var result = friends.SendRequest(me, other);
        switch (result.Outcome)
        {
            case SendOutcome.Self:
                return BadRequest("You cannot add yourself");
            case SendOutcome.Cooldown:
            case SendOutcome.PendingLimit:
                return StatusCode(StatusCodes.Status429TooManyRequests, new { Status = "none", Error = result.Outcome.ToString() });
            case SendOutcome.FriendLimit:
                return Conflict(new { Status = "none", Error = result.Outcome.ToString() });
        }

        var after = friends.StatusFor(me, other).Status;
        return Ok(new { Status = after });
    }

    [HttpPost("requests/{requestId}/accept")]
    public IActionResult Accept(string requestId)
    {
        if (!TryGetCaller(out var me))
        {
            return BadRequest("Invalid user session");
        }

        var result = friends.Accept(requestId, me);
        return result.Outcome switch
        {
            RespondOutcome.Done => Ok(new { Status = "friends" }),
            RespondOutcome.FriendLimit => Conflict(new { Status = "incoming", Error = "FriendLimit" }),
            _ => NotFound(),
        };
    }

    [HttpPost("requests/{requestId}/decline")]
    public IActionResult Decline(string requestId)
    {
        if (!TryGetCaller(out var me))
        {
            return BadRequest("Invalid user session");
        }

        return friends.Decline(requestId, me).Outcome == RespondOutcome.Done
            ? Ok(new { Status = "none" })
            : NotFound();
    }

    [HttpDelete("requests/{requestId}")]
    public IActionResult Cancel(string requestId)
    {
        if (!TryGetCaller(out var me))
        {
            return BadRequest("Invalid user session");
        }

        return friends.Cancel(requestId, me).Outcome == RespondOutcome.Done
            ? Ok(new { Status = "none" })
            : NotFound();
    }

    [HttpDelete("{userId}")]
    public IActionResult Remove(string userId)
    {
        if (!TryGetCaller(out var me) || !TryParseId(userId, out var other))
        {
            return BadRequest("Invalid user");
        }

        friends.RemoveFriend(me, other);
        return Ok(new { Status = "none" });
    }

    [HttpPost("{userId}/mute")]
    public IActionResult Mute(string userId, [FromBody] MuteBody body)
    {
        if (!TryGetCaller(out var me) || !TryParseId(userId, out var other) || body == null)
        {
            return BadRequest("Invalid user");
        }

        return friends.SetMuted(me, other, body.Muted) ? Ok(new { Muted = body.Muted }) : NotFound();
    }

    private List<object> RequestEntries(IEnumerable<FriendRequest> requests, Func<FriendRequest, Guid> otherSide)
    {
        var entries = new List<object>();
        foreach (var r in requests.OrderByDescending(r => r.At))
        {
            var person = friends.GetPerson(otherSide(r));
            if (person != null)
            {
                entries.Add(new { person.UserId, person.UserName, person.PrimaryImageTag, RequestId = r.Id, At = r.At });
            }
        }

        return entries;
    }

    private bool TryGetCaller(out Guid me) => User.TryGetJellyfinUserId(out me) && me != Guid.Empty;

    private static bool TryParseId(string? value, out Guid id) => Guid.TryParse(value, out id) && id != Guid.Empty;
}
