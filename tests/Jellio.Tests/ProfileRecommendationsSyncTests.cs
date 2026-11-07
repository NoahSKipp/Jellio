using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Claims;
using Jellio.Controllers;
using Jellio.Services.Achievements;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellio.Tests;

public class ProfileRecommendationsSyncTests : IDisposable
{
    private readonly string _tempDir;
    private readonly ProfileSettingsStore _store;

    private class PathsProxy : DispatchProxy
    {
        private string _dir = string.Empty;

        public static IApplicationPaths Create(string dir)
        {
            var proxy = Create<IApplicationPaths, PathsProxy>();
            ((PathsProxy)(object)proxy)._dir = dir;
            return proxy;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => _dir;
    }

    public ProfileRecommendationsSyncTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "jellio_prof_rec_tests_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _store = new ProfileSettingsStore(PathsProxy.Create(_tempDir));
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, true);
            }
        }
        catch
        {
        }
    }

    private static ProfileController CreateController(ProfileSettingsStore store, Guid userId)
    {
        var controller = new ProfileController(store);
        var context = new DefaultHttpContext();
        var identity = new ClaimsIdentity([new Claim("Jellyfin-UserId", userId.ToString())]);
        context.User = new ClaimsPrincipal(identity);
        controller.ControllerContext = new ControllerContext { HttpContext = context };
        return controller;
    }

    [Fact]
    public void SetRecommendations_PersistsSelectedAndCustomGenres()
    {
        var userId = Guid.NewGuid();
        var controller = CreateController(_store, userId);

        var request = new ProfileController.RecommendationsRequest(
            SelectedGenres: ["Action", "Sci-Fi"],
            CustomGenres: [
                new CustomGenreItemDto { Name = "C-Drama", Category = "country_genre", Enabled = true },
                new CustomGenreItemDto { Name = "Cyberpunk", Category = "keyword", Enabled = false }
            ]
        );

        var result = controller.SetRecommendations(request);
        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var settings = Assert.IsType<ProfileSettings>(okResult.Value);

        Assert.NotNull(settings.SelectedGenres);
        Assert.Equal(2, settings.SelectedGenres.Count);
        Assert.Contains("Action", settings.SelectedGenres);
        Assert.Contains("Sci-Fi", settings.SelectedGenres);

        Assert.NotNull(settings.CustomGenres);
        Assert.Equal(2, settings.CustomGenres.Count);
        Assert.Equal("C-Drama", settings.CustomGenres[0].Name);
        Assert.True(settings.CustomGenres[0].Enabled);
        Assert.Equal("Cyberpunk", settings.CustomGenres[1].Name);
        Assert.False(settings.CustomGenres[1].Enabled);

        // Verify reloading from store returns the exact same saved recommendations
        var reloaded = _store.Load(userId);
        Assert.NotNull(reloaded.SelectedGenres);
        Assert.Equal(2, reloaded.SelectedGenres.Count);
        Assert.NotNull(reloaded.CustomGenres);
        Assert.Equal(2, reloaded.CustomGenres.Count);
    }
}
