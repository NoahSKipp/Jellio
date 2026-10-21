using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record GroupWatchInvite(long Id, Guid ToUserId, Guid GroupId, string GroupName, Guid FromUserId, string FromUserName, DateTime Timestamp);

/// <summary>
/// Invites into a real Jellyfin SyncPlay group, in memory only, same real
/// tradeoff GroupWatchChatService's own header already explains: a small
/// friends-only feature, polled every few seconds reads as instant at
/// that scale, no real WebSocket push worth standing up just for this.
/// Keyed by the invited user rather than by group, since a poll here is
/// always "what is waiting for me", never "what happened in group X".
/// </summary>
public class GroupWatchInviteService
{
    private const int MaxPendingPerUser = 20;
    private static readonly TimeSpan InviteLifetime = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<Guid, List<GroupWatchInvite>> _invitesByUser = new();
    // Starts at the current time so ids keep growing across restarts and a
    // client's remembered "last seen" id stays meaningful.
    private long _nextId = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public GroupWatchInvite Add(Guid toUserId, Guid groupId, string groupName, Guid fromUserId, string fromUserName)
    {
        var invite = new GroupWatchInvite(
            System.Threading.Interlocked.Increment(ref _nextId),
            toUserId,
            groupId,
            groupName,
            fromUserId,
            fromUserName,
            DateTime.UtcNow
        );

        var list = _invitesByUser.GetOrAdd(toUserId, _ => new List<GroupWatchInvite>());
        lock (list)
        {
            list.Add(invite);
            if (list.Count > MaxPendingPerUser)
            {
                list.RemoveRange(0, list.Count - MaxPendingPerUser);
            }
        }

        return invite;
    }

    public IReadOnlyList<GroupWatchInvite> Since(Guid userId, long afterId)
    {
        if (!_invitesByUser.TryGetValue(userId, out var list))
        {
            return Array.Empty<GroupWatchInvite>();
        }

        lock (list)
        {
            var cutoff = DateTime.UtcNow - InviteLifetime;
            list.RemoveAll(i => i.Timestamp < cutoff);
            return list.Where(i => i.Id > afterId).ToList();
        }
    }
}
