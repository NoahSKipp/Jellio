using System;
using System.Text.Json;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class CalendarDigitalReleaseTests
{
    private static readonly DateTime Now = new(2026, 11, 6, 0, 0, 0, DateTimeKind.Utc);

    private static CalendarEntry? Pick(string json, DateTime? now = null)
    {
        using var doc = JsonDocument.Parse(json);
        return CalendarService.PickDigitalRelease(doc, now ?? Now);
    }

    [Fact]
    public void OnlyFutureType4DatesReturnsNearestFutureDate()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-12-15T00:00:00.000Z" },
                    { "type": 4, "release_date": "2026-11-20T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        var entry = Pick(json);
        Assert.NotNull(entry);
        Assert.Equal("digital-release", entry.Kind);
        Assert.Equal("Digital release", entry.Detail);
        Assert.Equal(new DateTime(2026, 11, 20, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void PastType4PlusFutureType4ReturnsNull()
    {
        const string jsonPastFirst = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-06-16T00:00:00.000Z" },
                    { "type": 4, "release_date": "2026-11-30T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        Assert.Null(Pick(jsonPastFirst));

        const string jsonFutureFirst = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-11-30T00:00:00.000Z" },
                    { "type": 4, "release_date": "2026-06-16T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        Assert.Null(Pick(jsonFutureFirst));
    }

    [Fact]
    public void OnlyPastType4DatesReturnsNull()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-06-16T00:00:00.000Z" },
                    { "type": 4, "release_date": "2026-08-01T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        Assert.Null(Pick(json));
    }

    [Fact]
    public void TheatricalType3InPastPlusFutureType4ReturnsFutureDate()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 3, "release_date": "2026-06-16T00:00:00.000Z" },
                    { "type": 4, "release_date": "2026-11-30T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        var entry = Pick(json);
        Assert.NotNull(entry);
        Assert.Equal("digital-release", entry.Kind);
        Assert.Equal(new DateTime(2026, 11, 30, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void UsRegionPreferredOverEarlierListedGbRegion()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "GB",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-12-01T00:00:00.000Z" }
                  ]
                },
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-11-15T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        var entry = Pick(json);
        Assert.NotNull(entry);
        Assert.Equal(new DateTime(2026, 11, 15, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void FallbackToFirstRegionWhenNoUsRegion()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "GB",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-12-01T00:00:00.000Z" }
                  ]
                },
                {
                  "iso_3166_1": "FR",
                  "release_dates": [
                    { "type": 4, "release_date": "2026-11-15T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        var entry = Pick(json);
        Assert.NotNull(entry);
        Assert.Equal(new DateTime(2026, 12, 1, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void InvalidGarbageReleaseDateStringsIgnoredWithoutThrowing()
    {
        const string json = """
            {
              "results": [
                {
                  "iso_3166_1": "US",
                  "release_dates": [
                    { "type": 4, "release_date": "not-a-date" },
                    { "type": 4, "release_date": "" },
                    { "type": "four", "release_date": "2026-11-10T00:00:00.000Z" },
                    { "type": 4 },
                    { "type": 4, "release_date": "2026-11-25T00:00:00.000Z" }
                  ]
                }
              ]
            }
            """;

        var entry = Pick(json);
        Assert.NotNull(entry);
        Assert.Equal(new DateTime(2026, 11, 25, 0, 0, 0, DateTimeKind.Utc), entry.Date);
    }

    [Fact]
    public void NoResultsPropertyReturnsNull()
    {
        const string json = """
            {
              "id": 12345
            }
            """;

        Assert.Null(Pick(json));
    }
}
