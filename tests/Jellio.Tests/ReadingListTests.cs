using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Jellio.Configuration;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellio.Services.Friends;
using Jellio.Services.Reading;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Xunit;

namespace Jellio.Tests;

public class ReadingListKeyTests
{
    private static readonly Guid Id = Guid.Parse("0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9");

    [Theory]
    [InlineData("i:0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", "i:0a1b2c3d4e5f60718293a4b5c6d7e8f9")]
    [InlineData("I:0A1B2C3D4E5F60718293A4B5C6D7E8F9", "i:0a1b2c3d4e5f60718293a4b5c6d7e8f9")]
    [InlineData("s:berserk", "s:berserk")]
    [InlineData("s:one punch man", "s:one punch man")]
    [InlineData("w:hc:12345", "w:hc:12345")]
    [InlineData("  s:berserk  ", "s:berserk")]
    public void AcceptsValidKeys(string raw, string expected)
    {
        Assert.True(ReadingListLogic.TryNormalizeKey(raw, out var key));
        Assert.Equal(expected, key);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("berserk")]
    [InlineData("i:not-a-guid")]
    [InlineData("i:00000000-0000-0000-0000-000000000000")]
    [InlineData("s:")]
    [InlineData("s: padded")]
    [InlineData("s:bad\u0007key")]
    [InlineData("w:12345")]
    [InlineData("w:hc:has space")]
    [InlineData("x:hc:1")]
    public void RejectsInvalidKeys(string? raw) =>
        Assert.False(ReadingListLogic.TryNormalizeKey(raw, out _));

    [Fact]
    public void RejectsOverlongKeys() =>
        Assert.False(ReadingListLogic.TryNormalizeKey("s:" + new string('a', ReadingListLogic.MaxKeyLength), out _));

    [Fact]
    public void ItemGuidComesFromItemIdOrItemKey()
    {
        Assert.Equal(Id, ReadingListLogic.ItemGuidOf(new(null, null, Id.ToString(), null, null, null, null)));
        Assert.Equal(Id, ReadingListLogic.ItemGuidOf(new("i:" + Id, null, null, null, null, null, null)));
        Assert.Null(ReadingListLogic.ItemGuidOf(new("s:berserk", null, null, null, null, null, null)));
        Assert.Equal(Guid.Empty, ReadingListLogic.ItemGuidOf(new(null, null, "nope", null, null, null, null)));
    }
}

public class ReadingListParseTests
{
    private static readonly Guid Id = Guid.NewGuid();
    private static readonly string ItemKey = "i:" + Id.ToString("N");

    private static ReadingInput Input(
        string? key = null, string? kind = null, string? itemId = null, string? title = null,
        string? author = null, string? cover = null, int? mangaId = null) =>
        new(key, kind, itemId, title, author, cover, mangaId);

    private static ReadingItemInfo Book(bool audio = false) => new(Id, audio, "Dune", "Frank Herbert");

    [Fact]
    public void ItemIdBuildsTheKeyAndReadsTitleAndAuthorFromTheItem()
    {
        var parse = ReadingListLogic.Parse(Input(itemId: Id.ToString(), title: "Ignored", author: "Ignored"), Book());
        Assert.Null(parse.Error);
        var t = parse.Target!;
        Assert.Equal(ItemKey, t.Key);
        Assert.Equal("ebook", t.Kind);
        Assert.Equal(Id.ToString("N"), t.ItemId);
        Assert.Equal("Dune", t.Title);
        Assert.Equal("Frank Herbert", t.Author);
        Assert.Null(t.CoverUrl);
    }

    [Fact]
    public void ItemKindFollowsTheItemType()
    {
        Assert.Equal("audiobook", ReadingListLogic.Parse(Input(itemId: Id.ToString()), Book(audio: true)).Target!.Kind);
        Assert.Equal("manga", ReadingListLogic.Parse(Input(itemId: Id.ToString(), kind: "manga"), Book()).Target!.Kind);
        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input(itemId: Id.ToString(), kind: "audiobook"), Book()).Error);
        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input(itemId: Id.ToString(), kind: "ebook"), Book(audio: true)).Error);
        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input(itemId: Id.ToString(), kind: "manga"), Book(audio: true)).Error);
    }

    [Fact]
    public void ComicFilesDefaultToMangaButMayBeSentAsBooks()
    {
        var comic = new ReadingItemInfo(Id, false, "Berserk 1", null, IsComic: true);
        Assert.Equal("manga", ReadingListLogic.Parse(Input(itemId: Id.ToString()), comic).Target!.Kind);
        Assert.Equal("ebook", ReadingListLogic.Parse(Input(itemId: Id.ToString(), kind: "ebook"), comic).Target!.Kind);
        Assert.True(ReadingListLogic.IsComicPath("/m/Berserk/Ch 1.CBZ"));
        Assert.True(ReadingListLogic.IsComicPath("/m/x.cbr"));
        Assert.False(ReadingListLogic.IsComicPath("/m/Dune.epub"));
        Assert.False(ReadingListLogic.IsComicPath(null));
    }

    [Fact]
    public void ItemErrors()
    {
        Assert.Equal("not_found", ReadingListLogic.Parse(Input(itemId: Id.ToString()), null).Error);
        Assert.Equal("not_found", ReadingListLogic.Parse(Input(key: ItemKey, kind: "ebook"), null).Error);
        Assert.Equal("invalid_item", ReadingListLogic.Parse(Input(itemId: "nope"), Book()).Error);
        Assert.Equal("invalid_item", ReadingListLogic.Parse(Input(key: "w:hc:1", kind: "ebook", title: "A", itemId: Id.ToString()), Book()).Error);
        Assert.Equal("invalid_item", ReadingListLogic.Parse(Input(key: "i:" + Guid.NewGuid().ToString("N"), itemId: Id.ToString()), Book()).Error);
        Assert.Equal("not_found", ReadingListLogic.Parse(Input(key: "i:" + Guid.NewGuid().ToString("N")), Book()).Error);
    }

    [Fact]
    public void SeriesKeyNeedsMangaAndATitle()
    {
        var ok = ReadingListLogic.Parse(Input("s:berserk", "manga", title: " Berserk ", author: "Kentaro Miura", mangaId: 42), null);
        Assert.Null(ok.Error);
        Assert.Equal("Berserk", ok.Target!.Title);
        Assert.Equal(42, ok.Target.MangaId);
        Assert.Null(ok.Target.ItemId);

        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input("s:berserk", "ebook", title: "Berserk"), null).Error);
        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input("s:berserk", null, title: "Berserk"), null).Error);
        Assert.Equal("invalid_title", ReadingListLogic.Parse(Input("s:berserk", "manga"), null).Error);
        Assert.Equal("invalid_title", ReadingListLogic.Parse(Input("s:berserk", "manga", title: "   "), null).Error);
    }

    [Fact]
    public void SeriesMayNameALocalChapterFileForItsCover()
    {
        var withCover = ReadingListLogic.Parse(Input("s:berserk", "manga", itemId: Id.ToString(), title: "Berserk"), Book());
        Assert.Null(withCover.Error);
        Assert.Equal("s:berserk", withCover.Target!.Key);
        Assert.Equal(Id.ToString("N"), withCover.Target.ItemId);
        Assert.Equal("Berserk", withCover.Target.Title);

        // An item the caller cannot see, or an audiobook, is just left out.
        Assert.Null(ReadingListLogic.Parse(Input("s:berserk", "manga", itemId: Id.ToString(), title: "Berserk"), null).Target!.ItemId);
        Assert.Null(ReadingListLogic.Parse(Input("s:berserk", "manga", itemId: Id.ToString(), title: "Berserk"), Book(audio: true)).Target!.ItemId);
        Assert.Equal("invalid_item", ReadingListLogic.Parse(Input("s:berserk", "manga", itemId: "nope", title: "Berserk"), null).Error);
    }

    [Fact]
    public void WorkKeyNeedsABookKindAndIgnoresMangaId()
    {
        var ok = ReadingListLogic.Parse(Input("w:hc:12345", "audiobook", title: "Dune", mangaId: 7), null);
        Assert.Equal("audiobook", ok.Target!.Kind);
        Assert.Null(ok.Target.MangaId);

        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input("w:hc:12345", "manga", title: "Dune"), null).Error);
        Assert.Equal("invalid_kind", ReadingListLogic.Parse(Input("w:hc:12345", "comic", title: "Dune"), null).Error);
        Assert.Equal("invalid_key", ReadingListLogic.Parse(Input("w:12345", "ebook", title: "Dune"), null).Error);
        Assert.Equal("invalid_key", ReadingListLogic.Parse(Input(), null).Error);
    }

    [Fact]
    public void CoverMustBeHttps()
    {
        Assert.Equal("https://covers.example/1.jpg",
            ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", cover: "https://covers.example/1.jpg"), null).Target!.CoverUrl);
        Assert.Equal("invalid_cover", ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", cover: "http://covers.example/1.jpg"), null).Error);
        Assert.Equal("invalid_cover", ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", cover: "javascript:alert(1)"), null).Error);
        Assert.Equal("invalid_cover", ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", cover: "https://x.example/" + new string('a', 300)), null).Error);
        Assert.Null(ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", cover: "  "), null).Target!.CoverUrl);
    }

    [Fact]
    public void FieldsAreTrimmedAndCapped()
    {
        var parse = ReadingListLogic.Parse(
            Input("w:hc:1", "ebook", title: new string('t', 500), author: "  " + new string('a', 500)), null);
        Assert.Equal(ReadingListLogic.MaxTitleLength, parse.Target!.Title.Length);
        Assert.Equal(ReadingListLogic.MaxAuthorLength, parse.Target.Author!.Length);
        Assert.Null(ReadingListLogic.Parse(Input("w:hc:1", "ebook", title: "A", author: " "), null).Target!.Author);
    }

    [Fact]
    public void CoverIsChosenInOrder()
    {
        string? Cover(Action<ReadingEntry> set)
        {
            var entry = new ReadingEntry { Key = "x", Kind = "ebook", Title = "A B" };
            set(entry);
            return ReadingListLogic.CoverFor(entry);
        }

        Assert.Equal("/Jellio/manga/thumbnail/7?title=A%20B", Cover(e => { e.Kind = "manga"; e.MangaId = 7; e.ItemId = "ab"; }));
        Assert.Equal("/Jellio/manga/series-cover/ab?title=A%20B", Cover(e => { e.Kind = "manga"; e.ItemId = "ab"; }));
        Assert.Equal("/Jellio/books/item/ab/cover", Cover(e => e.ItemId = "ab"));
        Assert.Equal("/Jellio/books/manga-cover?url=https%3A%2F%2Fc.example%2F1.jpg", Cover(e => { e.Kind = "manga"; e.CoverUrl = "https://c.example/1.jpg"; }));
        Assert.Equal("https://c.example/1.jpg", Cover(e => e.CoverUrl = "https://c.example/1.jpg"));
        Assert.Null(Cover(_ => { }));
    }
}

public class ReadingListLogicTests
{
    private static readonly DateTime T0 = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private static ReadingTarget Target(string key, string kind = "ebook") =>
        new(key, kind, null, null, "Title " + key, null, null);

    [Fact]
    public void AddStoresOnceAndKeepsTheFirstAddedAt()
    {
        var data = new ReadingListData();
        Assert.Equal(ReadingAddOutcome.Added, ReadingListLogic.Add(data, Target("w:hc:1"), null, T0, out _));
        Assert.Equal(ReadingAddOutcome.Exists, ReadingListLogic.Add(data, Target("w:hc:1"), null, T0.AddDays(1), out var again));
        Assert.Single(data.Items);
        Assert.Equal(T0, again.AddedAt);
    }

    [Fact]
    public void ListIsCappedAtFiveHundred()
    {
        var data = new ReadingListData();
        for (var i = 0; i < ReadingListLogic.MaxItems; i++)
        {
            Assert.Equal(ReadingAddOutcome.Added, ReadingListLogic.Add(data, Target("w:hc:" + i), null, T0, out _));
        }

        Assert.Equal(ReadingAddOutcome.Full, ReadingListLogic.Add(data, Target("w:hc:extra"), null, T0, out _));
        Assert.Equal(ReadingListLogic.MaxItems, data.Items.Count);
        // An existing key is still "exists", not "full".
        Assert.Equal(ReadingAddOutcome.Exists, ReadingListLogic.Add(data, Target("w:hc:3"), null, T0, out _));
    }

    [Fact]
    public void AddedByIsNewestFirstMaxThreeAndOneEntryPerSender()
    {
        var data = new ReadingListData();
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var c = Guid.NewGuid();
        var d = Guid.NewGuid();
        ReadingListLogic.Add(data, Target("s:x", "manga"), a, T0, out _);
        ReadingListLogic.Add(data, Target("s:x", "manga"), b, T0.AddMinutes(1), out _);
        ReadingListLogic.Add(data, Target("s:x", "manga"), c, T0.AddMinutes(2), out _);
        ReadingListLogic.Add(data, Target("s:x", "manga"), a, T0.AddMinutes(3), out _);
        Assert.Equal(new[] { a, c, b }, data.Items[0].AddedBy.Select(e => e.FromUserId));

        ReadingListLogic.Add(data, Target("s:x", "manga"), d, T0.AddMinutes(4), out var entry);
        Assert.Equal(new[] { d, a, c }, entry.AddedBy.Select(e => e.FromUserId));
    }

    [Fact]
    public void RemoveAndRemoveSender()
    {
        var data = new ReadingListData();
        var friend = Guid.NewGuid();
        ReadingListLogic.Add(data, Target("w:hc:1"), friend, T0, out _);
        ReadingListLogic.Add(data, Target("w:hc:2"), null, T0, out _);

        Assert.True(ReadingListLogic.RemoveSender(data, friend));
        Assert.False(ReadingListLogic.RemoveSender(data, friend));
        Assert.All(data.Items, e => Assert.Empty(e.AddedBy));
        Assert.Equal(2, data.Items.Count);

        Assert.True(ReadingListLogic.Remove(data, "w:hc:1"));
        Assert.False(ReadingListLogic.Remove(data, "w:hc:1"));
        Assert.Single(data.Items);
    }

    [Fact]
    public void DataRoundTripsThroughJson()
    {
        var data = new ReadingListData();
        ReadingListLogic.Add(data, new ReadingTarget("s:berserk", "manga", null, 9, "Berserk", "Miura", "https://c.example/b.jpg"), Guid.NewGuid(), T0, out _);
        var back = JsonSerializer.Deserialize<ReadingListData>(JsonSerializer.Serialize(data))!;
        var entry = Assert.Single(back.Items);
        Assert.Equal("s:berserk", entry.Key);
        Assert.Equal(9, entry.MangaId);
        Assert.Equal(T0, entry.AddedAt);
        Assert.Single(entry.AddedBy);
    }
}

public class ReadingListStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "jellio-reading-" + Guid.NewGuid().ToString("N"));
    private readonly Guid _user = Guid.NewGuid();

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, true);
        }
        catch
        {
        }
    }

    private ReadingListStore NewStore() => new(TestPaths.Create(_dir));

    [Fact]
    public void PersistsAcrossInstancesAndListsNewestFirst()
    {
        var store = NewStore();
        var t = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        store.Add(_user, new("w:hc:1", "ebook", null, null, "One", null, null), null, t);
        store.Add(_user, new("w:hc:2", "audiobook", null, null, "Two", null, null), null, t.AddHours(1));

        var reopened = NewStore();
        Assert.Equal(new[] { "w:hc:2", "w:hc:1" }, reopened.Keys(_user));
        Assert.True(reopened.Has(_user, "w:hc:1"));
        Assert.Equal(2, reopened.Count(_user));
        Assert.Empty(reopened.Keys(Guid.NewGuid()));
    }

    [Fact]
    public void RemoveIsIdempotentAndRemoveManyDropsSeveral()
    {
        var store = NewStore();
        var t = DateTime.UtcNow;
        foreach (var key in new[] { "w:hc:1", "w:hc:2", "w:hc:3" })
        {
            store.Add(_user, new(key, "ebook", null, null, key, null, null), null, t);
        }

        Assert.True(store.Remove(_user, "w:hc:1"));
        Assert.False(store.Remove(_user, "w:hc:1"));
        store.RemoveMany(_user, new List<string> { "w:hc:2", "w:hc:3", "w:hc:9" });
        Assert.Empty(store.Keys(_user));
    }

    [Fact]
    public void SnapshotIsACopy()
    {
        var store = NewStore();
        store.Add(_user, new("w:hc:1", "ebook", null, null, "One", null, null), Guid.NewGuid(), DateTime.UtcNow);
        var snapshot = store.Snapshot(_user);
        snapshot[0].Title = "Changed";
        snapshot[0].AddedBy.Clear();
        Assert.Equal("One", store.Snapshot(_user)[0].Title);
        Assert.Single(store.Snapshot(_user)[0].AddedBy);
    }

    [Fact]
    public void FullListRefusesNewKeys()
    {
        var store = NewStore();
        for (var i = 0; i < ReadingListLogic.MaxItems; i++)
        {
            store.Add(_user, new("w:hc:" + i, "ebook", null, null, "t", null, null), null, DateTime.UtcNow);
        }

        Assert.Equal(ReadingAddOutcome.Full, store.Add(_user, new("w:hc:new", "ebook", null, null, "t", null, null), null, DateTime.UtcNow).Outcome);
        Assert.Equal(ReadingAddOutcome.Exists, store.Add(_user, new("w:hc:0", "ebook", null, null, "t", null, null), null, DateTime.UtcNow).Outcome);
    }
}

internal static class TestPaths
{
    private class PathsProxy : DispatchProxy
    {
        public string Dir { get; set; } = string.Empty;

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => Dir;
    }

    public static IApplicationPaths Create(string dir)
    {
        Directory.CreateDirectory(dir);
        var proxy = DispatchProxy.Create<IApplicationPaths, PathsProxy>();
        ((PathsProxy)(object)proxy).Dir = dir;
        return proxy;
    }
}
