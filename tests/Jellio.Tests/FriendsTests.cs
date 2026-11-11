using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellio.Services;
using Jellio.Services.Friends;
using Xunit;

namespace Jellio.Tests;

public class FriendsGraphTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private readonly Guid _a = Guid.NewGuid();
    private readonly Guid _b = Guid.NewGuid();
    private readonly FriendsData _data = new();

    [Fact]
    public void SendThenAcceptMakesSymmetricFriends()
    {
        var sent = FriendsGraph.Send(_data, _a, _b, T0);
        Assert.Equal(SendOutcome.Sent, sent.Outcome);
        Assert.Equal("outgoing", FriendsGraph.StatusFor(_data, _a, _b).Status);
        Assert.Equal("incoming", FriendsGraph.StatusFor(_data, _b, _a).Status);
        Assert.Equal(sent.Request!.Id, FriendsGraph.StatusFor(_data, _b, _a).RequestId);

        Assert.Equal(RespondOutcome.Done, FriendsGraph.Accept(_data, sent.Request.Id, _b, T0).Outcome);
        Assert.Equal("friends", FriendsGraph.StatusFor(_data, _a, _b).Status);
        Assert.Equal("friends", FriendsGraph.StatusFor(_data, _b, _a).Status);
        Assert.Empty(_data.Requests);
    }

    [Fact]
    public void OnlyTheRecipientCanAcceptOrDecline()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        Assert.Equal(RespondOutcome.NotFound, FriendsGraph.Accept(_data, id, _a, T0).Outcome);
        Assert.Equal(RespondOutcome.NotFound, FriendsGraph.Decline(_data, id, _a, T0).Outcome);
        Assert.Equal(RespondOutcome.NotFound, FriendsGraph.Cancel(_data, id, _b).Outcome);
    }

    [Fact]
    public void SendingTwiceIsAlreadyPending()
    {
        FriendsGraph.Send(_data, _a, _b, T0);
        Assert.Equal(SendOutcome.AlreadyPending, FriendsGraph.Send(_data, _a, _b, T0).Outcome);
        Assert.Single(_data.Requests);
    }

    [Fact]
    public void SendingToSelfOrAFriendIsRejected()
    {
        Assert.Equal(SendOutcome.Self, FriendsGraph.Send(_data, _a, _a, T0).Outcome);
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        FriendsGraph.Accept(_data, id, _b, T0);
        Assert.Equal(SendOutcome.AlreadyFriends, FriendsGraph.Send(_data, _b, _a, T0).Outcome);
    }

    [Fact]
    public void MutualRequestAutoAccepts()
    {
        FriendsGraph.Send(_data, _a, _b, T0);
        var result = FriendsGraph.Send(_data, _b, _a, T0);
        Assert.Equal(SendOutcome.AutoAccepted, result.Outcome);
        Assert.Equal("friends", FriendsGraph.StatusFor(_data, _a, _b).Status);
        Assert.Empty(_data.Requests);
    }

    [Fact]
    public void DeclineBlocksTheSenderFor24HoursOnly()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        Assert.Equal(RespondOutcome.Done, FriendsGraph.Decline(_data, id, _b, T0).Outcome);
        Assert.Equal("none", FriendsGraph.StatusFor(_data, _a, _b).Status);

        Assert.Equal(SendOutcome.Cooldown, FriendsGraph.Send(_data, _a, _b, T0.AddHours(23)).Outcome);
        Assert.False(FriendsGraph.CanRequest(_data, _a, _b, T0.AddHours(23)));
        // The decliner is not blocked from asking.
        Assert.Equal(SendOutcome.Sent, FriendsGraph.Send(_data, _b, _a, T0.AddHours(23)).Outcome);

        var data2 = new FriendsData();
        var id2 = FriendsGraph.Send(data2, _a, _b, T0).Request!.Id;
        FriendsGraph.Decline(data2, id2, _b, T0);
        Assert.Equal(SendOutcome.Sent, FriendsGraph.Send(data2, _a, _b, T0.AddHours(24)).Outcome);
        Assert.Empty(data2.Declines);
    }

    [Fact]
    public void CancelRemovesTheOutgoingRequest()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        Assert.Equal(RespondOutcome.Done, FriendsGraph.Cancel(_data, id, _a).Outcome);
        Assert.Equal("none", FriendsGraph.StatusFor(_data, _b, _a).Status);
        Assert.Empty(_data.Declines);
        Assert.Equal(SendOutcome.Sent, FriendsGraph.Send(_data, _a, _b, T0).Outcome);
    }

    [Fact]
    public void RemoveEndsTheFriendshipForBoth()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        FriendsGraph.Accept(_data, id, _b, T0);
        Assert.True(FriendsGraph.Remove(_data, _b, _a));
        Assert.Equal("none", FriendsGraph.StatusFor(_data, _a, _b).Status);
        Assert.False(FriendsGraph.Remove(_data, _a, _b));
    }

    [Fact]
    public void MuteIsPerDirection()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        FriendsGraph.Accept(_data, id, _b, T0);
        Assert.True(FriendsGraph.SetMuted(_data, _b, _a, true));
        Assert.True(FriendsGraph.IsMuted(_data, _b, _a));
        Assert.False(FriendsGraph.IsMuted(_data, _a, _b));
        FriendsGraph.SetMuted(_data, _b, _a, false);
        Assert.False(FriendsGraph.IsMuted(_data, _b, _a));
        Assert.False(FriendsGraph.SetMuted(_data, _a, Guid.NewGuid(), true));
    }

    [Fact]
    public void PendingOutgoingLimitIsEnforced()
    {
        for (var i = 0; i < FriendsGraph.MaxPendingOutgoing; i++)
        {
            Assert.Equal(SendOutcome.Sent, FriendsGraph.Send(_data, _a, Guid.NewGuid(), T0).Outcome);
        }

        Assert.Equal(SendOutcome.PendingLimit, FriendsGraph.Send(_data, _a, Guid.NewGuid(), T0).Outcome);
    }

    [Fact]
    public void FriendLimitIsEnforcedOnSendAndAccept()
    {
        for (var i = 0; i < FriendsGraph.MaxFriends; i++)
        {
            _data.Friendships.Add(new Friendship { UserA = _a, UserB = Guid.NewGuid(), Since = T0 });
        }

        Assert.Equal(SendOutcome.FriendLimit, FriendsGraph.Send(_data, _a, _b, T0).Outcome);

        _data.Requests.Add(new FriendRequest { Id = "r1", From = _b, To = _a, At = T0 });
        Assert.Equal(RespondOutcome.FriendLimit, FriendsGraph.Accept(_data, "r1", _a, T0).Outcome);
        Assert.Single(_data.Requests);
    }

    [Fact]
    public void StatusForSelfAndUnknown()
    {
        Assert.Equal("self", FriendsGraph.StatusFor(_data, _a, _a).Status);
        Assert.Equal("none", FriendsGraph.StatusFor(_data, _a, _b).Status);
        Assert.True(FriendsGraph.CanRequest(_data, _a, _b, T0));
        Assert.False(FriendsGraph.CanRequest(_data, _a, _a, T0));
    }

    [Fact]
    public void DataRoundTripsThroughJson()
    {
        var id = FriendsGraph.Send(_data, _a, _b, T0).Request!.Id;
        FriendsGraph.Send(_data, _a, Guid.NewGuid(), T0);
        FriendsGraph.Accept(_data, id, _b, T0);
        var back = JsonSerializer.Deserialize<FriendsData>(JsonSerializer.Serialize(_data))!;
        Assert.Equal("friends", FriendsGraph.StatusFor(back, _a, _b).Status);
        Assert.Single(back.Requests);
    }
}

public class WatchlistAddRulesTests
{
    private static WatchlistAddFacts Ok => new(true, true, false, true, true, false, false, false);

    [Fact]
    public void AddsWhenEverythingIsFine() =>
        Assert.Equal("added", WatchlistAddRules.Decide(Ok));

    [Fact]
    public void EachBlockerMapsToItsResult()
    {
        Assert.Equal("unsupported", WatchlistAddRules.Decide(Ok with { Supported = false }));
        Assert.Equal("not_friends", WatchlistAddRules.Decide(Ok with { AreFriends = false }));
        Assert.Equal("muted", WatchlistAddRules.Decide(Ok with { MutedByRecipient = true }));
        Assert.Equal("disabled", WatchlistAddRules.Decide(Ok with { RecipientAllows = false }));
        Assert.Equal("not_visible", WatchlistAddRules.Decide(Ok with { Visible = false }));
        Assert.Equal("already_on_list", WatchlistAddRules.Decide(Ok with { OnList = true }));
        Assert.Equal("already_watched", WatchlistAddRules.Decide(Ok with { Watched = true }));
        Assert.Equal("limit", WatchlistAddRules.Decide(Ok with { RateLimited = true }));
    }

    [Fact]
    public void PrecedenceIsStable()
    {
        Assert.Equal("unsupported", WatchlistAddRules.Decide(new(false, false, true, false, false, true, true, true)));
        Assert.Equal("not_friends", WatchlistAddRules.Decide(new(true, false, true, false, false, true, true, true)));
        Assert.Equal("muted", WatchlistAddRules.Decide(new(true, true, true, false, false, true, true, true)));
        Assert.Equal("disabled", WatchlistAddRules.Decide(new(true, true, false, false, false, true, true, true)));
        Assert.Equal("not_visible", WatchlistAddRules.Decide(new(true, true, false, true, false, true, true, true)));
        Assert.Equal("already_on_list", WatchlistAddRules.Decide(new(true, true, false, true, true, true, true, true)));
        Assert.Equal("already_watched", WatchlistAddRules.Decide(new(true, true, false, true, true, false, true, true)));
    }

    [Fact]
    public void RateLimiterEnforcesPerFriendHourAndPerSenderDay()
    {
        var limiter = new WatchlistAddRateLimiter();
        var sender = Guid.NewGuid();
        var friend = Guid.NewGuid();
        var t = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        for (var i = 0; i < WatchlistAddRateLimiter.PerFriendPerHour; i++)
        {
            Assert.False(limiter.IsLimited(sender, friend, t));
            limiter.Record(sender, friend, t);
        }

        Assert.True(limiter.IsLimited(sender, friend, t.AddMinutes(59)));
        Assert.False(limiter.IsLimited(sender, Guid.NewGuid(), t.AddMinutes(59)));
        Assert.False(limiter.IsLimited(sender, friend, t.AddMinutes(61)));

        // Fill the daily budget across other friends.
        var later = t.AddHours(2);
        for (var i = 0; i < WatchlistAddRateLimiter.PerSenderPerDay - WatchlistAddRateLimiter.PerFriendPerHour; i++)
        {
            limiter.Record(sender, Guid.NewGuid(), later);
        }

        Assert.True(limiter.IsLimited(sender, Guid.NewGuid(), later));
        Assert.False(limiter.IsLimited(sender, Guid.NewGuid(), t.AddHours(25)));
    }
}

public class FriendNotificationsTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private readonly Guid _from = Guid.NewGuid();

    [Fact]
    public void FirstAddCreatesAndSecondWithinTenMinutesMerges()
    {
        var list = new List<WatchlistNotification>();
        var m1 = Guid.NewGuid();
        var m2 = Guid.NewGuid();
        Assert.Equal(1, FriendNotifications.AddWatchlistAdded(list, _from, "Al", "tag", m1, "One", "Movie", T0));
        Assert.Equal(2, FriendNotifications.AddWatchlistAdded(list, _from, "Al", "tag", m2, "Two", "Series", T0.AddMinutes(9)));

        var n = Assert.Single(list);
        Assert.Equal("2", n.Detail);
        Assert.Equal(m2, n.ItemId);
        Assert.Equal("Two", n.Name);
        Assert.StartsWith("wladd:" + _from.ToString("N") + ":", n.Id);
        Assert.Equal(_from.ToString("N"), n.FromUserId);
        Assert.False(n.Read);
    }

    [Fact]
    public void MergeKeepsTheSameIdAndWindowSlides()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "A", "Movie", T0);
        var id = list[0].Id;
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "B", "Movie", T0.AddMinutes(8));
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "C", "Movie", T0.AddMinutes(16));
        Assert.Single(list);
        Assert.Equal(id, list[0].Id);
        Assert.Equal("3", list[0].Detail);
    }

    [Fact]
    public void AfterTenMinutesOrWhenReadOrFromAnotherSenderItStartsANewOne()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "A", "Movie", T0);
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "B", "Movie", T0.AddMinutes(11));
        Assert.Equal(2, list.Count);
        Assert.Equal("1", list[0].Detail);

        list[0] = list[0] with { Read = true };
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "C", "Movie", T0.AddMinutes(12));
        Assert.Equal(3, list.Count);

        FriendNotifications.AddWatchlistAdded(list, Guid.NewGuid(), "Bo", null, Guid.NewGuid(), "D", "Movie", T0.AddMinutes(12));
        Assert.Equal(4, list.Count);
    }

    [Fact]
    public void MergedNotificationMovesToTheTopAndLeavesOthersAlone()
    {
        var calendar = new WatchlistNotification("x:2026", Guid.NewGuid(), "Show", "Series", T0, "episode", null, T0, false);
        var list = new List<WatchlistNotification> { calendar };
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "A", "Movie", T0);
        list.Insert(0, calendar with { Id = "y:2026" });
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "B", "Movie", T0.AddMinutes(1));
        Assert.Equal(3, list.Count);
        Assert.Equal("watchlist_added", list[0].Kind);
        Assert.Contains(list, n => n.Id == "x:2026");
    }

    [Fact]
    public void FriendRequestIsAddedOnceAndRemovedById()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddFriendRequest(list, "rid", _from, "Al", null, T0);
        FriendNotifications.AddFriendRequest(list, "rid", _from, "Al", null, T0);
        var n = Assert.Single(list);
        Assert.Equal("friendreq:rid", n.Id);
        Assert.Equal("friend_request", n.Kind);
        Assert.Equal("rid", n.Detail);
        Assert.True(FriendNotifications.RemoveFriendRequest(list, "rid"));
        Assert.False(FriendNotifications.RemoveFriendRequest(list, "rid"));
    }

    [Fact]
    public void FriendAcceptedUsesTheContractId()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddFriendAccepted(list, "rid", _from, "Al", "t", T0);
        Assert.Equal("friendok:rid", list[0].Id);
        Assert.Equal("friend_accepted", list[0].Kind);
        Assert.Equal("Al", list[0].FromUserName);
        Assert.Equal("t", list[0].FromImageTag);
    }

    [Fact]
    public void OldStoredJsonStillLoads()
    {
        const string old = """
            [{"Id":"abc:2026-01-01","ItemId":"11111111-1111-1111-1111-111111111111","Name":"Show","Type":"Series",
              "Date":"2026-01-01T00:00:00Z","Kind":"episode","Detail":"S1E2","CreatedUtc":"2026-01-01T00:00:00Z","Read":false}]
            """;
        var list = JsonSerializer.Deserialize<List<WatchlistNotification>>(old)!;
        var n = Assert.Single(list);
        Assert.Null(n.FromUserId);
        Assert.Null(n.FromUserName);
        Assert.Null(n.FromImageTag);
        Assert.Equal("S1E2", n.Detail);
    }

    [Fact]
    public void NewFieldsRoundTrip()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", "tg", Guid.NewGuid(), "A", "Movie", T0);
        var back = JsonSerializer.Deserialize<List<WatchlistNotification>>(JsonSerializer.Serialize(list))!;
        Assert.Equal("Al", back[0].FromUserName);
        Assert.Equal("tg", back[0].FromImageTag);
    }
}

public class AddedByTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void KeepsNewestFirstMaxThreeAndDedupesSender()
    {
        var map = new Dictionary<string, List<AddedByEntry>>();
        var item = Guid.NewGuid();
        var s1 = Guid.NewGuid();
        var s2 = Guid.NewGuid();
        var s3 = Guid.NewGuid();
        var s4 = Guid.NewGuid();
        AddedByLogic.Record(map, item, s1, T0);
        AddedByLogic.Record(map, item, s2, T0.AddMinutes(1));
        AddedByLogic.Record(map, item, s3, T0.AddMinutes(2));
        AddedByLogic.Record(map, item, s4, T0.AddMinutes(3));
        var list = map[AddedByLogic.Key(item)];
        Assert.Equal([s4, s3, s2], list.Select(e => e.FromUserId));

        AddedByLogic.Record(map, item, s2, T0.AddMinutes(4));
        Assert.Equal([s2, s4, s3], map[AddedByLogic.Key(item)].Select(e => e.FromUserId));
    }

    [Fact]
    public void RemoveItemDropsTheEntry()
    {
        var map = new Dictionary<string, List<AddedByEntry>>();
        var item = Guid.NewGuid();
        AddedByLogic.Record(map, item, Guid.NewGuid(), T0);
        Assert.True(AddedByLogic.RemoveItem(map, item));
        Assert.False(AddedByLogic.RemoveItem(map, item));
        Assert.Empty(map);
    }

    [Fact]
    public void RemoveSenderDropsOnlyThatSenderAndEmptyItems()
    {
        var map = new Dictionary<string, List<AddedByEntry>>();
        var shared = Guid.NewGuid();
        var solo = Guid.NewGuid();
        var s1 = Guid.NewGuid();
        var s2 = Guid.NewGuid();
        AddedByLogic.Record(map, shared, s1, T0);
        AddedByLogic.Record(map, shared, s2, T0);
        AddedByLogic.Record(map, solo, s1, T0);
        Assert.True(AddedByLogic.RemoveSender(map, s1));
        Assert.Single(map[AddedByLogic.Key(shared)]);
        Assert.False(map.ContainsKey(AddedByLogic.Key(solo)));
        Assert.False(AddedByLogic.RemoveSender(map, s1));
    }
}
