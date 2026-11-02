using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record JoinSyncEntry(Guid UserId, string UserName, Guid PlaylistItemId, DateTime StartedUtc);

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
            RemoveIfEmpty(groupId, group);
        }
    }

    public IReadOnlyList<JoinSyncEntry> Get(Guid groupId, Guid playlistItemId)
    {
        if (!_entriesByGroup.TryGetValue(groupId, out var group))
        {
            return Array.Empty<JoinSyncEntry>();
        }

        var cutoff = DateTime.UtcNow.AddSeconds(-MaxAgeSeconds);
        foreach (var entry in group)
        {
            if (entry.Value.StartedUtc < cutoff)
            {
                group.TryRemove(entry.Key, out _);
            }
        }

        RemoveIfEmpty(groupId, group);

        return group.Values
            .Where(e => e.PlaylistItemId == playlistItemId)
            .ToList();
    }

    private void RemoveIfEmpty(Guid groupId, ConcurrentDictionary<Guid, JoinSyncEntry> group)
    {
        if (group.IsEmpty)
        {
            _entriesByGroup.TryRemove(new KeyValuePair<Guid, ConcurrentDictionary<Guid, JoinSyncEntry>>(groupId, group));
        }
    }
}
