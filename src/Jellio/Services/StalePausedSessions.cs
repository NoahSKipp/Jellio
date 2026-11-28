using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

// What a session looked like at one check. ItemId is null when nothing plays.
public readonly record struct PausedObservation(Guid? ItemId, bool IsPaused, long? PositionTicks);

// When a session was first seen paused on this item at this position.
public sealed record PausedEntry(Guid ItemId, long? PositionTicks, DateTime FirstSeenUtc, bool Stopped);

// Decides when a session that sits paused for hours should have its playback
// state ended. Any change in the session resets the clock.
public static class StalePausedSessions
{
    public const int DefaultLimitHours = 4;

    public static TimeSpan LimitFromHours(int hours) => hours <= 0 ? TimeSpan.Zero : TimeSpan.FromHours(hours);

    public static bool IsOverLimit(DateTime firstPausedSeen, DateTime now, TimeSpan limit)
    {
        return limit > TimeSpan.Zero && now - firstPausedSeen > limit;
    }

    // Updates the tracked entry for one session and returns true when its
    // playback should be stopped now. A session is reported at most once per
    // paused stretch.
    public static bool Evaluate(
        IDictionary<string, PausedEntry> tracked,
        string sessionId,
        PausedObservation seen,
        DateTime now,
        TimeSpan limit
    )
    {
        if (limit <= TimeSpan.Zero || !seen.IsPaused || seen.ItemId is not Guid itemId)
        {
            tracked.Remove(sessionId);
            return false;
        }

        if (
            !tracked.TryGetValue(sessionId, out var entry)
            || entry.ItemId != itemId
            || entry.PositionTicks != seen.PositionTicks
        )
        {
            tracked[sessionId] = new PausedEntry(itemId, seen.PositionTicks, now, false);
            return false;
        }

        if (entry.Stopped || !IsOverLimit(entry.FirstSeenUtc, now, limit))
        {
            return false;
        }

        tracked[sessionId] = entry with { Stopped = true };
        return true;
    }

    // Drops entries whose session is no longer listed.
    public static void Prune(IDictionary<string, PausedEntry> tracked, ISet<string> liveSessionIds)
    {
        foreach (var key in tracked.Keys.Where(k => !liveSessionIds.Contains(k)).ToList())
        {
            tracked.Remove(key);
        }
    }
}
