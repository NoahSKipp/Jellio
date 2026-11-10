using System.Collections.Generic;
using System.Text.Json;
using Jellio.Services.Segments;
using Jellyfin.Database.Implementations.Enums;
using Xunit;

namespace Jellio.Tests;

public class SkipSegmentNormalizerTests
{
    private const long TicksPerSecond = 10_000_000;

    private static (MediaSegmentType, long, long) Native(MediaSegmentType type, double start, double end) =>
        (type, (long)(start * TicksPerSecond), (long)(end * TicksPerSecond));

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void MediaSegments_MapEveryKnownTypeToMilliseconds()
    {
        var result = SkipSegmentNormalizer.FromMediaSegments(
        [
            Native(MediaSegmentType.Recap, 0, 30),
            Native(MediaSegmentType.Intro, 30, 90.5),
            Native(MediaSegmentType.Commercial, 600, 660),
            Native(MediaSegmentType.Outro, 1300, 1400),
            Native(MediaSegmentType.Preview, 1400, 1430),
            Native(MediaSegmentType.Unknown, 5, 10),
        ]);

        Assert.Equal(
            new List<NormalizedSegment>
            {
                new("Recap", 0, 30_000),
                new("Intro", 30_000, 90_500),
                new("Commercial", 600_000, 660_000),
                new("Outro", 1_300_000, 1_400_000),
                new("Preview", 1_400_000, 1_430_000),
            },
            result);
    }

    [Fact]
    public void MediaSegments_KeepOnlyTheFirstIntroAndOutroLikeTheClients()
    {
        var result = SkipSegmentNormalizer.FromMediaSegments(
        [
            Native(MediaSegmentType.Intro, 10, 60),
            Native(MediaSegmentType.Intro, 70, 100),
            Native(MediaSegmentType.Commercial, 300, 330),
            Native(MediaSegmentType.Commercial, 600, 630),
        ]);

        Assert.Equal(["Intro", "Commercial", "Commercial"], result.Select(s => s.Type));
        Assert.Equal(10_000, result[0].StartMs);
    }

    [Fact]
    public void MediaSegments_DropUnusableRanges()
    {
        var result = SkipSegmentNormalizer.FromMediaSegments(
        [
            Native(MediaSegmentType.Intro, 0, 0),
            Native(MediaSegmentType.Outro, 1400, 1300),
            Native(MediaSegmentType.Recap, 0, 20),
        ]);

        Assert.Equal([new NormalizedSegment("Recap", 0, 20_000)], result);
    }

    [Fact]
    public void IntroSkipper_ReadsStartAndEndSecondsPerKey()
    {
        var result = SkipSegmentNormalizer.FromIntroSkipper(Json("""
            {
              "Introduction": { "EpisodeId": "x", "Valid": true, "Start": 12.3456, "End": 75, "ShowSkipPromptAt": 7 },
              "Credits": { "Start": 1290, "End": 1380.25 },
              "Recap": { "Start": 0, "End": 0 },
              "Preview": { "Start": 1380.25, "End": 1410 }
            }
            """));

        Assert.Equal(
            new List<NormalizedSegment>
            {
                new("Intro", 12_346, 75_000),
                new("Outro", 1_290_000, 1_380_250),
                new("Preview", 1_380_250, 1_410_000),
            },
            result);
    }

    [Fact]
    public void IntroSkipper_EmptyOrOddAnswersGiveNothing()
    {
        Assert.Empty(SkipSegmentNormalizer.FromIntroSkipper(Json("{}")));
        Assert.Empty(SkipSegmentNormalizer.FromIntroSkipper(Json("null")));
        Assert.Empty(SkipSegmentNormalizer.FromIntroSkipper(Json("""{ "Introduction": { "IntroStart": 1, "IntroEnd": 50 } }""")));
        Assert.Empty(SkipSegmentNormalizer.FromIntroSkipper(Json("""{ "Introduction": { "Start": "1", "End": "50" } }""")));
    }

    [Fact]
    public void Choose_MediaSegmentsWithAnIntroWin()
    {
        var chosen = SkipSegmentNormalizer.Choose(
            [Native(MediaSegmentType.Intro, 10, 60)],
            [new NormalizedSegment("Outro", 1_300_000, 1_400_000)]);

        Assert.Equal(SkipSegmentNormalizer.MediaSegmentsSource, chosen.Source);
        Assert.Equal([new NormalizedSegment("Intro", 10_000, 60_000)], chosen.Segments);
    }

    [Fact]
    public void Choose_AnUnusableIntroStillKeepsIntroSkipperOut()
    {
        var chosen = SkipSegmentNormalizer.Choose(
            [Native(MediaSegmentType.Intro, 0, 0)],
            [new NormalizedSegment("Intro", 10_000, 60_000)]);

        Assert.Equal(SkipSegmentNormalizer.MediaSegmentsSource, chosen.Source);
        Assert.Empty(chosen.Segments);
    }

    [Fact]
    public void Choose_IntroSkipperWhenMediaSegmentsHaveNoIntroOrOutro()
    {
        var fromIntroSkipper = new List<NormalizedSegment> { new("Intro", 10_000, 60_000) };
        var chosen = SkipSegmentNormalizer.Choose([Native(MediaSegmentType.Recap, 0, 20)], fromIntroSkipper);

        Assert.Equal(SkipSegmentNormalizer.IntroSkipperSource, chosen.Source);
        Assert.Equal(fromIntroSkipper, chosen.Segments);
    }

    [Fact]
    public void Choose_OtherMediaSegmentsWhenIntroSkipperHasNothing()
    {
        var chosen = SkipSegmentNormalizer.Choose([Native(MediaSegmentType.Recap, 0, 20)], []);

        Assert.Equal(SkipSegmentNormalizer.MediaSegmentsSource, chosen.Source);
        Assert.Equal([new NormalizedSegment("Recap", 0, 20_000)], chosen.Segments);
    }

    [Fact]
    public void Choose_NoneWhenNeitherHasAnything()
    {
        var chosen = SkipSegmentNormalizer.Choose([], []);

        Assert.Equal(SkipSegmentNormalizer.NoSource, chosen.Source);
        Assert.Empty(chosen.Segments);
    }
}
