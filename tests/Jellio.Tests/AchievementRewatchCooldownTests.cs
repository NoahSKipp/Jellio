using System;
using Jellio.Services;
using Jellio.Services.Achievements;
using Xunit;

namespace Jellio.Tests;

public class AchievementRewatchCooldownTests
{
    [Fact]
    public void IsWithinRewatchCooldown_AllowsFirstWatch()
    {
        var stats = new UserAchievementStats();
        var itemId = Guid.NewGuid();

        Assert.False(AchievementService.IsWithinRewatchCooldown(stats, itemId, DateTime.UtcNow));
    }

    [Fact]
    public void IsWithinRewatchCooldown_BlocksDuplicateAfterInitialFinish()
    {
        var itemId = Guid.NewGuid();
        var completedAt = new DateTime(2026, 11, 18, 12, 0, 0, DateTimeKind.Utc);
        var stats = new UserAchievementStats();
        stats.RecentActivity.Add(new ActivityEntry(
            itemId,
            "Episode 1",
            "Episode",
            "Show",
            Guid.NewGuid(),
            completedAt,
            1,
            1,
            Rewatch: false));

        // 35 minutes later (past the old 30m in-memory guard) is still blocked
        Assert.True(AchievementService.IsWithinRewatchCooldown(stats, itemId, completedAt.AddMinutes(35)));
        // 11 hours 59 minutes later is still blocked
        Assert.True(AchievementService.IsWithinRewatchCooldown(stats, itemId, completedAt.AddHours(12).AddMinutes(-1)));
        // 12 hours later is allowed
        Assert.False(AchievementService.IsWithinRewatchCooldown(stats, itemId, completedAt.AddHours(12)));
    }

    [Fact]
    public void IsWithinRewatchCooldown_BlocksBackToBackRewatches()
    {
        var itemId = Guid.NewGuid();
        var rewatchedAt = new DateTime(2026, 11, 18, 12, 0, 0, DateTimeKind.Utc);
        var stats = new UserAchievementStats();
        stats.RecentActivity.Add(new ActivityEntry(
            itemId,
            "Movie X",
            "Movie",
            null,
            null,
            rewatchedAt,
            null,
            null,
            Rewatch: true));

        Assert.True(AchievementService.IsWithinRewatchCooldown(stats, itemId, rewatchedAt.AddHours(4)));
        Assert.False(AchievementService.IsWithinRewatchCooldown(stats, itemId, rewatchedAt.AddHours(12)));
    }
}
