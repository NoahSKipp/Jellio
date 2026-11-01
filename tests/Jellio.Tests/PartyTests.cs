using Jellio.Services;
using Jellio.Services.Parties;
using Xunit;

namespace Jellio.Tests;

public class PartyTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "jellio-party-" + Guid.NewGuid().ToString("N"));
    private readonly PartyService _parties;
    private readonly Guid _host = Guid.NewGuid();
    private readonly Guid _guest = Guid.NewGuid();

    public PartyTests()
    {
        _parties = new PartyService(StreamLinkStoreTestsPaths.Create(_dir));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    [Fact]
    public void FirstCallerHostsAndGetsACode()
    {
        var group = Guid.NewGuid();
        var meta = _parties.Ensure(group, _host, "noah", "Movie night");
        var again = _parties.Ensure(group, _guest, "mia", "Movie night");

        Assert.Same(meta, again);
        Assert.True(_parties.IsHost(meta, _host));
        Assert.False(_parties.IsHost(meta, _guest));
        Assert.Equal(6, meta.Code.Length);
        Assert.Equal(group, _parties.ResolveCode(_guest, meta.Code.ToLowerInvariant()));
        Assert.Equal(2, meta.Attendees.Count);
    }

    [Fact]
    public void PrivatePartiesAdmitOnlyHostAttendeesAndThoseLetIn()
    {
        var group = Guid.NewGuid();
        var meta = _parties.Ensure(group, _host, "noah", "Movie night");
        _parties.Configure(meta, true, null, null);
        var stranger = Guid.NewGuid();

        Assert.True(_parties.IsAdmitted(meta, _host));
        Assert.False(_parties.IsAdmitted(meta, stranger));
        _parties.Admit(group, stranger);
        Assert.True(_parties.IsAdmitted(meta, stranger));
    }

    [Fact]
    public void WrongCodesAreThrottledPerUser()
    {
        _parties.Ensure(Guid.NewGuid(), _host, "noah", "x");
        for (var i = 0; i < 10; i++)
        {
            Assert.Null(_parties.ResolveCode(_guest, "ZZZZZZ"));
        }

        Assert.True(_parties.IsCodeThrottled(_guest));
        Assert.False(_parties.IsCodeThrottled(_host));
    }

    [Fact]
    public void ANewTitleResetsTheReadyCheckAndTheCountdownRunsOnce()
    {
        var meta = _parties.Ensure(Guid.NewGuid(), _host, "noah", "x");
        _parties.SetReady(meta, _guest, "mia", "pl1", true);
        var ends = _parties.StartCountdown(meta, "pl1", 5);
        Assert.Equal(ends, _parties.StartCountdown(meta, "pl1", 5));
        Assert.Single(meta.Ready);

        _parties.SetItem(meta, Guid.NewGuid());
        Assert.Empty(meta.Ready);
        Assert.Null(meta.CountdownEndsAt);
    }

    [Fact]
    public void EndingWritesASummaryOnlyWhenPeopleWatchedTogether()
    {
        var solo = _parties.Ensure(Guid.NewGuid(), _host, "noah", "Solo");
        _parties.SetItem(solo, Guid.NewGuid());
        Assert.Null(_parties.End(solo.GroupId));

        var together = _parties.Ensure(Guid.NewGuid(), _host, "noah", "Friday");
        _parties.MarkSeen(together, _guest, "mia");
        _parties.SetItem(together, Guid.NewGuid());
        _parties.CountReaction(together.GroupId, "😂");
        _parties.CountReaction(together.GroupId, "😂");
        _parties.CountReaction(together.GroupId, "🔥");

        var summary = _parties.End(together.GroupId);
        Assert.NotNull(summary);
        Assert.Equal(new[] { "noah", "mia" }, summary!.Members);
        Assert.Equal(new[] { "😂", "🔥" }, summary.TopReactions);
        Assert.Single(_parties.Summaries());
        Assert.Null(_parties.Get(together.GroupId));
        Assert.Null(_parties.End(together.GroupId));
    }

    [Fact]
    public void PrivateSchedulesShowOnlyToTheirPeople()
    {
        var party = _parties.AddSchedule(new ScheduledParty
        {
            Name = "Secret",
            HostUserId = _host,
            StartsAt = DateTime.UtcNow.AddHours(1),
            Private = true,
            InviteeUserIds = [_guest],
        });

        Assert.True(PartyService.CanSee(party, _host));
        Assert.True(PartyService.CanSee(party, _guest));
        Assert.False(PartyService.CanSee(party, Guid.NewGuid()));
        Assert.NotNull(_parties.UpdateSchedule(party.Id, p => p.Going[_guest] = "mia"));
        Assert.True(_parties.RemoveSchedule(party.Id));
        Assert.Empty(_parties.Schedules());
    }

    [Theory]
    [InlineData("😂", true)]
    [InlineData("❤️", true)]
    [InlineData("👍🏽", true)]
    [InlineData("lol", false)]
    [InlineData("😂 lol", false)]
    [InlineData("", false)]
    public void RecognisesReactions(string text, bool expected)
    {
        Assert.Equal(expected, GroupWatchChatService.IsReaction(text));
    }
}
