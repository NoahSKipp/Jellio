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

    // The book's length in pages (a PDF's real page count, an EPUB's
    // location count), for "pages left"; null until the reader knows it.
    public int? TotalPages { get; set; }

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

    public ReadingProgressRecord Set(Guid userId, Guid itemId, string locator, double progress, int? totalPages, DateTimeOffset? updatedAt = null)
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
                TotalPages = totalPages ?? items.GetValueOrDefault(Key(itemId))?.TotalPages,
                UpdatedAt = updatedAt ?? DateTimeOffset.UtcNow,
            };
            items[Key(itemId)] = record;
            SaveLocked(all);
            return record;
        }
    }

    // Many at once (a Mihon import), saved once: a save rewrites the whole
    // file, so one per chapter grows quadratically with a big library.
    // keepExisting leaves progress already made in Jellio alone.
    public int SetMany(Guid userId, IEnumerable<(Guid ItemId, string Locator, double Progress, int? TotalPages, DateTimeOffset? UpdatedAt)> entries, bool keepExisting)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                items = new Dictionary<string, ReadingProgressRecord>();
                all[Key(userId)] = items;
            }

            var written = 0;
            foreach (var entry in entries)
            {
                var key = Key(entry.ItemId);
                if (keepExisting && items.ContainsKey(key))
                {
                    continue;
                }

                items[key] = new ReadingProgressRecord
                {
                    Locator = entry.Locator,
                    Progress = Math.Clamp(entry.Progress, 0, 1),
                    TotalPages = entry.TotalPages ?? items.GetValueOrDefault(key)?.TotalPages,
                    UpdatedAt = entry.UpdatedAt ?? DateTimeOffset.UtcNow,
                };
                written++;
            }

            if (written > 0)
            {
                SaveLocked(all);
            }

            return written;
        }
    }

    // Everything this reader has progress on, keyed by item id (no dashes).
    public Dictionary<string, ReadingProgressRecord> GetAll(Guid userId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            return all.TryGetValue(Key(userId), out var items)
                ? new Dictionary<string, ReadingProgressRecord>(items)
                : new Dictionary<string, ReadingProgressRecord>();
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

    // Read from disk once and kept: every read used to parse the whole
    // file, all users' progress, under the lock.
    private Dictionary<string, Dictionary<string, ReadingProgressRecord>>? _cache;

    private Dictionary<string, Dictionary<string, ReadingProgressRecord>> LoadLocked()
    {
        if (_cache is not null)
        {
            return _cache;
        }

        if (!File.Exists(StorePath))
        {
            return _cache = new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }

        try
        {
            _cache = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, ReadingProgressRecord>>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }
        catch (JsonException)
        {
            _cache = new Dictionary<string, Dictionary<string, ReadingProgressRecord>>();
        }

        return _cache;
    }

    private void SaveLocked(Dictionary<string, Dictionary<string, ReadingProgressRecord>> all)
    {
        _cache = all;
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        var temp = StorePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(all));
        File.Move(temp, StorePath, true);
    }
}
