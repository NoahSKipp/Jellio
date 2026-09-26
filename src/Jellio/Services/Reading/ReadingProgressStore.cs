using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public class ReadingProgressRecord
{
    // An EPUB CFI, or "page:N" for a PDF - opaque to this store, only
    // screens/reader.js ever interprets it.
    public string Locator { get; set; } = string.Empty;

    // 0..1 through the whole book, what the Continue Reading row and a
    // card's own progress bar read.
    public double Progress { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

// Jellyfin tracks a resume position for anything playable (audiobooks
// included), but has no notion of "where am I in this EPUB" at all, so
// book reading position lives here instead. Same one-JSON-file-plus-lock
// shape as IntroCreditsStore, keyed user -> item.
public class ReadingProgressStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "reading-progress.json");

    public ReadingProgressRecord? Get(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            return all.TryGetValue(Key(userId), out var items) ? items.GetValueOrDefault(Key(itemId)) : null;
        }
    }

    public ReadingProgressRecord Set(Guid userId, Guid itemId, string locator, double progress)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                items = new Dictionary<string, ReadingProgressRecord>();
                all[Key(userId)] = items;
            }

            var record = new ReadingProgressRecord
            {
                Locator = locator,
                Progress = Math.Clamp(progress, 0, 1),
                UpdatedAt = DateTimeOffset.UtcNow,
            };
            items[Key(itemId)] = record;
            SaveLocked(all);
            return record;
        }
    }

    // Started but not finished, most recently read first.
    public List<(Guid ItemId, ReadingProgressRecord Record)> GetInProgress(Guid userId, int limit)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                return [];
            }

            return items
                .Where(pair => pair.Value.Progress > 0 && pair.Value.Progress < 0.98)
                .OrderByDescending(pair => pair.Value.UpdatedAt)
                .Take(limit)
                .Select(pair => (Guid.ParseExact(pair.Key, "N"), pair.Value))
                .ToList();
        }
    }

    private static string Key(Guid id) => id.ToString("N");

    private Dictionary<string, Dictionary<string, ReadingProgressRecord>> LoadLocked()
    {
        if (!File.Exists(StorePath))
        {
            return new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, ReadingProgressRecord>>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }
    }

    private void SaveLocked(Dictionary<string, Dictionary<string, ReadingProgressRecord>> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllText(StorePath, JsonSerializer.Serialize(all));
    }
}
