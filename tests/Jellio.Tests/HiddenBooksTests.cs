using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Filters;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Dto;
using Xunit;

namespace Jellio.Tests;

public class HiddenBooksTests
{
    private static readonly Guid A = Guid.Parse("0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9");
    private static readonly Guid B = Guid.Parse("11111111-2222-3333-4444-555555555555");
    private static readonly Guid Folder = Guid.Parse("99999999-8888-7777-6666-555555555555");

    [Fact]
    public void IdsReadsOnlyItemKeys()
    {
        var ids = HiddenBooks.Ids(["i:" + A.ToString("N"), "s:berserk", "i:not-a-guid", "I:" + B]);
        Assert.Equal(new HashSet<Guid> { A, B }, ids);
    }

    [Fact]
    public void ResumeDropsHiddenBooksAndKeepsTheRest()
    {
        var hiddenBook = new BaseItemDto { Id = A, Type = BaseItemKind.AudioBook, ParentId = Folder, Album = "Verity" };
        var otherBook = new BaseItemDto { Id = B, Type = BaseItemKind.AudioBook, ParentId = Guid.NewGuid(), Album = "Other" };
        var episode = new BaseItemDto { Id = Guid.NewGuid(), Type = BaseItemKind.Episode };

        var kept = HiddenBooksResumeFilter.Visible([hiddenBook, otherBook, episode], [A], []);

        Assert.Equal(new[] { B, episode.Id }, kept.Select(item => item.Id));
    }

    [Fact]
    public void ResumeDropsOtherTracksOfAHiddenAudiobook()
    {
        var track = new BaseItemDto { Id = Guid.NewGuid(), Type = BaseItemKind.AudioBook, ParentId = Folder, Album = "Verity" };
        var elsewhere = new BaseItemDto { Id = Guid.NewGuid(), Type = BaseItemKind.AudioBook, ParentId = Folder, Album = "Another album" };

        var kept = HiddenBooksResumeFilter.Visible([track, elsewhere], [A], [(Folder, "Verity")]);

        Assert.Equal(new[] { elsewhere.Id }, kept.Select(item => item.Id));
    }
}
