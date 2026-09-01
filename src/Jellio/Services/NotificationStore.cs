using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

public record WatchlistNotification(
    string Id,
    Guid ItemId,
    string Name,
    string Type,
    DateTime Date,
    string Kind,
    string? Detail,
    DateTime CreatedUtc,
    bool Read
);

// Real per user watchlist release notifications, one plain JSON array per
// user id, same JsonUserStore one-file-per-user-id shape everything else
// in this plugin's own data directory already uses.
public class NotificationStore(IApplicationPaths applicationPaths)
{
    // Same real cap AchievementService.MaxRecentActivity already uses for
    // the identical real "keep a real backlog, not an unbounded one"
    // reason: a watchlist release notification added once per item per
    // real day, and an admin broadcast appended into every real user's
    // own file, would otherwise grow forever. Newest first (index 0), so
    // trimming the tail below drops the real oldest entries, never the
    // ones a reader has not looked at yet. Enforced here rather than left
    // to every caller to remember, the same real bug this whole
    // consolidation exists to close off for good.
    private const int MaxStoredNotifications = 100;

    private readonly JsonUserStore<List<WatchlistNotification>> _store =
        new(applicationPaths, "notifications", () => []);

    public List<WatchlistNotification> Load(Guid userId) => _store.Load(userId);

    public void Save(Guid userId, List<WatchlistNotification> notifications)
    {
        TrimToLimit(notifications);
        _store.Save(userId, notifications);
    }

    public List<WatchlistNotification> Update(Guid userId, Action<List<WatchlistNotification>> mutate) =>
        _store.Update(userId, notifications =>
        {
            mutate(notifications);
            TrimToLimit(notifications);
        });

    private static void TrimToLimit(List<WatchlistNotification> notifications)
    {
        if (notifications.Count > MaxStoredNotifications)
        {
            notifications.RemoveRange(MaxStoredNotifications, notifications.Count - MaxStoredNotifications);
        }
    }
}
