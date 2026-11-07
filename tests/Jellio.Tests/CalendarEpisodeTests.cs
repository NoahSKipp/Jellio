using System;
using System.Collections.Generic;
using System.Text.Json;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class CalendarEpisodeTests
{
    private static readonly DateTime Today = new(2026, 11, 7, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FutureNextEpisodeToAirReturnsEpisode()
    {
        const string json = """
            {
              "next_episode_to_air": {
                "air_date": "2026-11-13",
                "episode_number": 5,
                "season_number": 4
              }
            }
            """;

        using var doc = JsonDocument.Parse(json);
        var entry = CalendarService.PickNextEpisode(doc, Today);
        Assert.NotNull(entry);
        Assert.Equal("episode", entry.Kind);
        Assert.Equal("S4E5", entry.Detail);
        Assert.Equal(new DateTime(2026, 11, 13, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void PastNextEpisodeToAirReturnsNull()
    {
        // Episode aired yesterday (Nov 6), today is Nov 7
        const string json = """
            {
              "next_episode_to_air": {
                "air_date": "2026-11-06",
                "episode_number": 4,
                "season_number": 4
              }
            }
            """;

        using var doc = JsonDocument.Parse(json);
        var entry = CalendarService.PickNextEpisode(doc, Today);
        Assert.Null(entry);
    }

    [Fact]
    public void PlayedNextEpisodeToAirReturnsNull()
    {
        const string json = """
            {
              "next_episode_to_air": {
                "air_date": "2026-11-07",
                "episode_number": 4,
                "season_number": 4
              }
            }
            """;

        using var doc = JsonDocument.Parse(json);
        var played = new HashSet<(int Season, int Episode)> { (4, 4) };
        var entry = CalendarService.PickNextEpisode(doc, Today, played);
        Assert.Null(entry);
    }

    [Fact]
    public void PickSeasonNumberToSearchResolvesFromNextOrLastOrSeasons()
    {
        const string withNext = """
            {
              "next_episode_to_air": { "season_number": 4 }
            }
            """;
        using var docNext = JsonDocument.Parse(withNext);
        Assert.Equal(4, CalendarService.PickSeasonNumberToSearch(docNext));

        const string withLast = """
            {
              "last_episode_to_air": { "season_number": 3 }
            }
            """;
        using var docLast = JsonDocument.Parse(withLast);
        Assert.Equal(3, CalendarService.PickSeasonNumberToSearch(docLast));

        const string withSeasons = """
            {
              "seasons": [
                { "season_number": 0 },
                { "season_number": 1 },
                { "season_number": 2 }
              ]
            }
            """;
        using var docSeasons = JsonDocument.Parse(withSeasons);
        Assert.Equal(2, CalendarService.PickSeasonNumberToSearch(docSeasons));
    }

    [Fact]
    public void SeasonEpisodesReturnsFirstFutureUnplayedEpisode()
    {
        const string seasonJson = """
            {
              "season_number": 4,
              "episodes": [
                { "air_date": "2026-10-30", "season_number": 4, "episode_number": 3 },
                { "air_date": "2026-11-06", "season_number": 4, "episode_number": 4 },
                { "air_date": "2026-11-13", "season_number": 4, "episode_number": 5 },
                { "air_date": "2026-11-20", "season_number": 4, "episode_number": 6 }
              ]
            }
            """;

        using var doc = JsonDocument.Parse(seasonJson);
        var played = new HashSet<(int Season, int Episode)> { (4, 3), (4, 4) };
        var entry = CalendarService.PickNextEpisodeFromSeason(doc, Today, played);

        Assert.NotNull(entry);
        Assert.Equal("episode", entry.Kind);
        Assert.Equal("S4E5", entry.Detail);
        Assert.Equal(new DateTime(2026, 11, 13, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void ParseSeasonEpisodeExtractsCorrectNumbers()
    {
        var (s1, e1) = CalendarService.ParseSeasonEpisode("S4E5");
        Assert.Equal(4, s1);
        Assert.Equal(5, e1);

        var (s2, e2) = CalendarService.ParseSeasonEpisode("S12E108");
        Assert.Equal(12, s2);
        Assert.Equal(108, e2);

        var (s3, e3) = CalendarService.ParseSeasonEpisode("Digital release");
        Assert.Null(s3);
        Assert.Null(e3);
    }

    [Fact]
    public void ShouldSearchSeasonFallbackChecksNextRecentLastOrInProduction()
    {
        using var docNext = JsonDocument.Parse("""{ "next_episode_to_air": { "season_number": 2 } }""");
        Assert.True(CalendarService.ShouldSearchSeasonFallback(docNext, Today));

        using var docRecentLast = JsonDocument.Parse("""{ "last_episode_to_air": { "air_date": "2026-10-25", "season_number": 2 } }""");
        Assert.True(CalendarService.ShouldSearchSeasonFallback(docRecentLast, Today));

        using var docOldLast = JsonDocument.Parse("""{ "last_episode_to_air": { "air_date": "2024-05-10", "season_number": 2 }, "in_production": false }""");
        Assert.False(CalendarService.ShouldSearchSeasonFallback(docOldLast, Today));

        using var docInProd = JsonDocument.Parse("""{ "in_production": true }""");
        Assert.True(CalendarService.ShouldSearchSeasonFallback(docInProd, Today));
    }
}
