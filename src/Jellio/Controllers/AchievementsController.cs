using System;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using Jellio.Services.Achievements;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Read only: AchievementService is the sole writer, off real playback
/// events, this just merges a user's own persisted UserAchievementStats
/// against the fixed AchievementCatalog. The {userId} route exists
/// already for the profile page's own badge showcase (any user's own
/// badges are meant to be visible there), not a speculative extra, both
/// routes share the exact same real merge below.
///
/// GetForUser is the one real place a Privacy toggle actually bites:
/// same real Steam behaviour requested (profile picture and banner stay
/// visible, real Jellyfin's own UserDto.PrimaryImageTag already covers
/// the first half, this plugin's own future banner does the second),
/// badges and stats are the part this plugin owns and the part that
/// goes dark. GetMine skips the check entirely, real feedback never
/// asked for hiding a user's own badges from themselves.
/// </summary>
[ApiController]
[Route("Jellio/achievements")]
[Authorize]
public class AchievementsController(AchievementStore store, AchievementService achievementService, ProfileSettingsStore profileSettingsStore) : ControllerBase
{
    [HttpGet]
    public IActionResult GetMine()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(Build(userId));
    }

    // Trusts the caller the same way GroupWatchInviteController's own
    // header already documents Group Watch state trusting it elsewhere:
    // no real server side SyncPlay group membership check behind
    // either of these, components/groupWatch.js's own real SyncPlay
    // WebSocket state is the only place either one is actually known.
    [HttpPost("group-watch/started")]
    public async Task<IActionResult> CreditGroupWatchStarted()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        await achievementService.CreditGroupWatchStartedAsync(userId).ConfigureAwait(false);
        return Ok(Build(userId));
    }

    [HttpPost("group-watch/together")]
    public async Task<IActionResult> CreditGroupWatchTogether()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        await achievementService.CreditGroupWatchTogetherAsync(userId).ConfigureAwait(false);
        return Ok(Build(userId));
    }

    [HttpGet("{userId:guid}")]
    public IActionResult GetForUser(Guid userId)
    {
        if (userId != GetUserId() && profileSettingsStore.Load(userId).IsPrivate)
        {
            return Ok(new { IsPrivate = true });
        }

        return Ok(Build(userId));
    }

    private object Build(Guid userId)
    {
        var stats = store.Load(userId);
        var badges = AchievementCatalog.All.Select(badge => new
        {
            badge.Id,
            badge.Name,
            badge.Description,
            Rarity = badge.Rarity.ToString(),
            Unlocked = stats.UnlockedBadgeIds.Contains(badge.Id),
            UnlockedAt = stats.UnlockedAt.TryGetValue(badge.Id, out var unlockedAt) ? unlockedAt : (DateTime?)null,
        });

        return new
        {
            IsPrivate = false,
            stats.MoviesCompleted,
            stats.EpisodesCompleted,
            stats.TotalCompleted,
            stats.BestBingeStreak,
            Badges = badges,
            RecentActivity = ActivityGrouping.Group(stats.RecentActivity),
        };
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
