using System;
using Jellio.Services;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellio.Tests;

public class CalendarMonitoringTests
{
    private static readonly DateTime Now = new(2027, 1, 15, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void AShowFinishedAYearAgoIsStillWatchedForANewSeason()
    {
        var finished = new DateTime(2026, 1, 10, 0, 0, 0, DateTimeKind.Utc);
        Assert.True(CalendarService.ShouldMonitorSeries(SeriesStatus.Continuing, finished, isAnime: false, Now));
    }

    [Fact]
    public void ShowsWithoutAStatusAreTreatedAsStillAiring()
    {
        Assert.True(CalendarService.ShouldMonitorSeries(null, Now.AddYears(-2), isAnime: false, Now));
    }

    [Fact]
    public void TvStopsAfterThreeYearsAnimeAfterFive()
    {
        var fourYearsAgo = Now.AddDays(-4 * 365);
        Assert.False(CalendarService.ShouldMonitorSeries(SeriesStatus.Continuing, fourYearsAgo, isAnime: false, Now));
        Assert.True(CalendarService.ShouldMonitorSeries(SeriesStatus.Continuing, fourYearsAgo, isAnime: true, Now));
        Assert.False(CalendarService.ShouldMonitorSeries(SeriesStatus.Continuing, Now.AddDays(-6 * 365), isAnime: true, Now));
    }

    [Fact]
    public void EndedShowsAreNotWatched()
    {
        Assert.False(CalendarService.ShouldMonitorSeries(SeriesStatus.Ended, Now.AddDays(-3), isAnime: false, Now));
    }

    [Fact]
    public void AnEpisodePlayedWithoutADateCountsAsRecent()
    {
        Assert.True(CalendarService.ShouldMonitorSeries(SeriesStatus.Continuing, null, isAnime: false, Now));
    }
}
