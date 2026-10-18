using Jellio.Services.CommunitySkip;
using Xunit;

namespace Jellio.Tests;

public class TheIntroDbTests
{
    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("originalAirDate", null)]
    [InlineData("aired", "official")]
    [InlineData("dvd", "dvd")]
    [InlineData("altdvd", "dvd")]
    [InlineData("Absolute", "absolute")]
    [InlineData("alternate", "alternate")]
    [InlineData("production", "regional")]
    [InlineData("regional", "regional")]
    public void DisplayOrderMapsToV4Mapping(string? displayOrder, string? expected)
    {
        Assert.Equal(expected, TheIntroDbClient.MappingFor(displayOrder));
    }

    [Fact]
    public void AnyIdIsEnoughToQuery()
    {
        Assert.False(new TheIntroDbIds(null, null, " ").Any);
        Assert.True(new TheIntroDbIds(null, "81189", null).Any);
        Assert.True(new TheIntroDbIds(1396, null, null).Any);
    }
}
