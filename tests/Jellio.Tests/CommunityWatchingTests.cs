using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Claims;
using Jellio.Controllers;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellio.Tests;

public class CommunityWatchingTests
{
    private static readonly DateTime T0 = new(2026, 11, 4, 17, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FirstBuildIsDueAtOnceThenOnlyAfterTheInterval()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        Assert.True(schedule.IsDue(T0));
        schedule.Built(T0, T0.AddSeconds(2));
        Assert.False(schedule.IsDue(T0.AddMinutes(4)));
        Assert.True(schedule.IsDue(T0.AddMinutes(5).AddSeconds(2)));
    }

    [Fact]
    public void PlaybackMakesItDueAfterTheDebounceNotAtOnce()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        schedule.Built(T0, T0);
        schedule.MarkDirty(T0.AddSeconds(10));
        schedule.MarkDirty(T0.AddSeconds(20));
        Assert.False(schedule.IsDue(T0.AddSeconds(30)));
        Assert.True(schedule.IsDue(T0.AddSeconds(40)));
    }

    [Fact]
    public void PlaybackDuringABuildIsPickedUpByTheNextOne()
    {
        var schedule = new RefreshSchedule(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(30));
        schedule.MarkDirty(T0.AddSeconds(5));
        schedule.Built(T0, T0.AddSeconds(10));
        Assert.True(schedule.IsDue(T0.AddSeconds(40)));

        schedule.Built(T0.AddSeconds(40), T0.AddSeconds(45));
        Assert.False(schedule.IsDue(T0.AddMinutes(2)));
    }

    public class TestLogger<T> : ILogger<T>
    {
        public List<(LogLevel Level, string Message, Exception? Exception)> Logs { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            Logs.Add((logLevel, formatter(state, exception), exception));
        }
    }

    public class DynamicProxy : DispatchProxy
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

        public static object CreateForType(Type interfaceType, Func<MethodInfo, object?[], object?>? handler = null)
        {
            var createMethod = typeof(DispatchProxy)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == nameof(DispatchProxy.Create) && m.IsGenericMethod && m.GetGenericArguments().Length == 2)
                .MakeGenericMethod(interfaceType, typeof(DynamicProxy));
            var proxy = createMethod.Invoke(null, null)!;
            ((DynamicProxy)proxy).Handler = handler;
            return proxy;
        }
    }

    [Fact]
    public void GetWatchingReturnsEmptyListAndLogsWarningWhenDependencyThrows()
    {
        var caller = new User("callerUser", "Default", "Default") { Id = Guid.NewGuid() };
        var other = new User("otherUser", "Default", "Default") { Id = Guid.NewGuid() };

        var userManager = DynamicProxy.Create<IUserManager>((method, args) =>
        {
            if (method.Name == nameof(IUserManager.GetUserById))
            {
                var id = (Guid)args[0]!;
                return id == caller.Id ? caller : (id == other.Id ? other : null);
            }
            if (method.Name == nameof(IUserManager.GetUsers))
            {
                return new[] { caller, other };
            }
            return null;
        });

        var sessionManager = DynamicProxy.Create<ISessionManager>((method, args) =>
        {
            if (method.Name == "get_Sessions")
            {
                throw new InvalidOperationException("Simulated session failure");
            }
            return null;
        });

        var libraryManager = DynamicProxy.Create<ILibraryManager>();
        var dtoService = DynamicProxy.Create<IDtoService>();
        var appPaths = DynamicProxy.Create<IApplicationPaths>((method, args) =>
        {
            if (method.Name == "get_PluginConfigurationsPath" || method.Name == "get_DataPath") return Path.GetTempPath();
            return null;
        });

        var profileSettingsStore = new ProfileSettingsStore(appPaths);
        var cache = new CommunityWatchingCache(sessionManager);
        var userDataManager = DynamicProxy.Create<IUserDataManager>();
        var services = DynamicProxy.Create<IServiceProvider>();
        var historyLogger = new TestLogger<CommunityWatchingService>();
        var watchHistory = new CommunityWatchingService(sessionManager, libraryManager, userManager, userDataManager, services, historyLogger);
        var controllerLogger = new TestLogger<CommunityController>();

        var controller = new CommunityController(
            sessionManager,
            libraryManager,
            userManager,
            dtoService,
            profileSettingsStore,
            cache,
            watchHistory,
            controllerLogger);

        var httpContext = new DefaultHttpContext();
        var claims = new[] { new Claim("Jellyfin-UserId", caller.Id.ToString()) };
        httpContext.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
        controller.ControllerContext = new ControllerContext { HttpContext = httpContext };

        var actionResult = controller.GetWatching(null);
        var okResult = Assert.IsType<OkObjectResult>(actionResult.Result);
        var response = Assert.IsType<CommunityController.CommunityWatchingResponse>(okResult.Value);
        Assert.Empty(response.Items);

        Assert.Contains(controllerLogger.Logs, log => log.Level == LogLevel.Warning && log.Message.Contains("community watching failed"));
    }

    private class Jellyfin12AssemblyLoadContext : AssemblyLoadContext
    {
        private readonly Dictionary<string, string> _jfAssemblies = new(StringComparer.OrdinalIgnoreCase);
        private readonly string _aspNetDir;
        private readonly string _coreDir;

        public Jellyfin12AssemblyLoadContext(string nugetRoot) : base("Jellyfin12LoadContext", isCollectible: false)
        {
            var jfPackages = new[]
            {
                ("jellyfin.controller", "MediaBrowser.Controller.dll"),
                ("jellyfin.model", "MediaBrowser.Model.dll"),
                ("jellyfin.common", "MediaBrowser.Common.dll"),
                ("jellyfin.data", "Jellyfin.Data.dll"),
                ("jellyfin.database.implementations", "Jellyfin.Database.Implementations.dll"),
                ("jellyfin.extensions", "Jellyfin.Extensions.dll"),
                ("jellyfin.naming", "Emby.Naming.dll"),
                ("jellyfin.mediaencoding.keyframes", "Jellyfin.MediaEncoding.Keyframes.dll")
            };

            foreach (var (pkg, file) in jfPackages)
            {
                var path = Path.Combine(nugetRoot, pkg, "12.0.0", "lib", "net10.0", file);
                var asmName = Path.GetFileNameWithoutExtension(file);
                _jfAssemblies[asmName] = path;
            }

            _aspNetDir = Path.GetDirectoryName(typeof(ControllerBase).Assembly.Location) ?? string.Empty;
            _coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location) ?? string.Empty;
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            var name = assemblyName.Name;
            if (string.IsNullOrEmpty(name))
                return null;

            if (_jfAssemblies.TryGetValue(name, out var jfPath))
            {
                return LoadFromAssemblyPath(jfPath);
            }

            var baseDirFile = Path.Combine(AppContext.BaseDirectory, name + ".dll");
            if (File.Exists(baseDirFile) && !_jfAssemblies.ContainsKey(name))
            {
                if (!name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    && !name.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(name, "mscorlib", StringComparison.OrdinalIgnoreCase))
                {
                    return LoadFromAssemblyPath(baseDirFile);
                }
            }

            try
            {
                return AssemblyLoadContext.Default.LoadFromAssemblyName(new AssemblyName(name));
            }
            catch
            {
                // continue to directory lookups
            }

            if (!string.IsNullOrEmpty(_aspNetDir))
            {
                var aspCandidate = Path.Combine(_aspDir(), name + ".dll");
                if (File.Exists(aspCandidate))
                    return LoadFromAssemblyPath(aspCandidate);
            }

            if (!string.IsNullOrEmpty(_coreDir))
            {
                var coreCandidate = Path.Combine(_coreDir, name + ".dll");
                if (File.Exists(coreCandidate))
                    return LoadFromAssemblyPath(coreCandidate);
            }

            return null;
        }

        private string _aspDir() => _aspNetDir;
    }

    [Fact]
    public void JellioMethodsJitCompileAgainstJellyfin12AndGetWatchingReturnsItems()
    {
        var nugetRoot = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");

        var alc = new Jellyfin12AssemblyLoadContext(nugetRoot);

        var jellioLocation = typeof(CommunityController).Assembly.Location;
        var jellioAsm = alc.LoadFromAssemblyPath(jellioLocation);

        var controllerAssembly = alc.LoadFromAssemblyName(new AssemblyName("MediaBrowser.Controller"));
        var dtoServiceType = controllerAssembly.GetType("MediaBrowser.Controller.Dto.IDtoService")!;
        var getBaseItemDtosMethod = dtoServiceType.GetMethod("GetBaseItemDtos")!;

        Assert.Equal(5, getBaseItemDtosMethod.GetParameters().Length);

        var errors = new List<string>();
        foreach (var type in jellioAsm.GetTypes())
        {
            if (type.ContainsGenericParameters)
                continue;

            var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

            foreach (var ctor in type.GetConstructors(flags))
            {
                if (ctor.ContainsGenericParameters || ctor.IsAbstract)
                    continue;

                try
                {
                    RuntimeHelpers.PrepareMethod(ctor.MethodHandle);
                }
                catch (MissingMethodException ex)
                {
                    errors.Add($"MissingMethodException in ctor {type.FullName}..ctor: {ex.Message}");
                }
                catch (TypeLoadException ex)
                {
                    errors.Add($"TypeLoadException in ctor {type.FullName}..ctor: {ex.Message}");
                }
            }

            foreach (var method in type.GetMethods(flags))
            {
                if (method.ContainsGenericParameters || method.IsAbstract)
                    continue;

                try
                {
                    RuntimeHelpers.PrepareMethod(method.MethodHandle);
                }
                catch (MissingMethodException ex)
                {
                    errors.Add($"MissingMethodException in method {type.FullName}.{method.Name}: {ex.Message}");
                }
                catch (TypeLoadException ex)
                {
                    errors.Add($"TypeLoadException in method {type.FullName}.{method.Name}: {ex.Message}");
                }
            }
        }

        Assert.Empty(errors);

        // Instantiate CommunityController in Jellyfin 12 ALC
        var iSessionManagerType = controllerAssembly.GetType("MediaBrowser.Controller.Session.ISessionManager")!;
        var iLibraryManagerType = controllerAssembly.GetType("MediaBrowser.Controller.Library.ILibraryManager")!;
        var iUserManagerType = controllerAssembly.GetType("MediaBrowser.Controller.Library.IUserManager")!;
        var iUserDataManagerType = controllerAssembly.GetType("MediaBrowser.Controller.Library.IUserDataManager")!;
        var commonAssembly = alc.LoadFromAssemblyName(new AssemblyName("MediaBrowser.Common"));
        var iApplicationPathsType = commonAssembly.GetType("MediaBrowser.Common.Configuration.IApplicationPaths")!;
        var databaseAssembly = alc.LoadFromAssemblyName(new AssemblyName("Jellyfin.Database.Implementations"));
        var userType = databaseAssembly.GetType("Jellyfin.Database.Implementations.Entities.User")!;
        var modelAssembly = alc.LoadFromAssemblyName(new AssemblyName("MediaBrowser.Model"));
        var baseItemDtoType = modelAssembly.GetType("MediaBrowser.Model.Dto.BaseItemDto")!;
        var sessionInfoType = controllerAssembly.GetType("MediaBrowser.Controller.Session.SessionInfo")!;
        var movieType = controllerAssembly.GetType("MediaBrowser.Controller.Entities.Movies.Movie")!;

        var callerId = Guid.NewGuid();
        var watcherId = Guid.NewGuid();
        var callerUser = Activator.CreateInstance(userType, "caller", "Default", "Default")!;
        userType.GetProperty("Id")!.SetValue(callerUser, callerId);
        userType.GetProperty("Username")?.SetValue(callerUser, "caller");
        var watcherUser = Activator.CreateInstance(userType, "watcher", "Default", "Default")!;
        userType.GetProperty("Id")!.SetValue(watcherUser, watcherId);
        userType.GetProperty("Username")?.SetValue(watcherUser, "watcher");

        var movieItem = Activator.CreateInstance(movieType)!;
        var movieId = Guid.NewGuid();
        movieType.GetProperty("Id")!.SetValue(movieItem, movieId);
        movieType.GetProperty("Name")!.SetValue(movieItem, "Interstellar");

        var nowPlayingDto = Activator.CreateInstance(baseItemDtoType)!;
        baseItemDtoType.GetProperty("Id")!.SetValue(nowPlayingDto, movieId);
        baseItemDtoType.GetProperty("Name")!.SetValue(nowPlayingDto, "Interstellar");

        var sessionInstance = RuntimeHelpers.GetUninitializedObject(sessionInfoType);
        sessionInfoType.GetProperty("UserId")!.SetValue(sessionInstance, watcherId);
        sessionInfoType.GetProperty("NowPlayingItem")!.SetValue(sessionInstance, nowPlayingDto);

        var sessionListType = typeof(List<>).MakeGenericType(sessionInfoType);
        var sessionList = (IList)Activator.CreateInstance(sessionListType)!;
        sessionList.Add(sessionInstance);

        var sessionProxy = DynamicProxy.CreateForType(iSessionManagerType, (m, a) =>
        {
            if (m.Name == "get_Sessions") return sessionList;
            return null;
        });

        var libraryProxy = DynamicProxy.CreateForType(iLibraryManagerType, (m, a) =>
        {
            if (m.Name == "GetItemById" && a.Length > 0 && Equals(a[0], movieId))
            {
                return movieItem;
            }
            return null;
        });

        var userListType = typeof(List<>).MakeGenericType(userType);
        var userList = (IList)Activator.CreateInstance(userListType)!;
        userList.Add(callerUser);
        userList.Add(watcherUser);

        var userProxy = DynamicProxy.CreateForType(iUserManagerType, (m, a) =>
        {
            if (m.Name == "GetUserById" && a.Length > 0)
            {
                var id = (Guid)a[0]!;
                if (id == callerId) return callerUser;
                if (id == watcherId) return watcherUser;
                return null;
            }
            if (m.Name == "GetUsers") return userList;
            return null;
        });

        var dtoBatchInvoked = false;
        var dtoProxy = DynamicProxy.CreateForType(dtoServiceType, (m, a) =>
        {
            if (m.Name == "GetBaseItemDtos")
            {
                dtoBatchInvoked = true;
                Assert.Equal(5, m.GetParameters().Length);
                var dtoListType = typeof(List<>).MakeGenericType(baseItemDtoType);
                var dtoList = (IList)Activator.CreateInstance(dtoListType)!;
                var resultDto = Activator.CreateInstance(baseItemDtoType)!;
                baseItemDtoType.GetProperty("Id")!.SetValue(resultDto, movieId);
                baseItemDtoType.GetProperty("Name")!.SetValue(resultDto, "Interstellar");
                dtoList.Add(resultDto);
                return dtoList;
            }
            if (m.Name == "GetBaseItemDto")
            {
                var resultDto = Activator.CreateInstance(baseItemDtoType)!;
                baseItemDtoType.GetProperty("Id")!.SetValue(resultDto, movieId);
                baseItemDtoType.GetProperty("Name")!.SetValue(resultDto, "Interstellar");
                return resultDto;
            }
            return null;
        });

        var appPathsProxy = DynamicProxy.CreateForType(iApplicationPathsType, (m, a) =>
        {
            if (m.Name == "get_PluginConfigurationsPath" || m.Name == "get_DataPath") return Path.GetTempPath();
            return null;
        });

        var profileSettingsStoreType = jellioAsm.GetType("Jellio.Services.Achievements.ProfileSettingsStore")!;
        var profileSettingsStore = Activator.CreateInstance(profileSettingsStoreType, appPathsProxy)!;

        var communityWatchingCacheType = jellioAsm.GetType("Jellio.Services.CommunityWatchingCache")!;
        var cacheInstance = Activator.CreateInstance(communityWatchingCacheType, sessionProxy)!;

        var userDataProxy = DynamicProxy.CreateForType(iUserDataManagerType);
        var serviceProviderProxy = DynamicProxy.CreateForType(typeof(IServiceProvider));
        var communityWatchingServiceType = jellioAsm.GetType("Jellio.Services.CommunityWatchingService")!;
        var watchingServiceLoggerType = typeof(TestLogger<>).MakeGenericType(communityWatchingServiceType);
        var watchingServiceLogger = Activator.CreateInstance(watchingServiceLoggerType)!;

        var watchHistoryInstance = Activator.CreateInstance(
            communityWatchingServiceType,
            sessionProxy,
            libraryProxy,
            userProxy,
            userDataProxy,
            serviceProviderProxy,
            watchingServiceLogger)!;

        var communityControllerType = jellioAsm.GetType("Jellio.Controllers.CommunityController")!;
        var controllerLoggerType = typeof(TestLogger<>).MakeGenericType(communityControllerType);
        var controllerLogger = Activator.CreateInstance(controllerLoggerType)!;

        var controllerInstance = (ControllerBase)Activator.CreateInstance(
            communityControllerType,
            sessionProxy,
            libraryProxy,
            userProxy,
            dtoProxy,
            profileSettingsStore,
            cacheInstance,
            watchHistoryInstance,
            controllerLogger)!;

        var httpContext = new DefaultHttpContext();
        var claims = new[] { new Claim("Jellyfin-UserId", callerId.ToString()) };
        httpContext.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
        controllerInstance.ControllerContext = new ControllerContext { HttpContext = httpContext };

        var getWatchingMethod = communityControllerType.GetMethod("GetWatching", new[] { typeof(string) })!;
        var actionResult = getWatchingMethod.Invoke(controllerInstance, new object?[] { null })!;
        var resultProp = actionResult.GetType().GetProperty("Result")!;
        var okResult = Assert.IsType<OkObjectResult>(resultProp.GetValue(actionResult));
        var responseValue = okResult.Value!;

        var itemsProp = responseValue.GetType().GetProperty("Items")!;
        var itemsList = (IList)itemsProp.GetValue(responseValue)!;

        Assert.Single(itemsList);
        Assert.True(dtoBatchInvoked, "Expected 5-parameter IDtoService.GetBaseItemDtos to be invoked via reflection");

        var firstItem = itemsList[0]!;
        var itemProp = firstItem.GetType().GetProperty("Item")!;
        var itemDto = itemProp.GetValue(firstItem)!;
        var itemName = (string)baseItemDtoType.GetProperty("Name")!.GetValue(itemDto)!;
        Assert.Equal("Interstellar", itemName);

        var watchersProp = firstItem.GetType().GetProperty("Watchers")!;
        var watchersList = (IList)watchersProp.GetValue(firstItem)!;
        Assert.Single(watchersList);
        var firstWatcher = watchersList[0]!;
        var watcherName = (string?)firstWatcher.GetType().GetProperty("UserName")!.GetValue(firstWatcher);
        Assert.Equal("watcher", watcherName);
    }
}
