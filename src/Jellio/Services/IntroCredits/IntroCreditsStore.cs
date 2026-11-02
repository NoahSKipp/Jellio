using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.IntroCredits;

public class IntroCreditsStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();
    private Dictionary<string, IntroCreditsRecord>? _cache;
    private DebouncedJsonWriter? _writer;

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

    public void MarkCommunityAttempted(Guid itemId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            var record = GetOrCreate(all, itemId);
            record.CommunityAttempted = true;
            record.CommunityAttemptedAt = DateTimeOffset.UtcNow;
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

    // The file is several MB: it is parsed once and kept in memory, and
    // writes are coalesced instead of rewriting it on every change.
    private Dictionary<string, IntroCreditsRecord> LoadLocked()
    {
        if (_cache is not null)
        {
            return _cache;
        }

        if (!File.Exists(StorePath))
        {
            return _cache = new Dictionary<string, IntroCreditsRecord>();
        }

        try
        {
            _cache = JsonSerializer.Deserialize<Dictionary<string, IntroCreditsRecord>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, IntroCreditsRecord>();
        }
        catch (JsonException)
        {
            _cache = new Dictionary<string, IntroCreditsRecord>();
        }

        return _cache;
    }

    private void SaveLocked(Dictionary<string, IntroCreditsRecord> all)
    {
        _cache = all;
        _writer ??= new DebouncedJsonWriter(_lock, () => StorePath, () => JsonSerializer.Serialize(_cache), TimeSpan.FromSeconds(5));
        _writer.Schedule();
    }
}
