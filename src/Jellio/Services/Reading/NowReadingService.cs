using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Reading;

public record NowReadingEntry(
    Guid UserId,
    string UserName,
    string ItemId,
    string Kind,
    string Title,
    string? SeriesTitle,
    int? MangaId,
    int? Page,
    int? PageCount,
    DateTimeOffset SeenAt);

/// <summary>
/// Who's reading what right now, for Now Playing: reading isn't a Jellyfin
/// playback session, so the reader checks in while a book or chapter is
/// open and an entry lapses when it stops.
/// </summary>
public class NowReadingService
{
    private static readonly TimeSpan Expiry = TimeSpan.FromSeconds(90);

    private readonly ConcurrentDictionary<(Guid UserId, string ItemId), NowReadingEntry> _entries = new();

    public void Report(NowReadingEntry entry)
    {
        // One thing at a time per reader: opening the next chapter replaces
        // the last one.
        foreach (var key in _entries.Keys.Where(key => key.UserId == entry.UserId && key.ItemId != entry.ItemId).ToList())
        {
            _entries.TryRemove(key, out _);
        }

        _entries[(entry.UserId, entry.ItemId)] = entry;
    }

    public void Clear(Guid userId, string itemId) => _entries.TryRemove((userId, itemId), out _);

    public IReadOnlyList<NowReadingEntry> Current()
    {
        var cutoff = DateTimeOffset.UtcNow - Expiry;
        foreach (var stale in _entries.Where(pair => pair.Value.SeenAt < cutoff).Select(pair => pair.Key).ToList())
        {
            _entries.TryRemove(stale, out _);
        }

        return _entries.Values.OrderByDescending(entry => entry.SeenAt).ToList();
    }
}
