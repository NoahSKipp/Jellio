using System.Text.Json;
using System.Text.Json.Nodes;
using Jellio.Services.Manga;
using Xunit;

namespace Jellio.Tests;

public class MangaDetailsTests
{
    [Theory]
    [InlineData("ONGOING", "Ongoing")]
    [InlineData("PUBLISHING_FINISHED", "Publishing finished")]
    [InlineData("ON_HIATUS", "On hiatus")]
    [InlineData("Completed", "Completed")]
    [InlineData("Something new", "Something new")]
    public void StatusReadsAsAWord(string raw, string expected)
    {
        Assert.Equal(expected, MangaStatusText.Format(raw));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("UNKNOWN")]
    public void AnUnknownStatusIsLeftOut(string? raw)
    {
        Assert.Null(MangaStatusText.Format(raw));
    }

    [Fact]
    public void ReadsTheDetailsOfASeries()
    {
        var manga = JsonNode.Parse("""
            { "author": " Lim Hyeong ", "artist": "Studio 389", "description": "A tower.",
              "genre": ["Action", "action", "", "Fantasy"], "status": "ONGOING" }
            """)!.AsObject();

        var details = SuwayomiClient.ReadMangaDetails(manga);

        Assert.NotNull(details);
        Assert.Equal("Lim Hyeong", details.Author);
        Assert.Equal("Studio 389", details.Artist);
        Assert.Equal("A tower.", details.Description);
        Assert.Equal(new[] { "Action", "Fantasy" }, details.Genres);
        Assert.Equal("Ongoing", details.Status);
    }

    [Fact]
    public void MissingFieldsStayNull()
    {
        var details = SuwayomiClient.ReadMangaDetails(JsonNode.Parse("""{ "author": null, "genre": [] }""")!.AsObject());

        Assert.NotNull(details);
        Assert.Null(details.Author);
        Assert.Null(details.Artist);
        Assert.Null(details.Description);
        Assert.Empty(details.Genres);
        Assert.Null(details.Status);
        Assert.Null(SuwayomiClient.ReadMangaDetails(null));
    }

    [Fact]
    public void ASeriesWithoutDetailsKeepsTheOldShape()
    {
        var series = new StreamSeries(1, "Title", null, null, "title", new List<StreamChapter>());

        using var json = JsonDocument.Parse(JsonSerializer.Serialize(series));

        Assert.Equal("Title", json.RootElement.GetProperty("Title").GetString());
        Assert.Equal(JsonValueKind.Null, json.RootElement.GetProperty("Artist").ValueKind);
        Assert.Equal(JsonValueKind.Null, json.RootElement.GetProperty("Genres").ValueKind);
    }

    [Fact]
    public void ASeriesWithNoDetailsIsFetchedFromItsSource()
    {
        var bare = SuwayomiClient.ReadMangaDetails(JsonNode.Parse("""{ "author": "", "artist": null, "description": " ", "genre": [], "status": "UNKNOWN" }""")!.AsObject());

        Assert.NotNull(bare);
        Assert.True(SuwayomiClient.LacksSourceDetails(bare));
    }

    [Theory]
    [InlineData("""{ "author": "Lim Hyeong", "genre": [] }""")]
    [InlineData("""{ "description": "A tower.", "genre": [] }""")]
    [InlineData("""{ "genre": ["Action"] }""")]
    [InlineData("""{ "artist": "Studio 389", "genre": [] }""")]
    public void ASeriesWithAnyDetailIsNotFetchedAgain(string json)
    {
        var details = SuwayomiClient.ReadMangaDetails(JsonNode.Parse(json)!.AsObject());

        Assert.NotNull(details);
        Assert.False(SuwayomiClient.LacksSourceDetails(details));
    }
}
