using System;
using System.Collections.Generic;
using System.Reflection;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Xunit;

namespace Jellio.Tests;

public class HomeRowCachesTests
{
    // A session manager that only records event subscriptions, so a test
    // can raise PlaybackStart/PlaybackStopped.
    public class SessionEvents : DispatchProxy
    {
        public List<Delegate> Handlers { get; } = new();

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod is null)
            {
                return null;
            }

            if (targetMethod.Name.StartsWith("add_", StringComparison.Ordinal))
            {
                Handlers.Add((Delegate)args![0]!);
                return null;
            }

            if (targetMethod.Name.StartsWith("remove_", StringComparison.Ordinal))
            {
                Handlers.Remove((Delegate)args![0]!);
                return null;
            }

            return targetMethod.ReturnType.IsValueType && targetMethod.ReturnType != typeof(void) ? Activator.CreateInstance(targetMethod.ReturnType) : null;
        }

        public void RaisePlayback()
        {
            foreach (var handler in Handlers.ToArray())
            {
                handler.DynamicInvoke(null, new PlaybackStopEventArgs());
            }
        }
    }

    private static (CommunityWatchingCache Cache, SessionEvents Events) NewCache()
    {
        var sessions = DispatchProxy.Create<ISessionManager, SessionEvents>();
        return (new CommunityWatchingCache(sessions), (SessionEvents)(object)sessions);
    }

    [Fact]
    public void AnAnswerIsReusedUntilSomeonePlaysSomething()
    {
        var (cache, events) = NewCache();
        cache.Set("reader|", "rows");
        Assert.True(cache.TryGet("reader|", out var hit));
        Assert.Equal("rows", hit);

        events.RaisePlayback();

        Assert.False(cache.TryGet("reader|", out _));
    }

    [Fact]
    public void DisposingStopsListening()
    {
        var (cache, events) = NewCache();
        Assert.Equal(2, events.Handlers.Count);
        cache.Dispose();
        Assert.Empty(events.Handlers);
    }

    [Fact]
    public void GenreTypesAreParsedAndUnknownOnesDropped()
    {
        Assert.Equal(new[] { BaseItemKind.Movie, BaseItemKind.Series }, GenreCache.ParseTypes("Movie,Series"));
        Assert.Equal(new[] { BaseItemKind.Movie, BaseItemKind.Series }, GenreCache.ParseTypes(null));
        Assert.Equal(new[] { BaseItemKind.Movie }, GenreCache.ParseTypes("movie, Nonsense"));
    }

    public class DtoServiceProxy : DispatchProxy
    {
        public bool FailBatch { get; set; }
        public int SingleCalls { get; set; }
        public int BatchCalls { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == nameof(MediaBrowser.Controller.Dto.IDtoService.GetBaseItemDto))
            {
                SingleCalls++;
                return new MediaBrowser.Model.Dto.BaseItemDto { Name = "FromSingle" };
            }

            if (targetMethod?.Name == nameof(MediaBrowser.Controller.Dto.IDtoService.GetBaseItemDtos))
            {
                if (FailBatch)
                {
                    throw new MissingMethodException("Simulated JF12 signature mismatch");
                }

                BatchCalls++;
                return new List<MediaBrowser.Model.Dto.BaseItemDto> { new() { Name = "FromBatch" } };
            }

            return null;
        }
    }

    public class LibraryManagerProxy : DispatchProxy
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
    public void GenreRowFallsBackGracefullyIfBatchDtoFails()
    {
        var dtoProxy = DispatchProxy.Create<MediaBrowser.Controller.Dto.IDtoService, DtoServiceProxy>();
        var dtoTracker = (DtoServiceProxy)(object)dtoProxy;
        dtoTracker.FailBatch = true;

        var libProxy = DispatchProxy.Create<ILibraryManager, LibraryManagerProxy>();
        var libTracker = (LibraryManagerProxy)(object)libProxy;
        libTracker.Items.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "TestMovie" });

        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var dtos = cache.GetRow(user, "Action", [BaseItemKind.Movie], Guid.Empty, 20);

        Assert.Single(dtos);
        Assert.Equal("FromSingle", dtos[0].Name);
        Assert.Equal(1, dtoTracker.SingleCalls);
    }

    [Fact]
    public void GenreRowUsesBatchDtoWhenAvailable()
    {
        var dtoProxy = DispatchProxy.Create<MediaBrowser.Controller.Dto.IDtoService, DtoServiceProxy>();
        var dtoTracker = (DtoServiceProxy)(object)dtoProxy;
        dtoTracker.FailBatch = false;

        var libProxy = DispatchProxy.Create<ILibraryManager, LibraryManagerProxy>();
        var libTracker = (LibraryManagerProxy)(object)libProxy;
        libTracker.Items.Add(new MediaBrowser.Controller.Entities.Movies.Movie { Name = "TestMovie" });

        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<GenreCache>.Instance;
        var cache = new GenreCache(libProxy, dtoProxy, logger);
        var user = new Jellyfin.Database.Implementations.Entities.User("testUser", "Default", "Default");

        var dtos = cache.GetRow(user, "Action", [BaseItemKind.Movie], Guid.Empty, 20);

        Assert.Single(dtos);
        Assert.Equal("FromBatch", dtos[0].Name);
        Assert.Equal(1, dtoTracker.BatchCalls);
        Assert.Equal(0, dtoTracker.SingleCalls);
    }
}
