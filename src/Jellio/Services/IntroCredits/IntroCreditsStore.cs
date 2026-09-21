using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.IntroCredits;

// Same real shape RealDurationStore already uses (one shared JSON file
// keyed by item id, a lock around every real read-modify-write): Intro
// Skipper's own native/legacy lookups both come back empty for a
// .strm-backed remote library, real feedback confirmed live against
// this server's own container logs, chromaprint fingerprinting itself
// needing real decoded audio a scheduled task pointed at a debrid link
// cannot reliably pull the way it can a local file. Two real writers now:
// IntroCreditsAnalyzer's own cross-episode audio fingerprint matching,
// run directly against the same resolved stream URL real playback
// already uses (MediaSourceInfo.Path, IMediaSourceManager), not Intro
// Skipper's own queue, which (real Intro Skipper source, confirmed
// before writing this) gates its own analysis queue to a local, seekable
// file path and skips a remote one outright rather than even attempting
// an HTTP read; and IntroCreditsBulkScanner, caching a real hit from
// Services/CommunitySkip's own free tier here too, so a season already
// fully covered by it does not need to ask again on its own next scan.
public class IntroCreditsStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "intro-credits.json");

    public IntroCreditsRecord? Get(Guid itemId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            return all.GetValueOrDefault(Key(itemId));
        }
    }

    public void SetIntroduction(Guid itemId, double startSeconds, double endSeconds)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            var record = GetOrCreate(all, itemId);
            record.IntroStartTicks = SecondsToTicks(startSeconds);
            record.IntroEndTicks = SecondsToTicks(endSeconds);
            Touch(record);
            SaveLocked(all);
        }
    }

    public void SetCredits(Guid itemId, double startSeconds, double endSeconds)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            var record = GetOrCreate(all, itemId);
            record.CreditsStartTicks = SecondsToTicks(startSeconds);
            record.CreditsEndTicks = SecondsToTicks(endSeconds);
            Touch(record);
            SaveLocked(all);
        }
    }

    // Recorded even on a real miss (no fingerprint at all, or no strong
    // enough match against the season's own anchor episode): without
    // this, a title that genuinely has no shared intro/credits (an
    // anthology, a one-off special) would get re-fingerprinted on every
    // single real playback within MinReanalyzeGap, real wasted ffmpeg
    // work for a real, already-known answer.
    public void MarkAttempted(Guid itemId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            var record = GetOrCreate(all, itemId);
            Touch(record);
            SaveLocked(all);
        }
    }

    private static IntroCreditsRecord GetOrCreate(Dictionary<string, IntroCreditsRecord> all, Guid itemId)
    {
        var key = Key(itemId);
        if (all.TryGetValue(key, out var existing))
        {
            return existing;
        }

        var created = new IntroCreditsRecord();
        all[key] = created;
        return created;
    }

    private static void Touch(IntroCreditsRecord record)
    {
        record.Attempted = true;
        record.AttemptedAt = DateTimeOffset.UtcNow;
    }

    private static string Key(Guid itemId) => itemId.ToString("N");

    private static long SecondsToTicks(double seconds) => (long)(seconds * TimeSpan.TicksPerSecond);

    private Dictionary<string, IntroCreditsRecord> LoadLocked()
    {
        if (!File.Exists(StorePath))
        {
            return new Dictionary<string, IntroCreditsRecord>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, IntroCreditsRecord>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, IntroCreditsRecord>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, IntroCreditsRecord>();
        }
    }

    private void SaveLocked(Dictionary<string, IntroCreditsRecord> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllText(StorePath, JsonSerializer.Serialize(all));
    }
}
