using System;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class CommunityWatchingTests
{
    private static readonly DateTime T0 = new(2026, 11, 4, 17, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FirstBuildIsDueAtOnceThenOnlyAfterTheInterval()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        Assert.True(schedule.IsDue(T0));
        schedule.Built(T0, T0.AddSeconds(2));
        Assert.False(schedule.IsDue(T0.AddMinutes(4)));
        Assert.True(schedule.IsDue(T0.AddMinutes(5).AddSeconds(2)));
    }

    [Fact]
    public void PlaybackMakesItDueAfterTheDebounceNotAtOnce()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        schedule.Built(T0, T0);
        schedule.MarkDirty(T0.AddSeconds(10));
        schedule.MarkDirty(T0.AddSeconds(20));
        Assert.False(schedule.IsDue(T0.AddSeconds(30)));
        Assert.True(schedule.IsDue(T0.AddSeconds(40)));
    }

    [Fact]
    public void PlaybackDuringABuildIsPickedUpByTheNextOne()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        schedule.MarkDirty(T0.AddSeconds(5));
        schedule.Built(T0, T0.AddSeconds(10));
        Assert.True(schedule.IsDue(T0.AddSeconds(40)));

        schedule.Built(T0.AddSeconds(40), T0.AddSeconds(45));
        Assert.False(schedule.IsDue(T0.AddMinutes(2)));
    }
}
