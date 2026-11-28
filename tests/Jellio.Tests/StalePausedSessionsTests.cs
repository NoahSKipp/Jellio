using System;
using System.Collections.Generic;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class StalePausedSessionsTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 12, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Limit = TimeSpan.FromHours(4);
    private static readonly Guid ItemA = Guid.NewGuid();
    private static readonly Guid ItemB = Guid.NewGuid();

    private static PausedObservation Paused(Guid item, long ticks = 100) => new(item, true, ticks);

    [Fact]
    public void NotPausedResetsTheEntry()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0, Limit));
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", new PausedObservation(ItemA, false, 100), T0.AddHours(1), Limit));
        Assert.Empty(tracked);
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", new PausedObservation(null, false, null), T0.AddHours(9), Limit));
    }

    [Fact]
    public void PausedUnderTheLimitKeepsTheEntry()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0, Limit);
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0.AddHours(3), Limit));
        Assert.Equal(T0, tracked["s"].FirstSeenUtc);
    }

    [Fact]
    public void PausedOverTheLimitStopsOnce()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0, Limit);
        Assert.True(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0.AddHours(4).AddMinutes(1), Limit));
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0.AddHours(5), Limit));
    }

    [Fact]
    public void ExactlyTheLimitDoesNotStop()
    {
        Assert.False(StalePausedSessions.IsOverLimit(T0, T0.AddHours(4), Limit));
        Assert.True(StalePausedSessions.IsOverLimit(T0, T0.AddHours(4).AddSeconds(1), Limit));
    }

    [Fact]
    public void ChangingTheItemResetsTheClock()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0, Limit);
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemB), T0.AddHours(5), Limit));
        Assert.Equal(T0.AddHours(5), tracked["s"].FirstSeenUtc);
    }

    [Fact]
    public void ChangingThePositionResetsTheClock()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA, 100), T0, Limit);
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA, 200), T0.AddHours(5), Limit));
        Assert.Equal(T0.AddHours(5), tracked["s"].FirstSeenUtc);
    }

    [Fact]
    public void ALimitOfZeroDisablesTheCheck()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        var limit = StalePausedSessions.LimitFromHours(0);
        StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0, limit);
        Assert.False(StalePausedSessions.Evaluate(tracked, "s", Paused(ItemA), T0.AddDays(30), limit));
        Assert.Empty(tracked);
    }

    [Fact]
    public void VanishedSessionsArePruned()
    {
        var tracked = new Dictionary<string, PausedEntry>();
        StalePausedSessions.Evaluate(tracked, "a", Paused(ItemA), T0, Limit);
        StalePausedSessions.Evaluate(tracked, "b", Paused(ItemB), T0, Limit);
        StalePausedSessions.Prune(tracked, new HashSet<string> { "b" });
        Assert.False(tracked.ContainsKey("a"));
        Assert.True(tracked.ContainsKey("b"));
    }
}
