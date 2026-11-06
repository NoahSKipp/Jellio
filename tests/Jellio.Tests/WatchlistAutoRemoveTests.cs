using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Claims;
using Jellio.Controllers;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellio.Tests;

public class WatchlistAutoRemoveTests
{
    private class TestLogger<T> : ILogger<T>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) { }
    }

    private class DynamicProxy : DispatchProxy
    {
        public Func<MethodInfo, object?[], object?>? Handler { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod == null) return null;
            if (Handler != null)
            {
                return Handler(targetMethod, args ?? Array.Empty<object?>());
            }

            if (targetMethod.ReturnType == typeof(void))
                return null;
            if (targetMethod.ReturnType.IsValueType)
                return Activator.CreateInstance(targetMethod.ReturnType);
            return null;
        }

        public static T Create<T>(Func<MethodInfo, object?[], object?>? handler = null) where T : class
        {
            var proxy = DispatchProxy.Create<T, DynamicProxy>();
            ((DynamicProxy)(object)proxy).Handler = handler;
            return proxy;
        }
    }

    private static (IApplicationPaths AppPaths, string TempDir) CreateTempAppPaths()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "jellio-test-" + Guid.NewGuid());
        Directory.CreateDirectory(tempDir);
        var appPaths = DynamicProxy.Create<IApplicationPaths>((method, args) =>
        {
            if (method.Name == "get_PluginConfigurationsPath" || method.Name == "get_DataPath") return tempDir;
            return null;
        });
        return (appPaths, tempDir);
    }

    private static UserItemData NewUserData(bool isFavorite = false, bool played = false) =>
        new() { Key = Guid.NewGuid().ToString(), IsFavorite = isFavorite, Played = played };

    [Fact]
    public void DefaultSettingIsTrue_And_ProfileController_Updates()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();

            var initial = store.Load(userId);
            Assert.True(initial.RemoveFromWatchlistAfterWatching);

            var controller = new ProfileController(store)
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(new ClaimsIdentity([
                            new Claim("Jellyfin-UserId", userId.ToString())
                        ]))
                    }
                }
            };

            var res1 = controller.SetWatchlistAutoRemove(new ProfileController.WatchlistAutoRemoveRequest(false));
            var ok1 = Assert.IsType<OkObjectResult>(res1.Result);
            var updated1 = Assert.IsType<ProfileSettings>(ok1.Value);
            Assert.False(updated1.RemoveFromWatchlistAfterWatching);
            Assert.False(store.Load(userId).RemoveFromWatchlistAfterWatching);

            var res2 = controller.SetWatchlistAutoRemove(new ProfileController.WatchlistAutoRemoveRequest(true));
            var ok2 = Assert.IsType<OkObjectResult>(res2.Result);
            var updated2 = Assert.IsType<ProfileSettings>(ok2.Value);
            Assert.True(updated2.RemoveFromWatchlistAfterWatching);
            Assert.True(store.Load(userId).RemoveFromWatchlistAfterWatching);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingMovie_WhenEnabled_RemovesFromWatchlist_And_WhenDisabled_Keeps()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>();
            var movie = new Movie { Id = Guid.NewGuid(), Name = "Inception" };
            userDataStore[(userId, movie.Id)] = NewUserData(isFavorite: true, played: true);

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    var created = NewUserData();
                    userDataStore[(userId, item.Id)] = created;
                    return created;
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) =>
            {
                if (method.Name == nameof(IUserManager.GetUserById)) return user;
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>();
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            // Enabled by default -> movie should be removed from watchlist
            service.OnItemWatched(userId, movie);
            Assert.False(userDataStore[(userId, movie.Id)].IsFavorite);

            // Now test when disabled -> movie should stay on watchlist
            store.Update(userId, s => s.RemoveFromWatchlistAfterWatching = false);
            userDataStore[(userId, movie.Id)].IsFavorite = true;

            service.OnItemWatched(userId, movie);
            Assert.True(userDataStore[(userId, movie.Id)].IsFavorite);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingContinuingSeries_KeepsSeriesOnWatchlist()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var series = new Series { Id = Guid.NewGuid(), Name = "Airing Show", Status = SeriesStatus.Continuing };
            var episode = new Episode { Id = Guid.NewGuid(), Name = "Ep 1", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, series.Id)] = NewUserData(isFavorite: true),
                [(userId, episode.Id)] = NewUserData(played: true)
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>((method, args) =>
            {
                if (method.Name == nameof(ILibraryManager.GetItemById))
                {
                    var id = (Guid)args[0]!;
                    if (id == series.Id) return series;
                    if (id == episode.Id) return episode;
                }
                if (method.Name == nameof(ILibraryManager.GetItemList))
                {
                    return new List<BaseItem> { episode };
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) =>
            {
                if (method.Name == nameof(IUserManager.GetUserById)) return user;
                return null;
            });

            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            service.OnItemWatched(userId, episode);
            Assert.True(userDataStore[(userId, series.Id)].IsFavorite, "Continuing series must not be removed from watchlist");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingEndedSeries_WithOtherUnwatchedEpisodes_KeepsSeriesOnWatchlist()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var series = new Series { Id = Guid.NewGuid(), Name = "Ended Show", Status = SeriesStatus.Ended };
            var ep1 = new Episode { Id = Guid.NewGuid(), Name = "Ep 1", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
            var ep2 = new Episode { Id = Guid.NewGuid(), Name = "Ep 2", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 2 };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, series.Id)] = NewUserData(isFavorite: true),
                [(userId, ep1.Id)] = NewUserData(played: true),
                [(userId, ep2.Id)] = NewUserData(played: false)
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>((method, args) =>
            {
                if (method.Name == nameof(ILibraryManager.GetItemById))
                {
                    var id = (Guid)args[0]!;
                    if (id == series.Id) return series;
                    if (id == ep1.Id) return ep1;
                    if (id == ep2.Id) return ep2;
                }
                if (method.Name == nameof(ILibraryManager.GetItemList))
                {
                    return new List<BaseItem> { ep1, ep2 };
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) => user);
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            service.OnItemWatched(userId, ep1);
            Assert.True(userDataStore[(userId, series.Id)].IsFavorite, "Ended series with unwatched episode must remain on watchlist");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingEndedSeries_WithUnreleasedFutureEpisode_KeepsSeriesOnWatchlist()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var series = new Series { Id = Guid.NewGuid(), Name = "Ended Show", Status = SeriesStatus.Ended };
            var ep1 = new Episode { Id = Guid.NewGuid(), Name = "Ep 1", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
            // Unreleased future episode
            var ep2 = new Episode
            {
                Id = Guid.NewGuid(),
                Name = "Ep 2 Future",
                SeriesId = series.Id,
                ParentIndexNumber = 1,
                IndexNumber = 2,
                PremiereDate = DateTime.UtcNow.AddDays(7)
            };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, series.Id)] = NewUserData(isFavorite: true),
                [(userId, ep1.Id)] = NewUserData(played: true),
                [(userId, ep2.Id)] = NewUserData(played: true) // even if marked played somehow
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>((method, args) =>
            {
                if (method.Name == nameof(ILibraryManager.GetItemById))
                {
                    var id = (Guid)args[0]!;
                    if (id == series.Id) return series;
                    if (id == ep1.Id) return ep1;
                    if (id == ep2.Id) return ep2;
                }
                if (method.Name == nameof(ILibraryManager.GetItemList))
                {
                    return new List<BaseItem> { ep1, ep2 };
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) => user);
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            service.OnItemWatched(userId, ep1);
            Assert.True(userDataStore[(userId, series.Id)].IsFavorite, "Ended series with unreleased future episode must remain on watchlist");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingEndedSeries_AllRegularEpisodesWatched_RemovesSeriesFromWatchlist_EvenIfSpecialUnwatched()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var series = new Series { Id = Guid.NewGuid(), Name = "Breaking Bad", Status = SeriesStatus.Ended };
            var ep1 = new Episode { Id = Guid.NewGuid(), Name = "Ep 1", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1, PremiereDate = DateTime.UtcNow.AddDays(-100) };
            var ep2 = new Episode { Id = Guid.NewGuid(), Name = "Ep 2", SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 2, PremiereDate = DateTime.UtcNow.AddDays(-90) };
            // Special episode Season 0
            var special = new Episode { Id = Guid.NewGuid(), Name = "Special 1", SeriesId = series.Id, ParentIndexNumber = 0, IndexNumber = 1 };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, series.Id)] = NewUserData(isFavorite: true),
                [(userId, ep1.Id)] = NewUserData(played: true),
                [(userId, ep2.Id)] = NewUserData(played: false),
                [(userId, special.Id)] = NewUserData(played: false) // Unwatched special
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>((method, args) =>
            {
                if (method.Name == nameof(ILibraryManager.GetItemById))
                {
                    var id = (Guid)args[0]!;
                    if (id == series.Id) return series;
                    if (id == ep1.Id) return ep1;
                    if (id == ep2.Id) return ep2;
                    if (id == special.Id) return special;
                }
                if (method.Name == nameof(ILibraryManager.GetItemList))
                {
                    return new List<BaseItem> { ep1, ep2, special };
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) => user);
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            // Watching ep2 (the last unwatched regular episode)
            service.OnItemWatched(userId, ep2);
            Assert.False(userDataStore[(userId, series.Id)].IsFavorite, "Ended series with all regular episodes watched must be removed from watchlist");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingEpisode_WithFavoriteTrue_RemovesEpisodeFavorite()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var episode = new Episode { Id = Guid.NewGuid(), Name = "Favorite Episode", ParentIndexNumber = 1, IndexNumber = 1 };
            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, episode.Id)] = NewUserData(isFavorite: true, played: true)
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>();
            var userManager = DynamicProxy.Create<IUserManager>((method, args) => user);
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            service.OnItemWatched(userId, episode);
            Assert.False(userDataStore[(userId, episode.Id)].IsFavorite);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }

    [Fact]
    public void WatchingSeason_WhenAllEpisodesPlayed_RemovesSeasonFromWatchlist()
    {
        var (appPaths, tempDir) = CreateTempAppPaths();
        try
        {
            var store = new ProfileSettingsStore(appPaths);
            var userId = Guid.NewGuid();
            var user = new User("alice", "Default", "Default") { Id = userId };

            var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", IndexNumber = 1 };
            var ep1 = new Episode { Id = Guid.NewGuid(), Name = "Ep 1", SeasonId = season.Id, ParentIndexNumber = 1, IndexNumber = 1 };
            var ep2 = new Episode { Id = Guid.NewGuid(), Name = "Ep 2", SeasonId = season.Id, ParentIndexNumber = 1, IndexNumber = 2 };

            var userDataStore = new Dictionary<(Guid, Guid), UserItemData>
            {
                [(userId, season.Id)] = NewUserData(isFavorite: true),
                [(userId, ep1.Id)] = NewUserData(played: true),
                [(userId, ep2.Id)] = NewUserData(played: false)
            };

            var userDataManager = DynamicProxy.Create<IUserDataManager>((method, args) =>
            {
                if (method.Name == nameof(IUserDataManager.GetUserData))
                {
                    var item = (BaseItem)args[1]!;
                    if (userDataStore.TryGetValue((userId, item.Id), out var d)) return d;
                    return NewUserData();
                }
                if (method.Name == nameof(IUserDataManager.SaveUserData))
                {
                    var item = (BaseItem)args[1]!;
                    var data = (UserItemData)args[2]!;
                    userDataStore[(userId, item.Id)] = data;
                    return null;
                }
                return null;
            });

            var libraryManager = DynamicProxy.Create<ILibraryManager>((method, args) =>
            {
                if (method.Name == nameof(ILibraryManager.GetItemById))
                {
                    var id = (Guid)args[0]!;
                    if (id == season.Id) return season;
                    if (id == ep1.Id) return ep1;
                    if (id == ep2.Id) return ep2;
                }
                if (method.Name == nameof(ILibraryManager.GetItemList))
                {
                    return new List<BaseItem> { ep1, ep2 };
                }
                return null;
            });

            var userManager = DynamicProxy.Create<IUserManager>((method, args) => user);
            var sessionManager = DynamicProxy.Create<ISessionManager>();
            var service = new WatchlistAutoRemoveService(
                libraryManager, userManager, userDataManager, sessionManager, store, null, new TestLogger<WatchlistAutoRemoveService>()
            );

            // Watching ep2
            service.OnItemWatched(userId, ep2);
            Assert.False(userDataStore[(userId, season.Id)].IsFavorite);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
        }
    }
}
