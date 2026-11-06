using System;
using Jellio.Services.Achievements;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/profile")]
[Authorize]
public class ProfileController(ProfileSettingsStore store) : ControllerBase
{
    public record PrivacyRequest(bool IsPrivate);

    public record BioRequest(string? Bio);

    public record GrouplistEnabledRequest(bool GrouplistEnabled);

    public record WatchlistAutoRemoveRequest(bool RemoveFromWatchlistAfterWatching);

    [HttpGet("settings")]
    public IActionResult GetSettings()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(store.Load(userId));
    }

    [HttpGet("{userId:guid}")]
    public IActionResult GetForUser(Guid userId)
    {
        var settings = store.Load(userId);
        return Ok(new { settings.IsPrivate, settings.Bio });
    }

    [HttpPost("privacy")]
    public IActionResult SetPrivacy([FromBody] PrivacyRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var settings = store.Update(userId, s => s.IsPrivate = request.IsPrivate);
        return Ok(settings);
    }

    [HttpPost("grouplist-enabled")]
    public IActionResult SetGrouplistEnabled([FromBody] GrouplistEnabledRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var settings = store.Update(userId, s => s.GrouplistEnabled = request.GrouplistEnabled);
        return Ok(settings);
    }

    [HttpPost("watchlist-auto-remove")]
    public ActionResult<ProfileSettings> SetWatchlistAutoRemove([FromBody] WatchlistAutoRemoveRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (request == null)
        {
            return BadRequest();
        }

        var updated = store.Update(userId, s => s.RemoveFromWatchlistAfterWatching = request.RemoveFromWatchlistAfterWatching);
        return Ok(updated);
    }

    [HttpPost("bio")]
    public IActionResult SetBio([FromBody] BioRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var settings = store.Update(userId, s =>
            s.Bio = string.IsNullOrWhiteSpace(request.Bio) ? null : request.Bio.Trim()[..Math.Min(request.Bio.Trim().Length, 240)]);
        return Ok(settings);
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
