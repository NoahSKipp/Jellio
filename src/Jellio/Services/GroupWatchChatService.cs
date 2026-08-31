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

    // Real bug, audit-found: _messagesByGroup below kept one permanent
    // entry per real GroupId ever created, for the life of this
    // plugin's own process, MaxMessagesPerGroup only ever capping a
    // real still-active room's own history, not evicting a real
    // finished or simply abandoned one at all. A real message's own
    // Timestamp already tells this how stale its own group is, no
    // second real field needed to track that separately. Swept
    // opportunistically on every real Add() rather than a dedicated
    // background loop just for this: SyncPlay groups get created
    // continuously, but never in numbers large enough at this real
    // friends-only scale for a full real scan here to actually cost
    // anything worth a timer of its own.
    private static readonly TimeSpan StaleGroupAge = TimeSpan.FromHours(24);

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

        SweepStaleGroups();
        return message;
    }

    private void SweepStaleGroups()
    {
        var cutoff = DateTime.UtcNow - StaleGroupAge;
        foreach (var (groupId, list) in _messagesByGroup)
        {
            DateTime lastActivity;
            lock (list)
            {
                if (list.Count == 0)
                {
                    continue;
                }

                lastActivity = list[^1].Timestamp;
            }

            if (lastActivity < cutoff)
            {
                _messagesByGroup.TryRemove(new KeyValuePair<Guid, List<GroupWatchChatMessage>>(groupId, list));
            }
        }
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
