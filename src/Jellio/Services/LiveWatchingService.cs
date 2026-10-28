using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Jellio.Services;

public record LiveWatchingEntry(
    Guid UserId,
    string UserName,
    string? ChannelId,
    string ChannelName,
    string? Programme,
    string Source,
    string? LogoUrl,
    bool IsPaused,
    string? DeviceName,
    string? Client,
    DateTimeOffset SeenAt);

/// <summary>
/// Who's watching live TV right now, for Now Playing, and how long: the
/// live players check in every half minute while a channel plays (a
/// stream added by link has no Jellyfin session at all). Time between two
/// check-ins counts toward the live TV badges, gathered here and written
/// a few minutes at a time.
/// </summary>
public class LiveWatchingService(Func<Guid, long, Task> creditWatching)
{
    private static readonly TimeSpan Expiry = TimeSpan.FromSeconds(90);
    // A gap longer than this between check-ins isn't counted as watching.
    private static readonly TimeSpan MaxCreditedGap = TimeSpan.FromSeconds(75);
    private static readonly long FlushTicks = TimeSpan.FromMinutes(5).Ticks;

    private readonly ConcurrentDictionary<Guid, LiveWatchingEntry> _entries = new();
    private readonly ConcurrentDictionary<Guid, long> _pending = new();

    public async Task ReportAsync(LiveWatchingEntry entry)
    {
        long credit = 0;
        if (_entries.TryGetValue(entry.UserId, out var previous) && !previous.IsPaused && !entry.IsPaused)
        {
            var gap = entry.SeenAt - previous.SeenAt;
            if (gap > TimeSpan.Zero && gap <= MaxCreditedGap)
            {
                credit = gap.Ticks;
            }
        }

        _entries[entry.UserId] = entry;
        if (credit > 0)
        {
            var pending = _pending.AddOrUpdate(entry.UserId, credit, (_, current) => current + credit);
            if (pending >= FlushTicks)
            {
                await FlushAsync(entry.UserId).ConfigureAwait(false);
            }
        }
    }

    public async Task StopAsync(Guid userId)
    {
        _entries.TryRemove(userId, out _);
        await FlushAsync(userId).ConfigureAwait(false);
    }

    public IReadOnlyList<LiveWatchingEntry> Current()
    {
        var cutoff = DateTimeOffset.UtcNow - Expiry;
        foreach (var stale in _entries.Where(pair => pair.Value.SeenAt < cutoff).Select(pair => pair.Key).ToList())
        {
            _entries.TryRemove(stale, out _);
            _ = FlushAsync(stale);
        }

        return _entries.Values.OrderByDescending(entry => entry.SeenAt).ToList();
    }

    public long PendingTicks(Guid userId) => _pending.TryGetValue(userId, out var ticks) ? ticks : 0;

    private async Task FlushAsync(Guid userId)
    {
        if (_pending.TryRemove(userId, out var ticks) && ticks > 0)
        {
            await creditWatching(userId, ticks).ConfigureAwait(false);
        }
    }
}
