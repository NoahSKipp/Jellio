using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Friends;

public static class WatchlistAddResults
{
    public const string Added = "added";
    public const string AlreadyOnList = "already_on_list";
    public const string AlreadyWatched = "already_watched";
    public const string NotVisible = "not_visible";
    public const string Muted = "muted";
    public const string Disabled = "disabled";
    public const string Limit = "limit";
    public const string NotFriends = "not_friends";
    public const string Unsupported = "unsupported";
}

public record WatchlistAddFacts(
    bool Supported,
    bool AreFriends,
    bool MutedByRecipient,
    bool RecipientAllows,
    bool Visible,
    bool OnList,
    bool Watched,
    bool RateLimited
);

public static class WatchlistAddRules
{
    public static string Decide(WatchlistAddFacts f)
    {
        if (!f.Supported) return WatchlistAddResults.Unsupported;
        if (!f.AreFriends) return WatchlistAddResults.NotFriends;
        if (f.MutedByRecipient) return WatchlistAddResults.Muted;
        if (!f.RecipientAllows) return WatchlistAddResults.Disabled;
        if (!f.Visible) return WatchlistAddResults.NotVisible;
        if (f.OnList) return WatchlistAddResults.AlreadyOnList;
        if (f.Watched) return WatchlistAddResults.AlreadyWatched;
        if (f.RateLimited) return WatchlistAddResults.Limit;
        return WatchlistAddResults.Added;
    }
}

// In-memory sliding windows: 10 per friend per hour, 50 per day per sender.
public class WatchlistAddRateLimiter
{
    public const int PerFriendPerHour = 10;
    public const int PerSenderPerDay = 50;

    private readonly object _lock = new();
    private readonly Dictionary<(Guid Sender, Guid Recipient), List<DateTime>> _perFriend = new();
    private readonly Dictionary<Guid, List<DateTime>> _perSender = new();

    public bool IsLimited(Guid sender, Guid recipient, DateTime now)
    {
        lock (_lock)
        {
            var perFriend = Recent(_perFriend, (sender, recipient), now - TimeSpan.FromHours(1));
            var perSender = Recent(_perSender, sender, now - TimeSpan.FromDays(1));
            return perFriend >= PerFriendPerHour || perSender >= PerSenderPerDay;
        }
    }

    public void Record(Guid sender, Guid recipient, DateTime now)
    {
        lock (_lock)
        {
            Add(_perFriend, (sender, recipient), now);
            Add(_perSender, sender, now);
        }
    }

    private static int Recent<TKey>(Dictionary<TKey, List<DateTime>> map, TKey key, DateTime since)
        where TKey : notnull
    {
        if (!map.TryGetValue(key, out var list))
        {
            return 0;
        }

        list.RemoveAll(t => t < since);
        if (list.Count == 0)
        {
            map.Remove(key);
        }

        return list.Count;
    }

    private static void Add<TKey>(Dictionary<TKey, List<DateTime>> map, TKey key, DateTime now)
        where TKey : notnull
    {
        if (!map.TryGetValue(key, out var list))
        {
            list = [];
            map[key] = list;
        }

        list.Add(now);
    }
}
