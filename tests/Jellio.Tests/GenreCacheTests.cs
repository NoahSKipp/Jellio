using System;
using System.Linq;
using Jellio.Services;
using MediaBrowser.Controller.Entities.Movies;
using Xunit;

namespace Jellio.Tests;

public class GenreCacheTests
{
    [Fact]
    public void DistinctTitlesFoldsVersionsOfOneTitle()
    {
        var first = new Movie { Id = Guid.NewGuid(), Name = "Heat", ProductionYear = 1995, PresentationUniqueKey = "heat" };
        var version = new Movie { Id = Guid.NewGuid(), Name = "Heat", ProductionYear = 1995, PresentationUniqueKey = "heat-2160p" };
        var sameKey = new Movie { Id = Guid.NewGuid(), Name = "Heat (Director's Cut)", ProductionYear = 1995, PresentationUniqueKey = "heat" };
        var remake = new Movie { Id = Guid.NewGuid(), Name = "Heat", ProductionYear = 2026, PresentationUniqueKey = "heat-2026" };
        var other = new Movie { Id = Guid.NewGuid(), Name = "Ronin", ProductionYear = 1998 };

        var result = GenreCache.DistinctTitles([first, version, sameKey, first, remake, other]).ToList();

        Assert.Equal([first, remake, other], result);
    }
}
