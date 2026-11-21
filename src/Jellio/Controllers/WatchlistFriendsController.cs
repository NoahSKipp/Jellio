using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Extensions;
using Jellio.Services.Friends;
using Jellio.Services.Reading;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/watchlist")]
[Authorize]
public class WatchlistFriendsController(FriendsService friends, ReadingTargets readingTargets, IUserManager userManager) : ControllerBase
{
    // Key, Kind, Title, Author, CoverUrl and MangaId describe a reading item
    // (see ReadingListController); a plain ItemId is a Movie or Series.
    public record AddToFriendsBody(
        string? ItemId,
        List<string>? UserIds,
        string? Key = null,
        string? Kind = null,
        string? Title = null,
        string? Author = null,
        string? CoverUrl = null,
        int? MangaId = null);

    [HttpPost("friends")]
    public IActionResult AddToFriends([FromBody] AddToFriendsBody body)
    {
        if (!User.TryGetJellyfinUserId(out var me) || me == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var userIds = body?.UserIds;
        var reading = body is null
            ? null
            : new ReadingInput(body.Key, body.Kind, body.ItemId, body.Title, body.Author, body.CoverUrl, body.MangaId);
        var isReading = reading is not null && userIds is { Count: > 0 } && readingTargets.IsReadingRequest(reading);

        if (body is null || userIds is not { Count: > 0 } || (!isReading && !Guid.TryParse(body.ItemId, out _)))
        {
            return BadRequest("ItemId and UserIds are required");
        }

        if (userIds.Count > FriendsService.MaxUsersPerAdd)
        {
            return BadRequest("At most " + FriendsService.MaxUsersPerAdd + " users per request");
        }

        var recipients = userIds
            .Select(id => Guid.TryParse(id, out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty);

        if (isReading)
        {
            var parse = readingTargets.Resolve(reading!, userManager.GetUserById(me));
            if (parse.Target is null && parse.Error != ReadingListLogic.Errors.NotFound)
            {
                return BadRequest(new { Error = parse.Error });
            }

            var readingResults = friends.AddToReadingLists(me, parse.Target, recipients)
                .Select(r => new { UserId = r.UserId.ToString("N"), r.Result })
                .ToList();
            return Ok(new { Results = readingResults });
        }

        var results = friends.AddToWatchlists(me, Guid.Parse(body.ItemId!), recipients)
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
