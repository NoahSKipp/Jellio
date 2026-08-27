using System;
using System.Security.Claims;
using Jellio.Services.Achievements;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// GetSettings/SetPrivacy/SetBio are self only, same real "Jellyfin-
/// UserId" claim every other per-user controller in this plugin already
/// reads its own user id from: nobody edits another real user's own
/// profile but that user, and this plugin has no admin surface for it.
/// GetForUser is the one public route, real Steam-style split: bio
/// (like the profile picture and future banner) stays visible either
/// way, only IsPrivate itself needs exposing so the profile page can
/// grey out the badge/activity section AchievementsController's own
/// {userId} route already goes dark for.
/// </summary>
[ApiController]
[Route("Jellio/profile")]
[Authorize]
public class ProfileController(ProfileSettingsStore store) : ControllerBase
{
    public record PrivacyRequest(bool IsPrivate);

    public record BioRequest(string? Bio);

    public record GrouplistEnabledRequest(bool GrouplistEnabled);

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

        var settings = store.Load(userId);
        settings.IsPrivate = request.IsPrivate;
        store.Save(userId, settings);
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

        var settings = store.Load(userId);
        settings.GrouplistEnabled = request.GrouplistEnabled;
        store.Save(userId, settings);
        return Ok(settings);
    }

    [HttpPost("bio")]
    public IActionResult SetBio([FromBody] BioRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var settings = store.Load(userId);
        settings.Bio = string.IsNullOrWhiteSpace(request.Bio) ? null : request.Bio.Trim()[..Math.Min(request.Bio.Trim().Length, 240)];
        store.Save(userId, settings);
        return Ok(settings);
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
