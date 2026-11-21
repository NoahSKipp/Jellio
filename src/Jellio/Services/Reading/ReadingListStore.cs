using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellio.Services.Friends;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Reading;

public static class ReadingKinds
{
    public const string Ebook = "ebook";
    public const string Audiobook = "audiobook";
    public const string Manga = "manga";

    // The notification Type for each kind.
    public static string NotificationType(string kind) => kind switch
    {
        Audiobook => "AudioBook",
        Manga => "Manga",
        _ => "Book",
    };
}

public class ReadingEntry
{
    public string Key { get; set; } = string.Empty;

    public string Kind { get; set; } = ReadingKinds.Ebook;

    // N format Jellyfin item id: the item itself for "i:" keys, a local
    // chapter file the cover is drawn from for "s:" keys.
    public string? ItemId { get; set; }

    public int? MangaId { get; set; }

    public string Title { get; set; } = string.Empty;

    public string? Author { get; set; }

    // External https cover as given when the entry was added.
    public string? CoverUrl { get; set; }

    public DateTime AddedAt { get; set; }

    // Friends who added it, newest first, at most three.
    public List<AddedByEntry> AddedBy { get; set; } = [];
}

public class ReadingListData
{
    public List<ReadingEntry> Items { get; set; } = [];
}

// What a client sent: the raw fields of an add.
public record ReadingInput(
    string? Key,
    string? Kind,
    string? ItemId,
    string? Title,
    string? Author,
    string? CoverUrl,
    int? MangaId);

// The Jellyfin Book or AudioBook an "i:" key points at.
// IsComic: a comic archive (cbz, cbr, cb7, cbt), read as manga unless said otherwise.
public record ReadingItemInfo(Guid Id, bool IsAudioBook, string Title, string? Author, bool IsComic = false);

public record ReadingTarget(
    string Key,
    string Kind,
    string? ItemId,
    int? MangaId,
    string Title,
    string? Author,
    string? CoverUrl);

public record ReadingParse(ReadingTarget? Target, string? Error)
{
    public static ReadingParse Ok(ReadingTarget target) => new(target, null);

    public static ReadingParse Fail(string error) => new(null, error);
}

public enum ReadingAddOutcome
{
    Added,
    Exists,
    Full,
}

public static partial class ReadingListLogic
{
    public const int MaxItems = 500;
    public const int MaxKeyLength = 300;
    public const int MaxTitleLength = 200;
    public const int MaxAuthorLength = 120;
    public const int MaxCoverLength = 300;

    public static class Errors
    {
        public const string InvalidKey = "invalid_key";
        public const string InvalidKind = "invalid_kind";
        public const string InvalidTitle = "invalid_title";
        public const string InvalidCover = "invalid_cover";
        public const string InvalidItem = "invalid_item";
        public const string NotFound = "not_found";
        public const string ListFull = "list_full";
    }

    public static bool IsComicPath(string? path) =>
        path is not null && Regex.IsMatch(path, @"\.(cbz|cbr|cb7|cbt)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool IsKind(string? kind) =>
        kind is ReadingKinds.Ebook or ReadingKinds.Audiobook or ReadingKinds.Manga;

    public static string ItemKey(Guid itemId) => "i:" + itemId.ToString("N");

    // The canonical form of a key, or false when it is not a valid one.
    public static bool TryNormalizeKey(string? key, out string normalized)
    {
        normalized = string.Empty;
        var text = key?.Trim();
        if (string.IsNullOrEmpty(text) || text.Length > MaxKeyLength)
        {
            return false;
        }

        if (text.StartsWith("i:", StringComparison.OrdinalIgnoreCase))
        {
            if (!Guid.TryParse(text[2..], out var id) || id == Guid.Empty)
            {
                return false;
            }

            normalized = ItemKey(id);
            return true;
        }

        if (text.StartsWith("s:", StringComparison.OrdinalIgnoreCase))
        {
            var rest = text[2..];
            if (rest.Length < 1 || rest != rest.Trim() || rest.Any(char.IsControl))
            {
                return false;
            }

            normalized = "s:" + rest;
            return true;
        }

        if (text.StartsWith("w:", StringComparison.OrdinalIgnoreCase) && WorkKey().IsMatch("w:" + text[2..]))
        {
            normalized = "w:" + text[2..];
            return true;
        }

        return false;
    }

    // The Jellyfin item id an add refers to (ItemId, or an "i:" key), if any.
    // Guid.Empty means an ItemId was sent that is not a GUID.
    public static Guid? ItemGuidOf(ReadingInput input)
    {
        if (!string.IsNullOrWhiteSpace(input.ItemId))
        {
            return Guid.TryParse(input.ItemId.Trim(), out var id) ? id : Guid.Empty;
        }

        if (!string.IsNullOrWhiteSpace(input.Key) && TryNormalizeKey(input.Key, out var key)
            && key.StartsWith("i:", StringComparison.Ordinal))
        {
            return Guid.Parse(key[2..]);
        }

        return null;
    }

    public static string? Clean(string? text, int max)
    {
        var trimmed = text?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }

        return trimmed.Length > max ? trimmed[..max].TrimEnd() : trimmed;
    }

    public static bool ValidCoverUrl(string? url) =>
        url is { Length: > 0 and <= MaxCoverLength }
        && Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && !url.Any(char.IsControl);

    // Validates an add. `item` is the resolved Jellyfin item for an "i:" key
    // (null when it does not exist or the caller cannot see it).
    public static ReadingParse Parse(ReadingInput input, ReadingItemInfo? item)
    {
        var itemGuid = ItemGuidOf(input);
        if (itemGuid == Guid.Empty)
        {
            return ReadingParse.Fail(Errors.InvalidItem);
        }

        string key;
        if (!string.IsNullOrWhiteSpace(input.Key))
        {
            if (!TryNormalizeKey(input.Key, out key))
            {
                return ReadingParse.Fail(Errors.InvalidKey);
            }
        }
        else if (itemGuid is { } fromItem)
        {
            key = ItemKey(fromItem);
        }
        else
        {
            return ReadingParse.Fail(Errors.InvalidKey);
        }

        var kind = input.Kind?.Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(kind) && !IsKind(kind))
        {
            return ReadingParse.Fail(Errors.InvalidKind);
        }

        if (key.StartsWith("i:", StringComparison.Ordinal))
        {
            return ParseItem(input, key, kind, itemGuid, item);
        }

        var isSeries = key.StartsWith("s:", StringComparison.Ordinal);
        if (itemGuid is not null && !isSeries)
        {
            return ReadingParse.Fail(Errors.InvalidItem);
        }

        if (string.IsNullOrEmpty(kind) || (isSeries ? kind != ReadingKinds.Manga : kind == ReadingKinds.Manga))
        {
            return ReadingParse.Fail(Errors.InvalidKind);
        }

        var title = Clean(input.Title, MaxTitleLength);
        if (title is null)
        {
            return ReadingParse.Fail(Errors.InvalidTitle);
        }

        string? cover = null;
        if (!string.IsNullOrWhiteSpace(input.CoverUrl))
        {
            cover = input.CoverUrl.Trim();
            if (!ValidCoverUrl(cover))
            {
                return ReadingParse.Fail(Errors.InvalidCover);
            }
        }

        var mangaId = kind == ReadingKinds.Manga && input.MangaId is > 0 ? input.MangaId : null;

        // A series may name one of its local chapter files, only to draw a
        // cover from; anything else there is ignored.
        string? coverItem = null;
        if (isSeries && itemGuid is { } coverGuid && item is { IsAudioBook: false } && item.Id == coverGuid)
        {
            coverItem = coverGuid.ToString("N");
        }

        return ReadingParse.Ok(new ReadingTarget(
            key, kind, coverItem, mangaId, title, Clean(input.Author, MaxAuthorLength), cover));
    }

    private static ReadingParse ParseItem(ReadingInput input, string key, string? kind, Guid? itemGuid, ReadingItemInfo? item)
    {
        if (itemGuid is { } given && ItemKey(given) != key)
        {
            return ReadingParse.Fail(Errors.InvalidItem);
        }

        if (item is null || ItemKey(item.Id) != key)
        {
            return ReadingParse.Fail(Errors.NotFound);
        }

        var allowed = item.IsAudioBook ? [ReadingKinds.Audiobook] : new[] { ReadingKinds.Ebook, ReadingKinds.Manga };
        if (!string.IsNullOrEmpty(kind) && !allowed.Contains(kind))
        {
            return ReadingParse.Fail(Errors.InvalidKind);
        }

        var itemKind = string.IsNullOrEmpty(kind) ? (item.IsComic ? ReadingKinds.Manga : allowed[0]) : kind;

        var title = Clean(item.Title, MaxTitleLength) ?? Clean(input.Title, MaxTitleLength);
        if (title is null)
        {
            return ReadingParse.Fail(Errors.InvalidTitle);
        }

        var author = Clean(item.Author, MaxAuthorLength) ?? Clean(input.Author, MaxAuthorLength);
        return ReadingParse.Ok(new ReadingTarget(key, itemKind, key[2..], null, title, author, null));
    }

    // Server-relative path or absolute https URL a card draws, or null.
    public static string? CoverFor(ReadingEntry entry)
    {
        var title = Uri.EscapeDataString(entry.Title ?? string.Empty);
        if (entry.MangaId is > 0)
        {
            return "/Jellio/manga/thumbnail/" + entry.MangaId + "?title=" + title;
        }

        if (!string.IsNullOrEmpty(entry.ItemId))
        {
            return entry.Kind == ReadingKinds.Manga
                ? "/Jellio/manga/series-cover/" + entry.ItemId + "?title=" + title
                : "/Jellio/books/item/" + entry.ItemId + "/cover";
        }

        if (!string.IsNullOrEmpty(entry.CoverUrl))
        {
            return entry.Kind == ReadingKinds.Manga
                ? "/Jellio/books/manga-cover?url=" + Uri.EscapeDataString(entry.CoverUrl)
                : entry.CoverUrl;
        }

        return null;
    }

    public static ReadingEntry NewEntry(ReadingTarget target, DateTime now) => new()
    {
        Key = target.Key,
        Kind = target.Kind,
        ItemId = target.ItemId,
        MangaId = target.MangaId,
        Title = target.Title,
        Author = target.Author,
        CoverUrl = target.CoverUrl,
        AddedAt = now,
    };

    // Adds the target unless its key is already there or the list is full.
    // A sender is recorded in added-by on an existing entry too.
    public static ReadingAddOutcome Add(ReadingListData data, ReadingTarget target, Guid? sender, DateTime now, out ReadingEntry entry)
    {
        var existing = data.Items.Find(e => e.Key == target.Key);
        if (existing is not null)
        {
            entry = existing;
            if (sender is { } from)
            {
                AddedByLogic.RecordIn(existing.AddedBy, from, now);
            }

            return ReadingAddOutcome.Exists;
        }

        if (data.Items.Count >= MaxItems)
        {
            entry = new ReadingEntry();
            return ReadingAddOutcome.Full;
        }

        entry = NewEntry(target, now);
        if (sender is { } added)
        {
            AddedByLogic.RecordIn(entry.AddedBy, added, now);
        }

        data.Items.Add(entry);
        return ReadingAddOutcome.Added;
    }

    public static bool Remove(ReadingListData data, string key) => data.Items.RemoveAll(e => e.Key == key) > 0;

    public static bool RemoveSender(ReadingListData data, Guid sender)
    {
        var changed = false;
        foreach (var entry in data.Items)
        {
            if (entry.AddedBy.RemoveAll(e => e.FromUserId == sender) > 0)
            {
                changed = true;
            }
        }

        return changed;
    }

    [GeneratedRegex(@"^w:[A-Za-z]{2,6}:[^\s]{1,120}$", RegexOptions.CultureInvariant)]
    private static partial Regex WorkKey();
}

public class ReadingListStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<ReadingListData> _store =
        new(applicationPaths, "reading-list", () => new ReadingListData());

    // A copy, newest first, safe to read while others write.
    public List<ReadingEntry> Snapshot(Guid userId)
    {
        List<ReadingEntry> copy = [];
        _store.UpdateIfChanged(userId, data =>
        {
            copy = data.Items.Select(Copy).OrderByDescending(e => e.AddedAt).ToList();
            return false;
        });
        return copy;
    }

    public List<string> Keys(Guid userId) => Snapshot(userId).Select(e => e.Key).ToList();

    public bool Has(Guid userId, string key)
    {
        var has = false;
        _store.UpdateIfChanged(userId, data =>
        {
            has = data.Items.Any(e => e.Key == key);
            return false;
        });
        return has;
    }

    public int Count(Guid userId)
    {
        var count = 0;
        _store.UpdateIfChanged(userId, data =>
        {
            count = data.Items.Count;
            return false;
        });
        return count;
    }

    // The outcome and the entry as stored (a copy).
    public (ReadingAddOutcome Outcome, ReadingEntry Entry) Add(Guid userId, ReadingTarget target, Guid? sender, DateTime now)
    {
        var outcome = ReadingAddOutcome.Full;
        var entry = new ReadingEntry();
        _store.Update(userId, data =>
        {
            outcome = ReadingListLogic.Add(data, target, sender, now, out var stored);
            entry = Copy(stored);
        });
        return (outcome, entry);
    }

    public bool Remove(Guid userId, string key)
    {
        var removed = false;
        _store.UpdateIfChanged(userId, data => removed = ReadingListLogic.Remove(data, key));
        return removed;
    }

    public void RemoveMany(Guid userId, ICollection<string> keys)
    {
        if (keys.Count == 0)
        {
            return;
        }

        _store.UpdateIfChanged(userId, data => data.Items.RemoveAll(e => keys.Contains(e.Key)) > 0);
    }

    public void RemoveSender(Guid userId, Guid sender) =>
        _store.UpdateIfChanged(userId, data => ReadingListLogic.RemoveSender(data, sender));

    private static ReadingEntry Copy(ReadingEntry e) => new()
    {
        Key = e.Key,
        Kind = e.Kind,
        ItemId = e.ItemId,
        MangaId = e.MangaId,
        Title = e.Title,
        Author = e.Author,
        CoverUrl = e.CoverUrl,
        AddedAt = e.AddedAt,
        AddedBy = e.AddedBy.Select(a => new AddedByEntry { FromUserId = a.FromUserId, At = a.At }).ToList(),
    };
}
