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

    public int? TotalPages { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

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

    public event Action<Guid, Guid, double>? ProgressSaved;

    public ReadingProgressRecord Set(Guid userId, Guid itemId, string locator, double progress, int? totalPages, DateTimeOffset? updatedAt = null)
    {
        var clamped = Math.Clamp(progress, 0, 1);
        ReadingProgressRecord record;
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                items = new Dictionary<string, ReadingProgressRecord>();
                all[Key(userId)] = items;
            }

            record = new ReadingProgressRecord
            {
                Locator = locator,
                Progress = clamped,
                TotalPages = totalPages ?? items.GetValueOrDefault(Key(itemId))?.TotalPages,
                UpdatedAt = updatedAt ?? DateTimeOffset.UtcNow,
            };
            items[Key(itemId)] = record;
            SaveLocked(all);
        }

        if (clamped >= 0.98)
        {
            ProgressSaved?.Invoke(userId, itemId, clamped);
        }

        return record;
    }

    public int SetMany(Guid userId, IEnumerable<(Guid ItemId, string Locator, double Progress, int? TotalPages, DateTimeOffset? UpdatedAt)> entries, bool keepExisting, bool notify = false)
    {
        var written = 0;
        List<(Guid ItemId, double Progress)>? completed = null;
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                items = new Dictionary<string, ReadingProgressRecord>();
                all[Key(userId)] = items;
            }

            foreach (var entry in entries)
            {
                var key = Key(entry.ItemId);
                if (keepExisting && items.ContainsKey(key))
                {
                    continue;
                }

                var clamped = Math.Clamp(entry.Progress, 0, 1);
                items[key] = new ReadingProgressRecord
                {
                    Locator = entry.Locator,
                    Progress = clamped,
                    TotalPages = entry.TotalPages ?? items.GetValueOrDefault(key)?.TotalPages,
                    UpdatedAt = entry.UpdatedAt ?? DateTimeOffset.UtcNow,
                };
                written++;
                if (notify && clamped >= 0.98)
                {
                    completed ??= [];
                    completed.Add((entry.ItemId, clamped));
                }
            }

            if (written > 0)
            {
                SaveLocked(all);
            }
        }

        if (completed != null)
        {
            foreach (var (itemId, progress) in completed)
            {
                ProgressSaved?.Invoke(userId, itemId, progress);
            }
        }

        return written;
    }

    // Clears progress (marking chapters unread), saved once.
    public int RemoveMany(Guid userId, IEnumerable<Guid> itemIds)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            if (!all.TryGetValue(Key(userId), out var items))
            {
                return 0;
            }

            var removed = itemIds.Count(itemId => items.Remove(Key(itemId)));
            if (removed > 0)
            {
                SaveLocked(all);
            }

            return removed;
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

    private DebouncedJsonWriter? _writer;

    // Page turns save progress; coalesce them instead of rewriting the
    // whole file each time.
    private void SaveLocked(Dictionary<string, Dictionary<string, ReadingProgressRecord>> all)
    {
        _cache = all;
        _writer ??= new DebouncedJsonWriter(_lock, () => StorePath, () => JsonSerializer.Serialize(_cache), TimeSpan.FromSeconds(2));
        _writer.Schedule();
    }
}
