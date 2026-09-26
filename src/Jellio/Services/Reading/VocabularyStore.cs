using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public class VocabEntry
{
    public string Id { get; set; } = string.Empty;

    public string Word { get; set; } = string.Empty;

    // The sentence the word was saved from, the context that makes a
    // flashcard stick.
    public string? Sentence { get; set; }

    public string? Definition { get; set; }

    public string? Translation { get; set; }

    public string? SourceLang { get; set; }

    public string? TargetLang { get; set; }

    public string? ItemId { get; set; }

    public string? ItemName { get; set; }

    public string? Locator { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    // Spaced repetition (a lightweight SM-2): when the card is next due,
    // the current gap between reviews, how easy it has proven, and how
    // many reviews in a row it has passed.
    public DateTimeOffset DueAt { get; set; }

    public double IntervalDays { get; set; }

    public double Ease { get; set; } = 2.5;

    public int Reps { get; set; }

    public int Lapses { get; set; }
}

/// <summary>
/// Each reader's own vocabulary deck: words saved from books with their
/// sentence, definition and translation, plus review scheduling. One JSON
/// file per user.
/// </summary>
public class VocabularyStore(IApplicationPaths applicationPaths)
{
    public const int MaxEntries = 20000;

    private static readonly TimeSpan RelearnDelay = TimeSpan.FromMinutes(10);

    private readonly object _lock = new();

    public IReadOnlyList<VocabEntry> GetAll(Guid userId)
    {
        lock (_lock)
        {
            return LoadLocked(userId).OrderByDescending(e => e.CreatedAt).ToList();
        }
    }

    public IReadOnlyList<VocabEntry> GetDue(Guid userId, int limit)
    {
        lock (_lock)
        {
            var now = DateTimeOffset.UtcNow;
            return LoadLocked(userId).Where(e => e.DueAt <= now).OrderBy(e => e.DueAt).Take(limit).ToList();
        }
    }

    // Saving a word already in the deck (same word, same language) keeps
    // its review history and just refreshes what's missing.
    public VocabEntry? Add(Guid userId, VocabEntry entry)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            var existing = all.FirstOrDefault(e =>
                string.Equals(e.Word, entry.Word, StringComparison.OrdinalIgnoreCase)
                && string.Equals(e.SourceLang ?? string.Empty, entry.SourceLang ?? string.Empty, StringComparison.OrdinalIgnoreCase));
            if (existing is not null)
            {
                existing.Sentence ??= entry.Sentence;
                existing.Definition ??= entry.Definition;
                existing.Translation ??= entry.Translation;
                existing.TargetLang ??= entry.TargetLang;
                SaveLocked(userId, all);
                return existing;
            }

            if (all.Count >= MaxEntries)
            {
                return null;
            }

            entry.Id = Guid.NewGuid().ToString("N");
            entry.CreatedAt = DateTimeOffset.UtcNow;
            entry.DueAt = entry.CreatedAt;
            entry.IntervalDays = 0;
            entry.Ease = 2.5;
            entry.Reps = 0;
            entry.Lapses = 0;
            all.Add(entry);
            SaveLocked(userId, all);
            return entry;
        }
    }

    public VocabEntry? Update(Guid userId, string id, string? translation, string? definition, string? sentence)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            var entry = all.FirstOrDefault(e => e.Id == id);
            if (entry is null)
            {
                return null;
            }

            entry.Translation = translation;
            entry.Definition = definition;
            entry.Sentence = sentence;
            SaveLocked(userId, all);
            return entry;
        }
    }

    // grade: 0 again, 1 hard, 2 good, 3 easy.
    public VocabEntry? Review(Guid userId, string id, int grade)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            var entry = all.FirstOrDefault(e => e.Id == id);
            if (entry is null)
            {
                return null;
            }

            var now = DateTimeOffset.UtcNow;
            switch (grade)
            {
                case 0:
                    entry.Reps = 0;
                    entry.Lapses++;
                    entry.Ease = Math.Max(1.3, entry.Ease - 0.2);
                    entry.IntervalDays = 0;
                    entry.DueAt = now + RelearnDelay;
                    break;
                case 1:
                    entry.Ease = Math.Max(1.3, entry.Ease - 0.15);
                    entry.IntervalDays = Math.Max(1, entry.IntervalDays * 1.2);
                    entry.Reps++;
                    entry.DueAt = now.AddDays(entry.IntervalDays);
                    break;
                case 3:
                    entry.IntervalDays = entry.Reps == 0 ? 4 : Math.Max(entry.IntervalDays + 1, entry.IntervalDays * entry.Ease * 1.3);
                    entry.Ease += 0.15;
                    entry.Reps++;
                    entry.DueAt = now.AddDays(entry.IntervalDays);
                    break;
                default:
                    entry.IntervalDays = entry.Reps switch
                    {
                        0 => 1,
                        1 => 3,
                        _ => Math.Max(entry.IntervalDays + 1, entry.IntervalDays * entry.Ease),
                    };
                    entry.Reps++;
                    entry.DueAt = now.AddDays(entry.IntervalDays);
                    break;
            }

            SaveLocked(userId, all);
            return entry;
        }
    }

    public bool Remove(Guid userId, string id)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            if (all.RemoveAll(e => e.Id == id) == 0)
            {
                return false;
            }

            SaveLocked(userId, all);
            return true;
        }
    }

    private string PathFor(Guid userId) =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "vocabulary", userId.ToString("N") + ".json");

    private List<VocabEntry> LoadLocked(Guid userId)
    {
        var path = PathFor(userId);
        if (!File.Exists(path))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<VocabEntry>>(File.ReadAllText(path)) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private void SaveLocked(Guid userId, List<VocabEntry> all)
    {
        var path = PathFor(userId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(all));
    }
}
