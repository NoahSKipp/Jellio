using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public class ShelfCategory
{
    public string Id { get; set; } = string.Empty;

    // "manga", "ebook" or "audiobook": the shelf the category belongs to.
    public string Kind { get; set; } = "manga";

    public string Name { get; set; } = string.Empty;

    // How the shelf orders the category: title, author, added, year,
    // last-read, unread, chapters or latest.
    public string Sort { get; set; } = "title";

    public bool Descending { get; set; }

    // Shelf keys: "s:<series key>" for a manga series, "i:<item id>" for
    // a single book, audiobook or manga file.
    public List<string> Items { get; set; } = [];
}

public class SeriesPrefs
{
    public string? Note { get; set; }

    // When the series joined the reader's library (Mihon's date added),
    // unix milliseconds.
    public long? AddedAt { get; set; }

    public bool? ChapterDescending { get; set; }

    // "all", "unread" or "bookmarked".
    public string? ChapterFilter { get; set; }

    // Reader overrides for this series: single, spread, paged-vertical,
    // vertical (long strip) or vertical-gaps, and rtl or ltr.
    public string? ComicLayout { get; set; }

    public string? ComicDirection { get; set; }

    // Scanlators whose chapters are hidden for this series (Mihon's
    // excluded scanlators), kept so the same chapter from several
    // groups doesn't show up more than once. Null or empty: all shown.
    public List<string>? ExcludedScanlators { get; set; }

    // Whether a chapter counts as read once the same chapter number is
    // read from another scanlator. Null means yes.
    public bool? DuplicatesAsOne { get; set; }

    // Mihon's chapter filters: null (off), "include" or "exclude".
    public string? FilterDownloaded { get; set; }

    public string? FilterUnread { get; set; }

    public string? FilterBookmarked { get; set; }

    // "source", "number", "date" or "title"; null means number.
    public string? ChapterSort { get; set; }

    // "title" or "number"; null means title.
    public string? ChapterDisplay { get; set; }
}

public class ShelfData
{
    public List<ShelfCategory> Categories { get; set; } = [];

    public Dictionary<string, SeriesPrefs> Series { get; set; } = [];

    // Bookmarked chapters (item ids, no dashes).
    public List<string> Bookmarks { get; set; } = [];

    // The manga series on this reader's shelf (series keys, "s:..."), like
    // Mihon's library. Null until first used.
    public List<string>? Library { get; set; }

    // Series the reader removed from the library, kept off the shelf even
    // if they have read chapters, until added again.
    public List<string> LibraryRemoved { get; set; } = [];

    // Chapter settings for series that haven't set their own (Mihon's
    // "set as default").
    public SeriesPrefs? SeriesDefaults { get; set; }
}

/// <summary>
/// A reader's own shelf organisation, Mihon style: categories on the
/// Manga, Books and Audiobooks shelves, per-series settings and chapter
/// bookmarks.
/// </summary>
public partial class ShelfStore(IApplicationPaths applicationPaths)
{
    public const int MaxCategories = 50;
    public const int MaxNameLength = 40;
    public const int MaxNoteLength = 4000;

    public static readonly string[] Kinds = ["manga", "ebook", "audiobook"];
    public static readonly string[] Sorts = ["title", "author", "added", "year", "last-read", "unread", "chapters", "latest"];

    private readonly JsonUserStore<ShelfData> _store = new(applicationPaths, "shelf", () => new ShelfData());

    public ShelfData Load(Guid userId) => _store.Load(userId);

    public ShelfData Update(Guid userId, Action<ShelfData> mutate) => _store.Update(userId, mutate);

    // A reader's manga library. The first time, it's seeded with the
    // series they already have settings or categories for (earlier
    // imports), so nobody's shelf empties out.
    public HashSet<string> Library(Guid userId)
    {
        var data = _store.Load(userId);
        if (data.Library is null)
        {
            data = _store.Update(userId, SeedLibrary);
        }

        return new HashSet<string>(data.Library ?? [], StringComparer.Ordinal);
    }

    public void SetInLibrary(Guid userId, string key, bool inLibrary) =>
        _store.Update(userId, data =>
        {
            SeedLibrary(data);
            data.Library!.Remove(key);
            data.LibraryRemoved.Remove(key);
            if (inLibrary)
            {
                data.Library.Add(key);
            }
            else
            {
                data.LibraryRemoved.Add(key);
            }
        });

    private static void SeedLibrary(ShelfData data)
    {
        data.Library ??= data.Series.Keys
            .Concat(data.Categories.Where(category => category.Kind == "manga").SelectMany(category => category.Items))
            .Where(key => key.StartsWith("s:", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    public static string NewId() => Guid.NewGuid().ToString("N")[..12];

    public static string CleanName(string? name)
    {
        var text = (name ?? string.Empty).Trim();
        return text.Length > MaxNameLength ? text[..MaxNameLength] : text;
    }

    // Same key the frontend groups manga series by
    // (components/mangaSeries.js mangaSeriesKey).
    public static string SeriesKey(string title)
    {
        var decomposed = title.ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (c < '̀' || c > 'ͯ')
            {
                builder.Append(c);
            }
        }

        return NonAlphanumeric().Replace(builder.ToString(), " ").Trim();
    }

    public static string SeriesShelfKey(string title) => "s:" + SeriesKey(title);

    [GeneratedRegex("[^a-z0-9]+", RegexOptions.CultureInvariant)]
    private static partial Regex NonAlphanumeric();
}
