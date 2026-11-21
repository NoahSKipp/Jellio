using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellio.Services.Reading;

namespace Jellio.Services;

// A calendar entry that is due but has no notification yet.
public sealed class PendingNotice
{
    public string Id { get; set; } = string.Empty;

    public Guid ItemId { get; set; }

    public string Name { get; set; } = string.Empty;

    public string Type { get; set; } = string.Empty;

    // The air or release date.
    public DateTime Date { get; set; }

    public string Kind { get; set; } = string.Empty;

    public string? Detail { get; set; }

    public DateTime FirstSeenUtc { get; set; }

    public int Attempts { get; set; }

    // Null: check at the next run.
    public DateTime? NextCheckUtc { get; set; }
}

// Per user: entries still waiting for a stream, and ids that are finished
// (notified or given up on) so a deleted notification does not come back.
public sealed class PlayableNotifyState
{
    public Dictionary<string, PendingNotice> Pending { get; set; } = [];

    public Dictionary<string, DateTime> Settled { get; set; } = [];
}

// What a media source offers, reduced to what decides if it is playable.
public sealed record SourceFacts(string? Name, long? Size, bool HasVideoInfo, bool HasAudioInfo);

// The decisions behind "notify once the media has a working stream", free of
// I/O so they can be tested.
public static partial class PlayableNotifyLogic
{
    // How long after the air date a pending entry is still checked.
    public const int GiveUpDays = 14;

    public static readonly TimeSpan SettledKeep = TimeSpan.FromDays(60);
    public static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMinutes(15);

    private static readonly TimeSpan[] BackoffSteps =
    [
        TimeSpan.FromMinutes(20),
        TimeSpan.FromHours(1),
        TimeSpan.FromHours(2),
        TimeSpan.FromHours(4),
        TimeSpan.FromHours(6),
    ];

    // Same scheme as before, so stored notifications keep deduping.
    public static string EntryId(Guid itemId, DateTime date) => itemId + ":" + date.ToString("yyyy-MM-dd");

    public static TimeSpan Backoff(int failedAttempts) =>
        BackoffSteps[Math.Clamp(failedAttempts - 1, 0, BackoffSteps.Length - 1)];

    public static bool IsMuted(IReadOnlyDictionary<string, SeriesPrefs>? series, Guid itemId)
    {
        if (series == null)
        {
            return false;
        }

        var key = itemId.ToString("N").ToLowerInvariant();
        if (series.TryGetValue("s:" + key, out var prefs) ||
            series.TryGetValue(key, out prefs) ||
            series.TryGetValue(itemId.ToString(), out prefs))
        {
            return prefs.SkipUpdates == true;
        }

        return false;
    }

    public static bool IsExpired(PendingNotice notice, DateTime today) =>
        (today - notice.Date.Date).TotalDays > GiveUpDays;

    // Adds entries that are due (date today or earlier, inside the give-up
    // window) and not muted, notified, settled or pending already.
    public static int Discover(
        PlayableNotifyState state,
        IEnumerable<WatchlistCalendarItem> entries,
        DateTime today,
        DateTime now,
        ISet<string> knownNotificationIds,
        IReadOnlyDictionary<string, SeriesPrefs>? series)
    {
        var added = 0;
        foreach (var entry in entries)
        {
            if (entry.Date.Date > today || (today - entry.Date.Date).TotalDays > GiveUpDays)
            {
                continue;
            }

            if (IsMuted(series, entry.ItemId))
            {
                continue;
            }

            var id = EntryId(entry.ItemId, entry.Date);
            if (knownNotificationIds.Contains(id) || state.Settled.ContainsKey(id) || state.Pending.ContainsKey(id))
            {
                continue;
            }

            state.Pending[id] = new PendingNotice
            {
                Id = id,
                ItemId = entry.ItemId,
                Name = entry.Name,
                Type = entry.Type,
                Date = entry.Date,
                Kind = entry.Kind,
                Detail = entry.Detail,
                FirstSeenUtc = now,
            };
            added++;
        }

        return added;
    }

    // Drops entries that were notified meanwhile and gives up on old ones.
    // Returns the ones given up on. Muted entries stay, but are not checked.
    public static List<PendingNotice> Prune(
        PlayableNotifyState state,
        DateTime today,
        DateTime now,
        ISet<string> knownNotificationIds)
    {
        var gaveUp = new List<PendingNotice>();
        foreach (var notice in state.Pending.Values.ToList())
        {
            if (knownNotificationIds.Contains(notice.Id))
            {
                state.Pending.Remove(notice.Id);
                state.Settled[notice.Id] = now;
            }
            else if (IsExpired(notice, today))
            {
                state.Pending.Remove(notice.Id);
                state.Settled[notice.Id] = now;
                gaveUp.Add(notice);
            }
        }

        foreach (var (id, at) in state.Settled.ToList())
        {
            if (now - at > SettledKeep)
            {
                state.Settled.Remove(id);
            }
        }

        return gaveUp;
    }

    // Pending entries to check now, oldest air date first.
    public static List<PendingNotice> Due(
        PlayableNotifyState state,
        DateTime now,
        IReadOnlyDictionary<string, SeriesPrefs>? series) =>
        state.Pending.Values
            .Where(n => (n.NextCheckUtc is null || n.NextCheckUtc <= now) && !IsMuted(series, n.ItemId))
            .OrderBy(n => n.Date)
            .ToList();

    // A failed check: try again later, further apart each time.
    public static void RecordFailure(PendingNotice notice, DateTime now)
    {
        notice.Attempts++;
        notice.NextCheckUtc = now + Backoff(notice.Attempts);
    }

    // A working stream: the entry is done and becomes a notification.
    // Date stays the air date; CreatedUtc is when the stream was found.
    public static WatchlistNotification Complete(PlayableNotifyState state, PendingNotice notice, DateTime now)
    {
        state.Pending.Remove(notice.Id);
        state.Settled[notice.Id] = now;
        return new WatchlistNotification(
            notice.Id,
            notice.ItemId,
            notice.Name,
            notice.Type,
            notice.Date,
            notice.Kind,
            notice.Detail,
            now,
            false);
    }

    public static bool IsNegativeCacheFresh(DateTime checkedAt, DateTime now) =>
        now - checkedAt < NegativeCacheTtl;

    // Mirrors the web client's filterPlayableSources: one source with no
    // stream info is a placeholder, not a stream.
    public static bool HasPlayableSource(IReadOnlyList<SourceFacts>? sources)
    {
        if (sources == null || sources.Count == 0)
        {
            return false;
        }

        if (sources.Count == 1)
        {
            return HasStreamInfo(sources[0]);
        }

        return true;
    }

    public static bool HasStreamInfo(SourceFacts source) =>
        (source.Size ?? 0) >= 1024 * 1024
        || source.HasVideoInfo
        || source.HasAudioInfo
        || (!string.IsNullOrEmpty(source.Name) && StreamInfoName().IsMatch(source.Name));

    [GeneratedRegex(
        @"(^|[^a-z0-9])(2160p|1080p|720p|480p|4k|web-?dl|web-?rip|bluray|blu-ray|bdrip|brrip|remux|hdtv|hevc|[xh]\.?26[45]|avc|av1|vp9|hdr10?\+?|dovi|dolby\s?vision|hlg|aac|e?-?ac-?3|ddp|dts|truehd|atmos|flac|\d+(\.\d+)?\s*(gb|mb|gib|mib))([^a-z0-9]|$)",
        RegexOptions.IgnoreCase)]
    private static partial Regex StreamInfoName();
}
