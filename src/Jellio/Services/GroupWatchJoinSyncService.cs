using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record JoinSyncEntry(Guid UserId, string UserName, Guid PlaylistItemId, DateTime StartedUtc);

/// <summary>
/// Tracks who is still doing their own initial buffer-up for a real
/// SyncPlay group's own current PlaylistItemId (screens/player.js's own
/// isInitialGroupCatchUp), in memory only, same real ephemeral tradeoff
/// GroupWatchChatService's own header already makes for this whole
/// feature area.
///
/// Deliberately separate from real SyncPlay's own Buffering/Ready signal
/// (still sent alongside this, real WaitingGroupState.cs already pauses
/// and holds the group for it, confirmed against real source before this
/// was written): that real signal has no reason attached, every group
/// member's own screen just sees a Pause with nothing explaining it,
/// mid session rebuffering included. This is only the part real SyncPlay
/// has no equivalent for at all, a friendly "waiting for X" reason a
/// reader forced to sit through someone else's slow stream negotiation
/// (a real debrid/usenet source still resolving, well before real
/// SyncPlay's own Buffering signal has anything to react to yet) can
/// actually read.
///
/// A stale entry (a tab closed mid load, never reaching its own Ready)
/// would otherwise sit here forever: Get() below filters anything older
/// than MaxAgeSeconds rather than needing a guaranteed Clear() call from
/// every real exit path first.
/// </summary>
public class GroupWatchJoinSyncService
{
    private const int MaxAgeSeconds = 90;

    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, JoinSyncEntry>> _entriesByGroup = new();

    public void Start(Guid groupId, Guid userId, string userName, Guid playlistItemId)
    {
        var group = _entriesByGroup.GetOrAdd(groupId, _ => new ConcurrentDictionary<Guid, JoinSyncEntry>());
        group[userId] = new JoinSyncEntry(userId, userName, playlistItemId, DateTime.UtcNow);
    }

    public void Clear(Guid groupId, Guid userId)
    {
        if (_entriesByGroup.TryGetValue(groupId, out var group))
        {
            group.TryRemove(userId, out _);
        }
    }

    public IReadOnlyList<JoinSyncEntry> Get(Guid groupId, Guid playlistItemId)
    {
        if (!_entriesByGroup.TryGetValue(groupId, out var group))
        {
            return Array.Empty<JoinSyncEntry>();
        }

        var cutoff = DateTime.UtcNow.AddSeconds(-MaxAgeSeconds);
        return group.Values
            .Where(e => e.PlaylistItemId == playlistItemId && e.StartedUtc >= cutoff)
            .ToList();
    }
}
