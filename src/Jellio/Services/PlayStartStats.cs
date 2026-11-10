using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record PlayStartEntry(string Client, string From, bool? WarmAtPlay, int TotalMs, int? FirstFrameMs);

public record Percentiles(int Count, int? P50, int? P90);

public record PlayStartGroup(string Client, string From, int Count, double? WarmHitRate, Percentiles TotalMs, Percentiles FirstFrameMs);

public record PlayStartSummary(int Count, int Capacity, double? WarmHitRate, int WarmKnown, IReadOnlyList<PlayStartGroup> Groups);

// Keeps the last N play starts in memory and summarises them.
public class PlayStartStats(int capacity = 1000)
{
    private readonly object _lock = new();
    private readonly PlayStartEntry[] _ring = new PlayStartEntry[Math.Max(1, capacity)];
    private int _next;
    private int _count;

    public int Capacity => _ring.Length;

    public void Add(PlayStartEntry entry)
    {
        lock (_lock)
        {
            _ring[_next] = entry;
            _next = (_next + 1) % _ring.Length;
            if (_count < _ring.Length)
            {
                _count++;
            }
        }
    }

    public IReadOnlyList<PlayStartEntry> Snapshot()
    {
        lock (_lock)
        {
            var list = new List<PlayStartEntry>(_count);
            var start = _count < _ring.Length ? 0 : _next;
            for (var i = 0; i < _count; i++)
            {
                list.Add(_ring[(start + i) % _ring.Length]);
            }

            return list;
        }
    }

    public PlayStartSummary Summarize() => Summarize(Snapshot(), Capacity);

    public static PlayStartSummary Summarize(IReadOnlyList<PlayStartEntry> entries, int capacity)
    {
        var groups = entries
            .GroupBy(e => (e.Client, e.From))
            .OrderBy(g => g.Key.Client, StringComparer.Ordinal)
            .ThenBy(g => g.Key.From, StringComparer.Ordinal)
            .Select(g => new PlayStartGroup(
                g.Key.Client,
                g.Key.From,
                g.Count(),
                WarmRate(g),
                Percentiles(g.Select(e => e.TotalMs)),
                Percentiles(g.Where(e => e.FirstFrameMs.HasValue).Select(e => e.FirstFrameMs!.Value))))
            .ToList();
        return new PlayStartSummary(entries.Count, capacity, WarmRate(entries), entries.Count(e => e.WarmAtPlay.HasValue), groups);
    }

    // Share of plays with a known warm state that were warm when Play was pressed.
    private static double? WarmRate(IEnumerable<PlayStartEntry> entries)
    {
        var known = entries.Where(e => e.WarmAtPlay.HasValue).ToList();
        if (known.Count == 0)
        {
            return null;
        }

        return Math.Round((double)known.Count(e => e.WarmAtPlay == true) / known.Count, 4);
    }

    public static Percentiles Percentiles(IEnumerable<int> values)
    {
        var sorted = values.OrderBy(v => v).ToArray();
        if (sorted.Length == 0)
        {
            return new Percentiles(0, null, null);
        }

        return new Percentiles(sorted.Length, NearestRank(sorted, 0.5), NearestRank(sorted, 0.9));
    }

    private static int NearestRank(int[] sorted, double p)
    {
        var rank = (int)Math.Ceiling(p * sorted.Length);
        return sorted[Math.Clamp(rank, 1, sorted.Length) - 1];
    }
}
