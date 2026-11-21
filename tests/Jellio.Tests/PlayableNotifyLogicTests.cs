using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Services;
using Jellio.Services.Reading;
using Xunit;

namespace Jellio.Tests;

public class PlayableNotifyLogicTests
{
    private static readonly DateTime Now = new(2027, 3, 10, 15, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime Today = Now.Date;
    private static readonly HashSet<string> NoKnown = new(StringComparer.OrdinalIgnoreCase);

    private static WatchlistCalendarItem Entry(Guid id, DateTime date, string detail = "S1E1") =>
        new(id, "Show", "Series", date, "episode", detail);

    private static int Discover(PlayableNotifyState state, WatchlistCalendarItem entry, ISet<string>? known = null,
        Dictionary<string, SeriesPrefs>? series = null) =>
        PlayableNotifyLogic.Discover(state, [entry], Today, Now, known ?? NoKnown, series);

    [Fact]
    public void TodayAndEarlierEntriesAreDueButFutureOnesAreNot()
    {
        var state = new PlayableNotifyState();
        Assert.Equal(1, Discover(state, Entry(Guid.NewGuid(), Today)));
        Assert.Equal(1, Discover(state, Entry(Guid.NewGuid(), Today.AddDays(-3))));
        Assert.Equal(0, Discover(state, Entry(Guid.NewGuid(), Today.AddDays(1))));
        Assert.Equal(2, state.Pending.Count);
    }

    [Fact]
    public void IdKeepsTheOldItemAndDateScheme()
    {
        var id = Guid.NewGuid();
        Assert.Equal(id + ":2027-03-10", PlayableNotifyLogic.EntryId(id, Today));
    }

    [Fact]
    public void EntriesAlreadyNotifiedPendingOrSettledAreNotAddedAgain()
    {
        var id = Guid.NewGuid();
        var entry = Entry(id, Today);
        var key = PlayableNotifyLogic.EntryId(id, Today);

        var state = new PlayableNotifyState();
        Assert.Equal(0, Discover(state, entry, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { key.ToUpperInvariant() }));

        Assert.Equal(1, Discover(state, entry));
        Assert.Equal(0, Discover(state, entry));

        state.Pending.Clear();
        state.Settled[key] = Now;
        Assert.Equal(0, Discover(state, entry));
    }

    [Fact]
    public void MutedSeriesAreSkippedInEveryKeyForm()
    {
        var id = Guid.NewGuid();
        foreach (var key in new[] { "s:" + id.ToString("N"), id.ToString("N"), id.ToString() })
        {
            var series = new Dictionary<string, SeriesPrefs> { [key] = new SeriesPrefs { SkipUpdates = true } };
            Assert.Equal(0, Discover(new PlayableNotifyState(), Entry(id, Today), null, series));
        }

        var unmuted = new Dictionary<string, SeriesPrefs> { ["s:" + id.ToString("N")] = new SeriesPrefs { SkipUpdates = false } };
        Assert.Equal(1, Discover(new PlayableNotifyState(), Entry(id, Today), null, unmuted));
    }

    [Fact]
    public void MutingAfterwardsStopsChecksButKeepsThePendingEntry()
    {
        var id = Guid.NewGuid();
        var state = new PlayableNotifyState();
        Discover(state, Entry(id, Today));
        var series = new Dictionary<string, SeriesPrefs> { [id.ToString("N")] = new SeriesPrefs { SkipUpdates = true } };

        Assert.Empty(PlayableNotifyLogic.Due(state, Now, series));
        Assert.Single(PlayableNotifyLogic.Due(state, Now, null));
    }

    [Fact]
    public void AnEntryOlderThanTheWindowIsNeverAdded()
    {
        var state = new PlayableNotifyState();
        Assert.Equal(1, Discover(state, Entry(Guid.NewGuid(), Today.AddDays(-14))));
        Assert.Equal(0, Discover(state, Entry(Guid.NewGuid(), Today.AddDays(-15))));
    }

    [Fact]
    public void PendingEntriesAreGivenUpOnAfterFourteenDays()
    {
        var state = new PlayableNotifyState();
        var kept = Entry(Guid.NewGuid(), Today.AddDays(-14));
        var old = Entry(Guid.NewGuid(), Today.AddDays(-14));
        Discover(state, kept);
        Discover(state, old);
        state.Pending[PlayableNotifyLogic.EntryId(old.ItemId, old.Date)].Date = Today.AddDays(-15);

        var gaveUp = PlayableNotifyLogic.Prune(state, Today, Now, NoKnown);

        Assert.Single(gaveUp);
        Assert.Single(state.Pending);
        Assert.Contains(PlayableNotifyLogic.EntryId(old.ItemId, old.Date), state.Settled.Keys);
    }

    [Fact]
    public void PruneDropsEntriesThatWereNotifiedMeanwhileAndOldSettledIds()
    {
        var id = Guid.NewGuid();
        var state = new PlayableNotifyState();
        Discover(state, Entry(id, Today));
        state.Settled["old"] = Now.AddDays(-61);
        state.Settled["recent"] = Now.AddDays(-5);

        PlayableNotifyLogic.Prune(state, Today, Now, new HashSet<string> { PlayableNotifyLogic.EntryId(id, Today) });

        Assert.Empty(state.Pending);
        Assert.DoesNotContain("old", state.Settled.Keys);
        Assert.Contains("recent", state.Settled.Keys);
    }

    [Fact]
    public void BackoffGrowsAndIsCapped()
    {
        Assert.Equal(TimeSpan.FromMinutes(20), PlayableNotifyLogic.Backoff(1));
        Assert.Equal(TimeSpan.FromHours(1), PlayableNotifyLogic.Backoff(2));
        Assert.Equal(TimeSpan.FromHours(6), PlayableNotifyLogic.Backoff(5));
        Assert.Equal(TimeSpan.FromHours(6), PlayableNotifyLogic.Backoff(500));
        Assert.Equal(TimeSpan.FromMinutes(20), PlayableNotifyLogic.Backoff(0));
    }

    [Fact]
    public void AFailedCheckDelaysTheNextOneUntilTheBackoffPasses()
    {
        var state = new PlayableNotifyState();
        Discover(state, Entry(Guid.NewGuid(), Today));
        var notice = Assert.Single(PlayableNotifyLogic.Due(state, Now, null));

        PlayableNotifyLogic.RecordFailure(notice, Now);

        Assert.Equal(1, notice.Attempts);
        Assert.Empty(PlayableNotifyLogic.Due(state, Now.AddMinutes(19), null));
        Assert.Single(PlayableNotifyLogic.Due(state, Now.AddMinutes(20), null));
    }

    [Fact]
    public void DueEntriesComeOldestFirst()
    {
        var state = new PlayableNotifyState();
        var newer = Entry(Guid.NewGuid(), Today);
        var older = Entry(Guid.NewGuid(), Today.AddDays(-2));
        Discover(state, newer);
        Discover(state, older);

        Assert.Equal(older.ItemId, PlayableNotifyLogic.Due(state, Now, null).First().ItemId);
    }

    [Fact]
    public void CompletingKeepsTheAirDateAndStampsWhenTheStreamWasFound()
    {
        var id = Guid.NewGuid();
        var airDate = Today.AddDays(-2);
        var state = new PlayableNotifyState();
        Discover(state, Entry(id, airDate, "S2E3"));
        var notice = Assert.Single(state.Pending.Values);

        var notification = PlayableNotifyLogic.Complete(state, notice, Now);

        Assert.Equal(id + ":" + airDate.ToString("yyyy-MM-dd"), notification.Id);
        Assert.Equal(airDate, notification.Date);
        Assert.Equal(Now, notification.CreatedUtc);
        Assert.Equal("S2E3", notification.Detail);
        Assert.False(notification.Read);
        Assert.Empty(state.Pending);
        Assert.Contains(notification.Id, state.Settled.Keys);
        Assert.Equal(0, Discover(state, Entry(id, airDate, "S2E3")));
    }

    [Fact]
    public void NegativeResultsStayCachedForTheTtl()
    {
        Assert.True(PlayableNotifyLogic.IsNegativeCacheFresh(Now.AddMinutes(-14), Now));
        Assert.False(PlayableNotifyLogic.IsNegativeCacheFresh(Now.AddMinutes(-15), Now));
    }

    [Fact]
    public void PlaceholderSourcesAreNotPlayable()
    {
        Assert.False(PlayableNotifyLogic.HasPlayableSource(null));
        Assert.False(PlayableNotifyLogic.HasPlayableSource([]));
        Assert.False(PlayableNotifyLogic.HasPlayableSource([new SourceFacts("Show", null, false, false)]));
    }

    [Fact]
    public void SourcesWithStreamInfoArePlayable()
    {
        Assert.True(PlayableNotifyLogic.HasPlayableSource([new SourceFacts("Show", 2_000_000, false, false)]));
        Assert.True(PlayableNotifyLogic.HasPlayableSource([new SourceFacts("Show", null, true, false)]));
        Assert.True(PlayableNotifyLogic.HasPlayableSource([new SourceFacts("Show 1080p WEB-DL", null, false, false)]));
        Assert.True(PlayableNotifyLogic.HasPlayableSource(
            [new SourceFacts("a", null, false, false), new SourceFacts("b", null, false, false)]));
    }
}
