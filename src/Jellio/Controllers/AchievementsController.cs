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

    public record RealWatchRequest(Guid ItemId);

    // AchievementService.cs's own header explains why this exists at
    // all: item.RunTimeTicks is the library's own metadata runtime, not
    // the real duration of whatever Gelato actually resolved, and
    // reality TV in particular routinely lists a broadcast time slot
    // well past the real file's own actual length. screens/player.js's
    // own real <video>.duration, not this endpoint, is what actually
    // decides when to call this: trusts the caller the same real way
    // the two group-watch endpoints above already do, real feedback
    // (Below Deck Mediterranean, reported live) being the exact case
    // this exists to fix.
    [HttpPost("real-watch")]
    public async Task<IActionResult> CreditRealWatch([FromBody] RealWatchRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        await achievementService.CreditRealWatchAsync(userId, request.ItemId).ConfigureAwait(false);
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

    // screens/profile.js's own real activity list already shows exactly
    // one row per ActivityGrouping.Group() entry (a whole binge
    // collapsed to one row, that file's own header explains why), so
    // itemId+completedAtUtc here is that same group's own real "first"
    // entry, the one real GroupedActivityEntry actually carries back to
    // a caller. Deleting only that one real RecentActivity record would
    // leave the rest of a collapsed binge behind as a shorter, now
    // mismatched row still on screen, so this walks forward the exact
    // same real same-series/same-UTC-day span ActivityGrouping.Group()
    // itself would have collapsed, and removes the whole real span
    // together. Query params rather than a DELETE body: runtime/api.js's
    // own shared deleteJson() helper (notifications' own delete/clear
    // calls already lean on it) never needed one before this, and two
    // real Guid/DateTime values round trip through a query string just
    // as well without touching that shared helper's own signature.
    [HttpDelete("{userId:guid}/activity")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult DeleteActivity(Guid userId, [FromQuery] Guid itemId, [FromQuery] DateTime completedAtUtc)
    {
        var found = false;
        var stats = store.Update(userId, s =>
        {
            var start = s.RecentActivity.FindIndex(entry =>
                entry.ItemId == itemId && entry.CompletedAtUtc == completedAtUtc);
            if (start < 0)
            {
                return;
            }

            found = true;
            var first = s.RecentActivity[start];
            var end = start;
            if (first.ItemType == "Episode" && first.SeriesName is not null)
            {
                while (
                    end + 1 < s.RecentActivity.Count
                    && s.RecentActivity[end + 1].ItemType == "Episode"
                    && s.RecentActivity[end + 1].SeriesName == first.SeriesName
                    && s.RecentActivity[end + 1].CompletedAtUtc.Date == first.CompletedAtUtc.Date)
                {
                    end++;
                }
            }

            s.RecentActivity.RemoveRange(start, end - start + 1);
        });

        if (!found)
        {
            return NotFound("No matching activity entry");
        }

        return Ok(Build(userId, stats));
    }

    // Real feedback: an admin correcting a mistaken credit (a shared
    // account, a real accidental mark-as-played) needs this badge to
    // actually stay locked afterward, not just disappear from
    // UnlockedBadgeIds until the next real completed movie or episode
    // silently re-adds it right back (UserAchievementStats.
    // SuppressedBadgeIds's own header covers exactly why that would
    // otherwise happen - most tiers here share one real counter across
    // several badges). Reset below is the only other real place this
    // set ever gets cleared.
    [HttpPost("{userId:guid}/badges/{badgeId}/lock")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult LockBadge(Guid userId, string badgeId)
    {
        if (AchievementCatalog.All.All(badge => badge.Id != badgeId))
        {
            return NotFound("Unknown badge id");
        }

        var stats = store.Update(userId, s =>
        {
            s.UnlockedBadgeIds.Remove(badgeId);
            s.UnlockedAt.Remove(badgeId);
            s.SuppressedBadgeIds.Add(badgeId);
        });

        return Ok(Build(userId, stats));
    }

    // A whole-user wipe, not a per badge one: most thresholds in
    // AchievementCatalog.cs share one real counter across several tiers
    // (MoviesCompleted alone backs all three movie-buff-* badges), so
    // there is no real way to roll back "this one badge's own progress"
    // in isolation without also relitigating every other badge that
    // same counter feeds. Real feedback's own "reset the progress" ask,
    // taken at its word: every counter, every unlocked badge, and this
    // user's own activity feed all go back to a fresh account's real
    // starting state together.
    [HttpPost("{userId:guid}/reset")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult ResetProgress(Guid userId)
    {
        var stats = store.Update(userId, s =>
        {
            var fresh = new UserAchievementStats();
            s.MoviesCompleted = fresh.MoviesCompleted;
            s.EpisodesCompleted = fresh.EpisodesCompleted;
            s.CurrentBingeStreak = fresh.CurrentBingeStreak;
            s.BestBingeStreak = fresh.BestBingeStreak;
            s.LastCompletionUtc = fresh.LastCompletionUtc;
            s.LastCompletionWasEpisode = fresh.LastCompletionWasEpisode;
            s.NightOwlCompletions = fresh.NightOwlCompletions;
            s.EarlyBirdCompletions = fresh.EarlyBirdCompletions;
            s.WeekendCompletions = fresh.WeekendCompletions;
            s.LastStreakDate = fresh.LastStreakDate;
            s.CurrentDailyStreak = fresh.CurrentDailyStreak;
            s.BestDailyStreak = fresh.BestDailyStreak;
            s.GroupsStarted = fresh.GroupsStarted;
            s.GroupWatchesTogether = fresh.GroupWatchesTogether;
            s.GenreCompletions = fresh.GenreCompletions;
            s.CurrentDayKey = fresh.CurrentDayKey;
            s.CurrentDayRuntimeTicks = fresh.CurrentDayRuntimeTicks;
            s.BestSingleDayRuntimeTicks = fresh.BestSingleDayRuntimeTicks;
            s.UnlockedBadgeIds = fresh.UnlockedBadgeIds;
            s.UnlockedAt = fresh.UnlockedAt;
            s.SuppressedBadgeIds = fresh.SuppressedBadgeIds;
            s.RecentActivity = fresh.RecentActivity;
        });

        return Ok(Build(userId, stats));
    }

    private object Build(Guid userId, UserAchievementStats? preloadedStats = null)
    {
        var stats = preloadedStats ?? store.Load(userId);
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
