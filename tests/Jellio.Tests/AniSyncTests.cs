using System;
using System.IO;
using Jellio.Services.AniSync;
using MediaBrowser.Common.Configuration;
using Moq;
using Xunit;

namespace Jellio.Tests;

public class AniSyncTests : IDisposable
{
    private readonly string _tempDir;
    private readonly AniSyncSecretProtector _protector;
    private readonly AniSyncStore _store;

    public AniSyncTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "jellio_anisync_test_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.PluginConfigurationsPath).Returns(_tempDir);
        _protector = new AniSyncSecretProtector(paths.Object);
        _store = new AniSyncStore(paths.Object, _protector);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_tempDir, recursive: true);
        }
        catch
        {
        }
    }

    [Fact]
    public void ProtectAndUnprotect_RoundTripsSecretAndEnforcesUserAad()
    {
        var userA = Guid.NewGuid();
        var userB = Guid.NewGuid();
        const string secret = "super-secret-oauth-token-12345";

        var ciphertext = _protector.Protect(secret, userA, AniSyncServices.AniList, "access_token");
        Assert.NotNull(ciphertext);
        Assert.StartsWith("v1:", ciphertext);
        Assert.DoesNotContain(secret, ciphertext);

        Assert.Equal(secret, _protector.Unprotect(ciphertext, userA, AniSyncServices.AniList, "access_token"));
        Assert.Null(_protector.Unprotect(ciphertext, userB, AniSyncServices.AniList, "access_token"));
        Assert.Null(_protector.Unprotect(ciphertext, userA, AniSyncServices.MyAnimeList, "access_token"));
        Assert.Null(_protector.Unprotect(ciphertext, userA, AniSyncServices.AniList, "refresh_token"));
    }

    [Fact]
    public void Store_SavesAndDecryptsPerUserCredentialsSafely()
    {
        var userId = Guid.NewGuid();
        _store.SaveProviderCredentials(
            userId,
            "mal",
            "AnimeFan",
            "42",
            "mal-access-secret-9999",
            "mal-refresh-8888",
            "client-abc",
            null,
            DateTime.UtcNow.AddHours(1));

        var rawRecord = _store.Load(userId);
        Assert.Equal(AniSyncServices.MyAnimeList, rawRecord.SelectedService);
        Assert.True(rawRecord.Providers.TryGetValue(AniSyncServices.MyAnimeList, out var saved));
        Assert.NotNull(saved);
        Assert.Equal("AnimeFan", saved!.Username);
        Assert.Equal("****9999", saved.MaskedCredential);
        Assert.DoesNotContain("mal-access-secret-9999", saved.EncryptedAccessToken);

        var decrypted = _store.GetDecryptedCredentials(userId, AniSyncServices.MyAnimeList);
        Assert.NotNull(decrypted);
        Assert.Equal("mal-access-secret-9999", decrypted!.AccessToken);
        Assert.Equal("mal-refresh-8888", decrypted.RefreshToken);
        Assert.Equal("client-abc", decrypted.ClientId);
    }

    [Theory]
    [InlineData("anilist", "anilist")]
    [InlineData("AL", "anilist")]
    [InlineData("MAL", "myanimelist")]
    [InlineData("MyAnimeList", "myanimelist")]
    [InlineData("shiki", "shikimori")]
    [InlineData("Simkl", "simkl")]
    [InlineData("unknown", null)]
    public void Normalize_MapsServiceAliases(string input, string? expected)
    {
        Assert.Equal(expected, AniSyncServices.Normalize(input));
    }

    [Fact]
    public void RecordSyncOutcome_FormatsMangaAndAnimeTitles()
    {
        var userId = Guid.NewGuid();
        _store.SaveProviderCredentials(userId, "anilist", "Reader", "1", "token-1234567890", null, null, null, null);

        _store.RecordSyncOutcome(userId, AniSyncServices.AniList, "Chainsaw Man", 42, true, "Synced chapter 42", isManga: true);
        var afterManga = _store.Load(userId);
        Assert.Equal("Chainsaw Man (Ch 42)", afterManga.Providers[AniSyncServices.AniList].LastSyncedTitle);

        _store.RecordSyncOutcome(userId, AniSyncServices.AniList, "Frieren", 10, true, "Synced episode 10", isManga: false);
        var afterAnime = _store.Load(userId);
        Assert.Equal("Frieren (Ep 10)", afterAnime.Providers[AniSyncServices.AniList].LastSyncedTitle);
    }
}
