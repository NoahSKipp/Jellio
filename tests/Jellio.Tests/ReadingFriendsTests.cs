using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Jellio.Configuration;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellio.Services.Friends;
using Jellio.Services.Reading;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Xunit;

namespace Jellio.Tests;

public class ReaderAccessTests
{
    [Fact]
    public void FeaturesFollowTheAdminSwitches()
    {
        var config = new PluginConfiguration { BooksEnabled = false, AudiobooksEnabled = true, MangaEnabled = false };
        Assert.False(ReaderAccess.FeatureEnabled(config, "ebook"));
        Assert.True(ReaderAccess.FeatureEnabled(config, "audiobook"));
        Assert.False(ReaderAccess.FeatureEnabled(config, "manga"));
        Assert.True(ReaderAccess.FeatureEnabled(null, "manga"));
    }
}

public class ReadingNotificationTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private readonly Guid _from = Guid.NewGuid();

    [Fact]
    public void ReadingAddCarriesTypeKeyAndMangaId()
    {
        var list = new List<WatchlistNotification>();
        var count = FriendNotifications.AddWatchlistAdded(
            list, _from, "Al", null, Guid.Empty, "Berserk", "Manga", T0, readingKey: "s:berserk", mangaId: 12);
        Assert.Equal(1, count);
        var n = Assert.Single(list);
        Assert.Equal("watchlist_added", n.Kind);
        Assert.Equal("Manga", n.Type);
        Assert.Equal("s:berserk", n.ReadingKey);
        Assert.Equal(12, n.MangaId);
        Assert.Equal("1", n.Detail);
    }

    [Fact]
    public void ReadingAndWatchlistAddsMergeAndTheLatestTitleWins()
    {
        var list = new List<WatchlistNotification>();
        FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "A Movie", "Movie", T0);
        var count = FriendNotifications.AddWatchlistAdded(
            list, _from, "Al", null, Guid.Empty, "Berserk", "Manga", T0.AddMinutes(5), readingKey: "s:berserk");
        Assert.Equal(2, count);
        Assert.Equal("s:berserk", Assert.Single(list).ReadingKey);

        count = FriendNotifications.AddWatchlistAdded(list, _from, "Al", null, Guid.NewGuid(), "Another Movie", "Movie", T0.AddMinutes(8));
        Assert.Equal(3, count);
        var merged = Assert.Single(list);
        Assert.Null(merged.ReadingKey);
        Assert.Equal("Movie", merged.Type);
    }

    [Fact]
    public void OldNotificationsHaveNoReadingKey()
    {
        const string old = """
            [{"Id":"wladd:a:1","ItemId":"11111111-1111-1111-1111-111111111111","Name":"Show","Type":"Series",
              "Date":"2026-01-01T00:00:00Z","Kind":"watchlist_added","Detail":"1","CreatedUtc":"2026-01-01T00:00:00Z","Read":false}]
            """;
        Assert.Null(JsonSerializer.Deserialize<List<WatchlistNotification>>(old)![0].ReadingKey);
    }

    [Fact]
    public void ReadingKindNotificationTypes()
    {
        Assert.Equal("Book", ReadingKinds.NotificationType("ebook"));
        Assert.Equal("AudioBook", ReadingKinds.NotificationType("audiobook"));
        Assert.Equal("Manga", ReadingKinds.NotificationType("manga"));
    }
}

public class ReadingFriendAddTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "jellio-reading-friends-" + Guid.NewGuid().ToString("N"));
    private readonly User _sender = new("sender", "Default", "Default") { Id = Guid.NewGuid() };
    private readonly User _friend = new("friend", "Default", "Default") { Id = Guid.NewGuid() };
    private readonly User _stranger = new("stranger", "Default", "Default") { Id = Guid.NewGuid() };
    private readonly ReadingListStore _readingList;
    private readonly NotificationStore _notifications;
    private readonly ProfileSettingsStore _settings;
    private readonly TestFriendsService _service;

    private class UsersProxy : DispatchProxy
    {
        public Dictionary<Guid, User> Users { get; set; } = [];

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) =>
            targetMethod?.Name == nameof(IUserManager.GetUserById) && args?[0] is Guid id && Users.TryGetValue(id, out var user)
                ? user
                : null;
    }

    // Visibility and the admin config are the two things the real service
    // reads from Jellyfin; tests set them directly.
    private sealed class TestFriendsService(
        FriendsStore store, AddedByStore addedBy, ReadingListStore reading, NotificationStore notifications,
        ProfileSettingsStore settings, IUserManager users)
        : FriendsService(store, addedBy, reading, notifications, settings, users, null!, null!, null!, null!,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<FriendsService>.Instance)
    {
        public PluginConfiguration? Config { get; set; }

        public bool Visible { get; set; } = true;

        protected override PluginConfiguration? ReaderConfig => Config;

        protected override bool CanSeeReadingTarget(User recipient, ReadingTarget target, PluginConfiguration? config) => Visible;
    }

    public ReadingFriendAddTests()
    {
        var paths = TestPaths.Create(_dir);
        var users = DispatchProxy.Create<IUserManager, UsersProxy>();
        ((UsersProxy)(object)users).Users = new[] { _sender, _friend, _stranger }.ToDictionary(u => u.Id);
        _readingList = new ReadingListStore(paths);
        _notifications = new NotificationStore(paths);
        _settings = new ProfileSettingsStore(paths);
        _service = new TestFriendsService(new FriendsStore(paths), new AddedByStore(paths), _readingList, _notifications, _settings, users);

        var request = _service.SendRequest(_sender.Id, _friend.Id);
        _service.Accept(request.Request!.Id, _friend.Id);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, true);
        }
        catch
        {
        }
    }

    private static ReadingTarget Manga(string key = "s:berserk") => new(key, "manga", null, 5, "Berserk", "Miura", null);

    private string AddOne(ReadingTarget? target, User? to = null)
    {
        var result = _service.AddToReadingLists(_sender.Id, target, [(to ?? _friend).Id]);
        return Assert.Single(result).Result;
    }

    [Fact]
    public void AddsToTheFriendsListNotifiesAndRecordsTheSender()
    {
        Assert.Equal("added", AddOne(Manga()));

        var entry = Assert.Single(_readingList.Snapshot(_friend.Id));
        Assert.Equal("s:berserk", entry.Key);
        Assert.Equal(_sender.Id, Assert.Single(entry.AddedBy).FromUserId);
        Assert.Empty(_readingList.Snapshot(_sender.Id));

        var n = Assert.Single(_notifications.Load(_friend.Id));
        Assert.Equal("watchlist_added", n.Kind);
        Assert.Equal("Manga", n.Type);
        Assert.Equal("s:berserk", n.ReadingKey);
        Assert.Equal(5, n.MangaId);
        Assert.Equal(_sender.Id.ToString("N"), n.FromUserId);
    }

    [Fact]
    public void SecondAddIsAlreadyOnListWithoutANotification()
    {
        AddOne(Manga());
        Assert.Equal("already_on_list", AddOne(Manga()));
        Assert.Single(_notifications.Load(_friend.Id));
        Assert.Single(_readingList.Snapshot(_friend.Id));
    }

    [Fact]
    public void ItemKeyKeepsItsItemIdInTheNotification()
    {
        var id = Guid.NewGuid();
        Assert.Equal("added", AddOne(new ReadingTarget("i:" + id.ToString("N"), "audiobook", id.ToString("N"), null, "Dune", "Herbert", null)));
        var n = Assert.Single(_notifications.Load(_friend.Id));
        Assert.Equal(id, n.ItemId);
        Assert.Equal("AudioBook", n.Type);
    }

    [Fact]
    public void NonFriendsAndMissingTargetsAreRefused()
    {
        Assert.Equal("not_friends", AddOne(Manga(), _stranger));
        Assert.Equal("unsupported", AddOne(null));
        Assert.Empty(_readingList.Snapshot(_stranger.Id));
    }

    [Fact]
    public void MuteAndTheFriendsSettingBlock()
    {
        _service.SetMuted(_friend.Id, _sender.Id, true);
        Assert.Equal("muted", AddOne(Manga()));
        _service.SetMuted(_friend.Id, _sender.Id, false);

        _settings.Update(_friend.Id, s => s.FriendsCanAddToWatchlist = false);
        Assert.Equal("disabled", AddOne(Manga()));
        Assert.Empty(_readingList.Snapshot(_friend.Id));
        Assert.Empty(_notifications.Load(_friend.Id));
    }

    [Fact]
    public void ReaderFeatureOffOrNoAccessIsNotVisible()
    {
        _service.Config = new PluginConfiguration { MangaEnabled = false };
        Assert.Equal("not_visible", AddOne(Manga()));
        Assert.Equal("added", AddOne(new ReadingTarget("w:hc:1", "ebook", null, null, "Dune", null, null)));

        _service.Config = null;
        _service.Visible = false;
        Assert.Equal("not_visible", AddOne(Manga("s:other")));
        Assert.Single(_readingList.Snapshot(_friend.Id));
    }

    [Fact]
    public void RateLimitIsTenPerFriendPerHour()
    {
        for (var i = 0; i < WatchlistAddRateLimiter.PerFriendPerHour; i++)
        {
            Assert.Equal("added", AddOne(Manga("s:series " + i)));
        }

        Assert.Equal("limit", AddOne(Manga("s:one more")));
        // A key already on the list is still reported as such, not limited.
        Assert.Equal("already_on_list", AddOne(Manga("s:series 0")));
        Assert.Equal(WatchlistAddRateLimiter.PerFriendPerHour, _readingList.Count(_friend.Id));
    }

    [Fact]
    public void AFullFriendListIsALimit()
    {
        for (var i = 0; i < ReadingListLogic.MaxItems; i++)
        {
            _readingList.Add(_friend.Id, new ReadingTarget("w:hc:" + i, "ebook", null, null, "t", null, null), null, DateTime.UtcNow);
        }

        Assert.Equal("limit", AddOne(Manga()));
        Assert.Equal(ReadingListLogic.MaxItems, _readingList.Count(_friend.Id));
    }

    [Fact]
    public void RemovingTheFriendshipDropsTheirAddedByRecords()
    {
        AddOne(Manga());
        Assert.True(_service.RemoveFriend(_sender.Id, _friend.Id));
        var entry = Assert.Single(_readingList.Snapshot(_friend.Id));
        Assert.Empty(entry.AddedBy);
    }
}
