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
    bool Read,
    string? SeriesKey = null,
    int? MangaId = null,
    // An announcement's picture (Jellio/notifications/image/{ImageId}).
    string? ImageId = null
);

public class NotificationStore(IApplicationPaths applicationPaths)
{
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

    public List<WatchlistNotification> UpdateIfChanged(Guid userId, Func<List<WatchlistNotification>, bool> mutate) =>
        _store.UpdateIfChanged(userId, notifications =>
        {
            if (!mutate(notifications))
            {
                return false;
            }

            TrimToLimit(notifications);
            return true;
        });

    private static void TrimToLimit(List<WatchlistNotification> notifications)
    {
        if (notifications.Count > MaxStoredNotifications)
        {
            notifications.RemoveRange(MaxStoredNotifications, notifications.Count - MaxStoredNotifications);
        }
    }
}
