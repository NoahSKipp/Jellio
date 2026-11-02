using System;
using System.Linq;
using System.Threading.Tasks;
using Jellio.Services;
using Jellio.Services.Achievements;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

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

    [HttpDelete("{userId:guid}/activity")]
    public IActionResult DeleteActivity(Guid userId, [FromQuery] Guid itemId, [FromQuery] DateTime completedAtUtc)
    {
        if (!CanManage(userId))
        {
            return Forbid();
        }

        // Model binding turns a "...Z" timestamp into local time; compare
        // in UTC, to the millisecond.
        var wanted = completedAtUtc.Kind == DateTimeKind.Local ? completedAtUtc.ToUniversalTime() : completedAtUtc;
        var found = false;
        var stats = store.Update(userId, s =>
        {
            var start = s.RecentActivity.FindIndex(entry =>
                entry.ItemId == itemId
                && Math.Abs((entry.CompletedAtUtc - wanted).Ticks) < TimeSpan.TicksPerMillisecond);
            if (start < 0)
            {
                return;
            }

            found = true;
            var end = ActivityGrouping.SpanEnd(s.RecentActivity, start);
            s.RecentActivity.RemoveRange(start, end - start + 1);
        });

        if (!found)
        {
            return NotFound("No matching activity entry");
        }

        return Ok(Build(userId, stats));
    }

    // Takes a badge unlock off the Feed without relocking the badge.
    [HttpDelete("{userId:guid}/feed-badges/{badgeId}")]
    public IActionResult HideFeedBadge(Guid userId, string badgeId)
    {
        if (!CanManage(userId))
        {
            return Forbid();
        }

        if (AchievementCatalog.All.All(badge => badge.Id != badgeId))
        {
            return NotFound("Unknown badge id");
        }

        store.Update(userId, s => s.HiddenFeedBadgeIds.Add(badgeId));
        return NoContent();
    }

    // The reader themselves, or a Jellyfin administrator.
    private bool CanManage(Guid userId) =>
        userId == GetUserId() || User.IsInRole("Administrator");

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
            s.LiveTvTicks = fresh.LiveTvTicks;
            s.GroupWatchesTogether = fresh.GroupWatchesTogether;
            s.GenreCompletions = fresh.GenreCompletions;
            s.CurrentDayKey = fresh.CurrentDayKey;
            s.CurrentDayRuntimeTicks = fresh.CurrentDayRuntimeTicks;
            s.BestSingleDayRuntimeTicks = fresh.BestSingleDayRuntimeTicks;
            s.UnlockedBadgeIds = fresh.UnlockedBadgeIds;
            s.UnlockedAt = fresh.UnlockedAt;
            s.SuppressedBadgeIds = fresh.SuppressedBadgeIds;
            s.HiddenFeedBadgeIds = fresh.HiddenFeedBadgeIds;
            s.RecentActivity = fresh.RecentActivity;
            s.BooksCompleted = fresh.BooksCompleted;
            s.AudiobooksCompleted = fresh.AudiobooksCompleted;
            s.MangaVolumesCompleted = fresh.MangaVolumesCompleted;
            s.PagesRead = fresh.PagesRead;
            s.MangaPagesRead = fresh.MangaPagesRead;
            s.ListenedTicks = fresh.ListenedTicks;
            s.ReadingTicks = fresh.ReadingTicks;
            s.MangaReadingTicks = fresh.MangaReadingTicks;
            s.CompletedReadingIds = fresh.CompletedReadingIds;
            s.LastReadingDate = fresh.LastReadingDate;
            s.CurrentReadingStreak = fresh.CurrentReadingStreak;
            s.BestReadingStreak = fresh.BestReadingStreak;
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
            stats.BooksCompleted,
            stats.AudiobooksCompleted,
            stats.MangaVolumesCompleted,
            stats.PagesRead,
            ListenedHours = (int)(stats.ListenedTicks / TimeSpan.TicksPerHour),
            ListenedMinutes = (int)(stats.ListenedTicks / TimeSpan.TicksPerMinute),
            LiveTvMinutes = (int)(stats.LiveTvTicks / TimeSpan.TicksPerMinute),
            ReadingMinutes = (int)(stats.ReadingTicks / TimeSpan.TicksPerMinute),
            MangaReadingMinutes = (int)(stats.MangaReadingTicks / TimeSpan.TicksPerMinute),
            BookPagesRead = Math.Max(0, stats.PagesRead - stats.MangaPagesRead),
            stats.MangaPagesRead,
            Badges = badges,
            RecentActivity = ActivityGrouping.Group(stats.RecentActivity),
        };
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
