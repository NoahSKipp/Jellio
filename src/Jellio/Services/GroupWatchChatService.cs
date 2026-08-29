using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record GroupWatchChatMessage(long Id, Guid GroupId, Guid UserId, string UserName, string Text, DateTime Timestamp, Guid? ItemId);

/// <summary>
/// Chat for a real Jellyfin SyncPlay group (components/groupWatch.js's own
/// real membership panel), in memory only. Real SyncPlay itself carries no
/// chat of its own, playback commands and group membership events only,
/// confirmed against SyncPlayController.cs before writing this, so there is
/// no existing channel to piggyback a message onto. This runtime also opens
/// no WebSocket of its own at all (screens/player.js's own header explains
/// why), so a real live push here would mean standing one up just for this,
/// a real cost this slice does not need to pay: a small, friends-only room
/// polling every few seconds already reads as instant at that scale.
/// Ephemeral by design, same real tradeoff SleepTimerService's own timers
/// already make: a plugin restart clearing every open room's own chat
/// history is an acceptable cost, a persistence schema for it is not a
/// real need here.
/// </summary>
public class GroupWatchChatService
{
    private const int MaxMessagesPerGroup = 200;

    private readonly ConcurrentDictionary<Guid, List<GroupWatchChatMessage>> _messagesByGroup = new();
    private long _nextId;

    public GroupWatchChatMessage Add(Guid groupId, Guid userId, string userName, string text, Guid? itemId = null)
    {
        var message = new GroupWatchChatMessage(
            System.Threading.Interlocked.Increment(ref _nextId),
            groupId,
            userId,
            userName,
            text,
            DateTime.UtcNow,
            itemId
        );

        var list = _messagesByGroup.GetOrAdd(groupId, _ => new List<GroupWatchChatMessage>());
        lock (list)
        {
            list.Add(message);
            if (list.Count > MaxMessagesPerGroup)
            {
                list.RemoveRange(0, list.Count - MaxMessagesPerGroup);
            }
        }

        return message;
    }

    public IReadOnlyList<GroupWatchChatMessage> Since(Guid groupId, long afterId)
    {
        if (!_messagesByGroup.TryGetValue(groupId, out var list))
        {
            return Array.Empty<GroupWatchChatMessage>();
        }

        lock (list)
        {
            return list.Where(m => m.Id > afterId).ToList();
        }
    }
}
