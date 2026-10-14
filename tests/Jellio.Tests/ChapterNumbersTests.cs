using Jellio.Services.Manga;
using Xunit;

namespace Jellio.Tests;

public class ChapterNumbersTests
{
    [Theory]
    [InlineData("Chapter 0.01", 0.01f)]
    [InlineData("Chapter 00", 0f)]
    [InlineData("Ch.000 - The Black Swordsman", 0f)]
    [InlineData("Vol.1 Ch.5 - Guardians of Desire", 5f)]
    [InlineData("0.02", 0.02f)]
    [InlineData("Episode 12", 12f)]
    [InlineData("Chapter 12,5", 12.5f)]
    public void ReadsTheNumberFromTheNameWhenSuwayomiHasNone(string name, float expected)
    {
        Assert.Equal(expected, ChapterNumbers.Resolve(-1f, name), 3);
    }

    [Theory]
    [InlineData("Vol. 2 Extra")]
    [InlineData("")]
    public void ANameWithoutANumberStaysUnknown(string name)
    {
        Assert.Equal(-1f, ChapterNumbers.Resolve(-1f, name));
    }

    [Theory]
    [InlineData("Prologue 1", 1f, 0.0001f)]
    [InlineData("Prologue 3", 3f, 0.0003f)]
    [InlineData("Prologue", -1f, 0.0001f)]
    [InlineData("Vol.1 Prologue 2", 2f, 0.0002f)]
    public void ProloguesGetTheirOwnRange(string name, float reported, float expected)
    {
        Assert.Equal(expected, ChapterNumbers.Resolve(reported, name), 5);
        Assert.NotEqual(ChapterNumbers.Resolve(reported, name), ChapterNumbers.Resolve(-1f, "Chapter " + (int)reported));
    }

    [Fact]
    public void SuwayomisOwnNumberWins()
    {
        Assert.Equal(7f, ChapterNumbers.Resolve(7f, "Chapter 300"));
    }
}
