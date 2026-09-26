using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public class Annotation
{
    public string Id { get; set; } = string.Empty;

    // "highlight" (a passage, optionally with a note) or "bookmark" (a
    // place in the book).
    public string Kind { get; set; } = "highlight";

    // Opaque to this store, only screens/reader.js interprets it: an EPUB
    // CFI (range), or "pdf:<page>:<start>:<end>" for a PDF text range.
    public string Locator { get; set; } = string.Empty;

    // 0..1 through the book, for ordering the notes list.
    public double Position { get; set; }

    public string? Text { get; set; }

    public string? Note { get; set; }

    public string? Color { get; set; }

    public string? Chapter { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// Highlights, notes and bookmarks, per user and book, so they follow a
/// reader across devices. One JSON file per user (item id -> list), the
/// same lock-and-rewrite shape as ReadingProgressStore; a reader's own
/// annotations are small enough that rewriting the file is cheap.
/// </summary>
public class AnnotationStore(IApplicationPaths applicationPaths)
{
    public const int MaxPerBook = 5000;

    private readonly object _lock = new();

    public IReadOnlyList<Annotation> Get(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            return LoadLocked(userId).GetValueOrDefault(Key(itemId))?.OrderBy(a => a.Position).ToList() ?? [];
        }
    }

    public Annotation? Add(Guid userId, Guid itemId, Annotation annotation)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            if (!all.TryGetValue(Key(itemId), out var list))
            {
                list = [];
                all[Key(itemId)] = list;
            }

            if (list.Count >= MaxPerBook)
            {
                return null;
            }

            annotation.Id = Guid.NewGuid().ToString("N");
            annotation.CreatedAt = DateTimeOffset.UtcNow;
            annotation.UpdatedAt = annotation.CreatedAt;
            list.Add(annotation);
            SaveLocked(userId, all);
            return annotation;
        }
    }

    public Annotation? Update(Guid userId, Guid itemId, string id, string? note, string? color)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            var annotation = all.GetValueOrDefault(Key(itemId))?.FirstOrDefault(a => a.Id == id);
            if (annotation is null)
            {
                return null;
            }

            annotation.Note = note;
            if (color is not null)
            {
                annotation.Color = color;
            }

            annotation.UpdatedAt = DateTimeOffset.UtcNow;
            SaveLocked(userId, all);
            return annotation;
        }
    }

    public bool Remove(Guid userId, Guid itemId, string id)
    {
        lock (_lock)
        {
            var all = LoadLocked(userId);
            if (!all.TryGetValue(Key(itemId), out var list) || list.RemoveAll(a => a.Id == id) == 0)
            {
                return false;
            }

            if (list.Count == 0)
            {
                all.Remove(Key(itemId));
            }

            SaveLocked(userId, all);
            return true;
        }
    }

    private static string Key(Guid id) => id.ToString("N");

    private string PathFor(Guid userId) =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "annotations", Key(userId) + ".json");

    private Dictionary<string, List<Annotation>> LoadLocked(Guid userId)
    {
        var path = PathFor(userId);
        if (!File.Exists(path))
        {
            return new Dictionary<string, List<Annotation>>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, List<Annotation>>>(File.ReadAllText(path))
                ?? new Dictionary<string, List<Annotation>>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, List<Annotation>>();
        }
    }

    private void SaveLocked(Guid userId, Dictionary<string, List<Annotation>> all)
    {
        var path = PathFor(userId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(all));
    }
}
