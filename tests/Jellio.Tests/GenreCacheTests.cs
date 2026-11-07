using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellio.Tests;

public class GenreCacheTests
{
    private class TestHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private class TestHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(send(request));
    }

    public class CustomDtoProxy : DispatchProxy
    {
        public Func<IReadOnlyList<MediaBrowser.Controller.Entities.BaseItem>, IReadOnlyList<BaseItemDto>>? Converter { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == nameof(IDtoService.GetBaseItemDtos))
            {
                var items = (IReadOnlyList<MediaBrowser.Controller.Entities.BaseItem>)args![0]!;
                if (Converter != null)
                {
                    return Converter(items);
                }

                return items.Select(it => new BaseItemDto
                {
                    Id = it.Id,
                    Name = it.Name,
                    ProductionYear = it.ProductionYear,
                }).ToList();
            }

            return null;
        }
    }

    public class CustomLibraryProxy : DispatchProxy
    {
        public List<MediaBrowser.Controller.Entities.BaseItem> Items { get; } = new();

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == nameof(ILibraryManager.GetItemList))
            {
                return Items;
            }

            return null;
        }
    }

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

    [Fact]
    public void GenerateDeterministicIdReturnsConsistentAndDistinctGuids()
    {
        var id1 = GenreCache.GenerateDeterministicId("movie", "550");
        var id2 = GenreCache.GenerateDeterministicId("movie", "550");
        var idTv = GenreCache.GenerateDeterministicId("tv", "550");
        var idOther = GenreCache.GenerateDeterministicId("movie", "551");

        Assert.NotEqual(Guid.Empty, id1);
        Assert.Equal(id1, id2);
        Assert.NotEqual(id1, idTv);
        Assert.NotEqual(id1, idOther);
    }

    [Fact]
    public async Task GetRowAsyncSupportsPagingQueriesWithoutVirtualExpansion()
    {
        var libProxy = DispatchProxy.Create<ILibraryManager, CustomLibraryProxy>();
        var libTracker = (CustomLibraryProxy)(object)libProxy;
        libTracker.Items.Add(new Movie { Id = Guid.NewGuid(), Name = "Action 1", ProductionYear = 2020 });
        libTracker.Items.Add(new Movie { Id = Guid.NewGuid(), Name = "Action 2", ProductionYear = 2021 });
        libTracker.Items.Add(new Movie { Id = Guid.NewGuid(), Name = "Action 3", ProductionYear = 2022 });

        var dtoProxy = DispatchProxy.Create<IDtoService, CustomDtoProxy>();
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var (page1, total1) = await cache.GetRowAsync(user, "Action", [BaseItemKind.Movie], Guid.Empty, 0, 2, false);
        Assert.Equal(3, total1);
        Assert.Equal(2, page1.Count);
        Assert.Equal("Action 1", page1[0].Name);
        Assert.Equal("Action 2", page1[1].Name);

        var (page2, total2) = await cache.GetRowAsync(user, "Action", [BaseItemKind.Movie], Guid.Empty, 2, 2, false);
        Assert.Equal(3, total2);
        Assert.Single(page2);
        Assert.Equal("Action 3", page2[0].Name);
    }

    [Fact]
    public async Task GetRowAsyncVirtualExpansionReturnsDeterministicGuidsAndBaseItemDtoFields()
    {
        var libProxy = DispatchProxy.Create<ILibraryManager, CustomLibraryProxy>();
        var dtoProxy = DispatchProxy.Create<IDtoService, CustomDtoProxy>();

        const string tmdbJson = """
            {
              "page": 1,
              "results": [
                {
                  "id": 101,
                  "title": "Virtual Action Movie",
                  "release_date": "2024-06-15",
                  "vote_average": 8.7,
                  "overview": "An epic adventure.",
                  "poster_path": "/poster1.jpg"
                }
              ]
            }
            """;

        var handler = new TestHttpMessageHandler(req =>
        {
            Assert.Contains("discover/movie", req.RequestUri?.ToString() ?? string.Empty);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(tmdbJson, Encoding.UTF8, "application/json"),
            };
        });

        var factory = new TestHttpClientFactory(handler);
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger, factory);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var (items, total) = await cache.GetRowAsync(
            user,
            "Action",
            [BaseItemKind.Movie],
            Guid.Empty,
            0,
            10,
            enableVirtual: true,
            tokenOverride: "mock_token");

        Assert.Equal(1, total);
        Assert.Single(items);

        var item = items[0];
        var expectedGuid = GenreCache.GenerateDeterministicId("movie", "101");
        Assert.Equal(expectedGuid, item.Id);
        Assert.Equal("Virtual Action Movie", item.Name);
        Assert.Equal(2024, item.ProductionYear);
        Assert.Equal(8.7f, item.CommunityRating);
        Assert.Equal(LocationType.Virtual, item.LocationType);
        Assert.Equal(BaseItemKind.Movie, item.Type);
        Assert.NotNull(item.ProviderIds);
        Assert.Equal("101", item.ProviderIds["Tmdb"]);
        Assert.Equal("An epic adventure.", item.Overview);
    }

    [Fact]
    public async Task GetRowAsyncVirtualExpansionDeduplicatesAgainstLocalItems()
    {
        var libProxy = DispatchProxy.Create<ILibraryManager, CustomLibraryProxy>();
        var libTracker = (CustomLibraryProxy)(object)libProxy;
        libTracker.Items.Add(new Movie { Id = Guid.NewGuid(), Name = "Existing Film", ProductionYear = 2023 });

        var dtoProxy = DispatchProxy.Create<IDtoService, CustomDtoProxy>();
        var dtoTracker = (CustomDtoProxy)(object)dtoProxy;
        dtoTracker.Converter = items => items.Select(it => new BaseItemDto
        {
            Id = it.Id,
            Name = it.Name,
            ProductionYear = it.ProductionYear,
            ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "201" },
        }).ToList();

        const string tmdbJson = """
            {
              "page": 1,
              "results": [
                {
                  "id": 201,
                  "title": "Existing Film",
                  "release_date": "2023-01-01",
                  "vote_average": 7.5
                },
                {
                  "id": 202,
                  "title": "Brand New Virtual Movie",
                  "release_date": "2024-02-02",
                  "vote_average": 8.0
                }
              ]
            }
            """;

        var handler = new TestHttpMessageHandler(req => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(tmdbJson, Encoding.UTF8, "application/json"),
        });

        var factory = new TestHttpClientFactory(handler);
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger, factory);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var (items, total) = await cache.GetRowAsync(
            user,
            "Action",
            [BaseItemKind.Movie],
            Guid.Empty,
            0,
            10,
            enableVirtual: true,
            tokenOverride: "mock_token");

        // Local item + 1 new virtual item (the duplicate 201 is excluded)
        Assert.Equal(2, total);
        Assert.Equal(2, items.Count);
        Assert.Equal("Existing Film", items[0].Name);
        Assert.Equal("Brand New Virtual Movie", items[1].Name);
        Assert.Equal(GenreCache.GenerateDeterministicId("movie", "202"), items[1].Id);
    }

    [Fact]
    public async Task GetRowAsyncVirtualExpansionPopulatesImageTagsAndFallbackKey()
    {
        var libProxy = DispatchProxy.Create<ILibraryManager, CustomLibraryProxy>();
        var dtoProxy = DispatchProxy.Create<IDtoService, CustomDtoProxy>();

        var results = Enumerable.Range(1, 20).Select(i => $$"""
            {
              "id": {{300 + i}},
              "title": "Poster Test Movie {{i}}",
              "release_date": "2025-05-01",
              "vote_average": 9.1,
              "poster_path": "/path_to_poster.jpg",
              "backdrop_path": "/path_to_backdrop.jpg"
            }
            """);
        var tmdbJson = $$"""
            {
              "page": 1,
              "total_pages": 5,
              "results": [ {{string.Join(",", results)}} ]
            }
            """;

        string? capturedQuery = null;
        var handler = new TestHttpMessageHandler(req =>
        {
            capturedQuery = req.RequestUri?.Query;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(tmdbJson, Encoding.UTF8, "application/json"),
            };
        });

        var factory = new TestHttpClientFactory(handler);
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger, factory);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var (items, total) = await cache.GetRowAsync(
            user,
            "Action",
            [BaseItemKind.Movie],
            Guid.Empty,
            0,
            10,
            enableVirtual: true,
            tokenOverride: null);

        Assert.Equal(10, items.Count);
        Assert.True(total > 20); // Not exhausted because total_pages is 5 and 20 items returned
        var item = items[0];
        Assert.NotNull(item.ImageTags);
        Assert.True(item.ImageTags.ContainsKey(ImageType.Primary));
        Assert.Equal("https://image.tmdb.org/t/p/w500/path_to_poster.jpg", item.ImageTags[ImageType.Primary]);
        Assert.NotNull(item.BackdropImageTags);
        Assert.Single(item.BackdropImageTags);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/path_to_backdrop.jpg", item.BackdropImageTags[0]);
        Assert.NotNull(capturedQuery);
        Assert.Contains("api_key=4219e299c89411838049ab0dab19ebd5", capturedQuery);
        Assert.Contains("primary_release_date.lte=", capturedQuery);
    }

    [Fact]
    public async Task GetVirtualItemsAsync_FiltersUnreleasedFutureMedia()
    {
        var libProxy = DispatchProxy.Create<ILibraryManager, CustomLibraryProxy>();
        var dtoProxy = DispatchProxy.Create<IDtoService, CustomDtoProxy>();

        var tmdbJson = """
            {
              "page": 1,
              "total_pages": 1,
              "results": [
                {
                  "id": 901,
                  "title": "Future Unreleased Movie",
                  "release_date": "2099-12-31",
                  "vote_average": 9.9
                },
                {
                  "id": 902,
                  "title": "Already Released Movie",
                  "release_date": "2020-01-01",
                  "vote_average": 8.5
                }
              ]
            }
            """;

        var handler = new TestHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(tmdbJson, Encoding.UTF8, "application/json"),
        });

        var factory = new TestHttpClientFactory(handler);
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger, factory);

        var virtuals = await cache.GetVirtualItemsAsync("Action", [BaseItemKind.Movie], 10);
        Assert.Single(virtuals);
        Assert.Equal("Already Released Movie", virtuals[0].Name);
    }
}
