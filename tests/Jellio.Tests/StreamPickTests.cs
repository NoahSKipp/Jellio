using System;
using System.Linq;
using Jellio.Services.Manga;
using Xunit;

namespace Jellio.Tests;

public class StreamPickTests
{
    private static StreamTitle Entry(int id, string source, int chapters) =>
        new(id, "Berserk", "berserk", source + " (EN)", source, chapters);

    [Fact]
    public void ThePreferredSourceWinsWhateverItsChapterCount()
    {
        var ordered = MangaStreamService.OrderForPick(
            new[] { Entry(1, "MangaDex", 380), Entry(2, "Comick", 120) },
            new[] { "comick", "mangadex" });
        Assert.Equal(2, ordered.First().MangaId);
    }

    [Fact]
    public void WithoutAPreferenceTheMostChaptersWinsThenTheOldestEntry()
    {
        var ordered = MangaStreamService.OrderForPick(
            new[] { Entry(5, "A", 100), Entry(3, "B", 380), Entry(4, "C", 380) },
            Array.Empty<string>());
        Assert.Equal(new[] { 3, 4, 5 }, ordered.Select(title => title.MangaId).ToArray());
    }

    [Fact]
    public void SourceNamesMatchWithOrWithoutTheLanguage()
    {
        Assert.True(MangaStreamService.SourceMatches("MangaDex", "MangaDex (EN)"));
        Assert.True(MangaStreamService.SourceMatches("mangadex", "MangaDex"));
        Assert.False(MangaStreamService.SourceMatches("Manga", "MangaDex"));
    }
}
