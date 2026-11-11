using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Friends;

public static class FriendNotificationKinds
{
    public const string FriendRequest = "friend_request";
    public const string FriendAccepted = "friend_accepted";
    public const string WatchlistAdded = "watchlist_added";
}

// Pure list edits for the friend notifications, applied inside NotificationStore.Update.
public static class FriendNotifications
{
    public static readonly TimeSpan MergeWindow = TimeSpan.FromMinutes(10);

    public static string RequestId(string requestId) => "friendreq:" + requestId;

    public static void AddFriendRequest(
        List<WatchlistNotification> list, string requestId, Guid from, string fromName, string? fromImageTag, DateTime now)
    {
        var id = RequestId(requestId);
        if (list.Any(n => n.Id == id))
        {
            return;
        }

        list.Insert(0, new WatchlistNotification(
            id, Guid.Empty, fromName, "User", now, FriendNotificationKinds.FriendRequest, requestId, now, false,
            FromUserId: from.ToString("N"), FromUserName: fromName, FromImageTag: fromImageTag));
    }

    public static bool RemoveFriendRequest(List<WatchlistNotification> list, string requestId) =>
        list.RemoveAll(n => n.Id == RequestId(requestId)) > 0;

    public static void AddFriendAccepted(
        List<WatchlistNotification> list, string requestId, Guid from, string fromName, string? fromImageTag, DateTime now)
    {
        var id = "friendok:" + requestId;
        list.RemoveAll(n => n.Id == id);
        list.Insert(0, new WatchlistNotification(
            id, Guid.Empty, fromName, "User", now, FriendNotificationKinds.FriendAccepted, requestId, now, false,
            FromUserId: from.ToString("N"), FromUserName: fromName, FromImageTag: fromImageTag));
    }

    // Merges into the newest unread watchlist_added from the same sender when it
    // is at most ten minutes old; returns the resulting count.
    public static int AddWatchlistAdded(
        List<WatchlistNotification> list, Guid from, string fromName, string? fromImageTag,
        Guid itemId, string itemName, string itemType, DateTime now)
    {
        var fromKey = from.ToString("N");
        var existingIndex = list.FindIndex(n =>
            n.Kind == FriendNotificationKinds.WatchlistAdded
            && !n.Read
            && string.Equals(n.FromUserId, fromKey, StringComparison.OrdinalIgnoreCase));

        var count = 1;
        string id;
        if (existingIndex >= 0 && now - list[existingIndex].Date <= MergeWindow)
        {
            var existing = list[existingIndex];
            count = (int.TryParse(existing.Detail, out var previous) ? previous : 1) + 1;
            id = existing.Id;
            list.RemoveAt(existingIndex);
        }
        else
        {
            id = "wladd:" + fromKey + ":" + now.Ticks;
        }

        list.Insert(0, new WatchlistNotification(
            id, itemId, itemName, itemType, now, FriendNotificationKinds.WatchlistAdded,
            count.ToString(System.Globalization.CultureInfo.InvariantCulture), now, false,
            FromUserId: fromKey, FromUserName: fromName, FromImageTag: fromImageTag));
        return count;
    }
}
