using System;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class LastPlayedStampTests
{
    private static readonly DateTime Now = new(2026, 11, 24, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void AMissingDateIsAlwaysStamped()
    {
        Assert.True(LastPlayedStamp.NeedsStamp(null, Now, refreshOlder: false));
        Assert.True(LastPlayedStamp.NeedsStamp(null, Now, refreshOlder: true));
    }

    [Fact]
    public void ProgressNeverRefreshesAnExistingDate()
    {
        Assert.False(LastPlayedStamp.NeedsStamp(Now.AddDays(-3), Now, refreshOlder: false));
    }

    [Fact]
    public void AStartOrPartStopRefreshesAnOlderDate()
    {
        Assert.True(LastPlayedStamp.NeedsStamp(Now.AddMinutes(-5), Now, refreshOlder: true));
    }

    [Fact]
    public void ADateJustSetIsLeftAlone()
    {
        Assert.False(LastPlayedStamp.NeedsStamp(Now.AddSeconds(-10), Now, refreshOlder: true));
    }
}
