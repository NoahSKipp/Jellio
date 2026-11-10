using System.Linq;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class PlayStartStatsTests
{
    [Fact]
    public void Percentiles_UseNearestRank()
    {
        var p = PlayStartStats.Percentiles(Enumerable.Range(1, 10));
        Assert.Equal(10, p.Count);
        Assert.Equal(5, p.P50);
        Assert.Equal(9, p.P90);

        var one = PlayStartStats.Percentiles(new[] { 42 });
        Assert.Equal(42, one.P50);
        Assert.Equal(42, one.P90);

        var none = PlayStartStats.Percentiles(new int[0]);
        Assert.Equal(0, none.Count);
        Assert.Null(none.P50);
    }

    [Fact]
    public void Ring_KeepsOnlyTheLastEntries()
    {
        var stats = new PlayStartStats(3);
        for (var i = 1; i <= 5; i++)
        {
            stats.Add(new PlayStartEntry("web", "fresh", null, i, null));
        }

        Assert.Equal(new[] { 3, 4, 5 }, stats.Snapshot().Select(e => e.TotalMs).ToArray());
        Assert.Equal(3, stats.Summarize().Count);
    }

    [Fact]
    public void Summary_GroupsByClientAndFrom_WithWarmHitRate()
    {
        var stats = new PlayStartStats(100);
        stats.Add(new PlayStartEntry("web", "fresh", false, 4000, 3800));
        stats.Add(new PlayStartEntry("web", "fresh", true, 2000, null));
        stats.Add(new PlayStartEntry("web", "prewarmed", true, 900, 850));
        stats.Add(new PlayStartEntry("tv", "early", null, 1500, 1400));

        var summary = stats.Summarize();
        Assert.Equal(4, summary.Count);
        Assert.Equal(3, summary.WarmKnown);
        Assert.Equal(0.6667, summary.WarmHitRate);
        Assert.Equal(new[] { "tv/early", "web/fresh", "web/prewarmed" }, summary.Groups.Select(g => g.Client + "/" + g.From).ToArray());

        var webFresh = summary.Groups.Single(g => g.Client == "web" && g.From == "fresh");
        Assert.Equal(2, webFresh.Count);
        Assert.Equal(0.5, webFresh.WarmHitRate);
        Assert.Equal(2000, webFresh.TotalMs.P50);
        Assert.Equal(4000, webFresh.TotalMs.P90);
        Assert.Equal(1, webFresh.FirstFrameMs.Count);
        Assert.Equal(3800, webFresh.FirstFrameMs.P50);

        Assert.Null(summary.Groups.Single(g => g.Client == "tv").WarmHitRate);
    }

    [Fact]
    public void Summary_OfNothing_IsEmpty()
    {
        var summary = new PlayStartStats().Summarize();
        Assert.Equal(0, summary.Count);
        Assert.Null(summary.WarmHitRate);
        Assert.Empty(summary.Groups);
        Assert.Equal(1000, summary.Capacity);
    }
}
