using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public class BookRequestEntry
{
    public string WorkId { get; set; } = string.Empty;

    // Chaptarr's id for this format's instance of the book, 0 when the add
    // was queued and Chaptarr hasn't said yet.
    public int ChaptarrBookId { get; set; }

    public string Title { get; set; } = string.Empty;

    public string? Author { get; set; }

    // "ebook" or "audiobook".
    public string BookType { get; set; } = "ebook";

    public DateTimeOffset RequestedAt { get; set; }
}

/// <summary>
/// Which books each reader asked Chaptarr for, so the Requests page can say
/// who is waiting on what, and removing a book knows whether anyone else
/// still wants it.
/// </summary>
public class BookRequestStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<List<BookRequestEntry>> _store = new(applicationPaths, "book-requests", () => []);

    public List<BookRequestEntry> Load(Guid userId) => _store.Load(userId);

    public IReadOnlyList<Guid> UserIds() => _store.UserIds();

    public void Add(Guid userId, BookRequestEntry entry) =>
        _store.Update(userId, entries =>
        {
            entries.RemoveAll(existing => Same(existing, entry));
            entries.Add(entry);
        });

    public int Remove(Guid userId, Func<BookRequestEntry, bool> match)
    {
        var removed = 0;
        _store.Update(userId, entries => removed = entries.RemoveAll(entry => match(entry)));
        return removed;
    }

    // The same request: same format, and the same Chaptarr book or work.
    public static bool Same(BookRequestEntry a, BookRequestEntry b) =>
        a.BookType == b.BookType
        && ((a.ChaptarrBookId > 0 && a.ChaptarrBookId == b.ChaptarrBookId)
            || (!string.IsNullOrEmpty(a.WorkId) && string.Equals(a.WorkId, b.WorkId, StringComparison.OrdinalIgnoreCase)));
}
