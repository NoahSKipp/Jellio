using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Jellio.Services;
using MediaBrowser.Common.Configuration;
using Xunit;

namespace Jellio.Tests;

public class JsonUserStoreTests : IDisposable
{
    private readonly string _tempDir;
    private readonly IApplicationPaths _appPaths;

    public JsonUserStoreTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "jellio-jsonuserstore-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _appPaths = PathsProxy.Create(_tempDir);
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

    [Fact]
    public void NormalAtomicSaveAndLoad()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-sub", () => []);
        var userId = Guid.NewGuid();

        var initial = store.Load(userId);
        Assert.Empty(initial);

        store.Save(userId, ["apple", "banana"]);

        var filePath = Path.Combine(_tempDir, "Jellio", "test-sub", userId + ".json");
        Assert.True(File.Exists(filePath));

        var loaded = store.Load(userId);
        Assert.Equal(["apple", "banana"], loaded);

        var updated = store.Update(userId, list => list.Add("cherry"));
        Assert.Equal(["apple", "banana", "cherry"], updated);

        var bakPath = filePath + ".bak";
        Assert.True(File.Exists(bakPath));

        var bakContent = File.ReadAllText(bakPath);
        Assert.Contains("apple", bakContent);
        Assert.Contains("banana", bakContent);

        var userIds = store.UserIds();
        Assert.Contains(userId, userIds);
    }

    [Fact]
    public void CorruptedFileRecovery_RecoversFromBakAndCreatesCorruptedBackup()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-recovery", () => []);
        var userId = Guid.NewGuid();
        var filePath = Path.Combine(_tempDir, "Jellio", "test-recovery", userId + ".json");
        var bakPath = filePath + ".bak";

        // Save original and then updated to establish a .bak file with valid data
        store.Save(userId, ["original-entry"]);
        store.Save(userId, ["updated-entry"]);

        Assert.True(File.Exists(filePath));
        Assert.True(File.Exists(bakPath));

        // Corrupt main file on disk
        File.WriteAllText(filePath, "{ invalid json data [[[");

        // Clear in-memory cache to force reading from disk
        store.ClearCache();

        var recovered = store.Load(userId);

        // Should recover from .bak
        Assert.Equal(["original-entry"], recovered);

        // Should have created a .corrupted.<timestamp>.bak file
        var dir = Path.Combine(_tempDir, "Jellio", "test-recovery");
        var corruptedFiles = Directory.EnumerateFiles(dir, userId + ".json.corrupted.*.bak").ToList();
        Assert.Single(corruptedFiles);

        var corruptedContent = File.ReadAllText(corruptedFiles[0]);
        Assert.Equal("{ invalid json data [[[", corruptedContent);
    }

    [Fact]
    public void CorruptedFileRecovery_RecoversFromTmpIfBakMissing()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-tmp-recovery", () => []);
        var userId = Guid.NewGuid();
        var dir = Path.Combine(_tempDir, "Jellio", "test-tmp-recovery");
        Directory.CreateDirectory(dir);

        var filePath = Path.Combine(dir, userId + ".json");
        var tmpPath = Path.Combine(dir, userId + ".json." + Guid.NewGuid().ToString("N") + ".tmp");

        File.WriteAllText(filePath, "{ bad json }");
        File.WriteAllText(tmpPath, "[\"recovered-from-tmp\"]");

        var loaded = store.Load(userId);
        Assert.Equal(["recovered-from-tmp"], loaded);

        var corruptedFiles = Directory.EnumerateFiles(dir, userId + ".json.corrupted.*.bak").ToList();
        Assert.Single(corruptedFiles);
    }

    [Fact]
    public void CorruptedFileRecovery_FallsBackToDefaultWhenAllRecoveryFails()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-fallback", () => ["default-val"]);
        var userId = Guid.NewGuid();
        var dir = Path.Combine(_tempDir, "Jellio", "test-fallback");
        Directory.CreateDirectory(dir);

        var filePath = Path.Combine(dir, userId + ".json");
        File.WriteAllText(filePath, "{ corrupt json only");

        var loaded = store.Load(userId);
        Assert.Equal(["default-val"], loaded);

        var corruptedFiles = Directory.EnumerateFiles(dir, userId + ".json.corrupted.*.bak").ToList();
        Assert.Single(corruptedFiles);
    }

    [Fact]
    public void InMemoryCacheBehavior_AvoidsDiskReadsAndSupportsClearCache()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-cache", () => []);
        var userId = Guid.NewGuid();
        var filePath = Path.Combine(_tempDir, "Jellio", "test-cache", userId + ".json");

        store.Save(userId, ["initial-item"]);

        // Directly overwrite the file on disk behind the store's back
        File.WriteAllText(filePath, "[\"disk-overwritten-item\"]");

        // Load should return the cached item, avoiding disk reads
        var cached = store.Load(userId);
        Assert.Equal(["initial-item"], cached);

        // Clearing cache forces disk reload
        store.ClearCache();
        var reloaded = store.Load(userId);
        Assert.Equal(["disk-overwritten-item"], reloaded);
    }

    [Fact]
    public void UserIds_IncorporatesBothCachedKeysAndDiskFiles()
    {
        var store = new JsonUserStore<List<string>>(_appPaths, "test-user-ids", () => []);
        var userCached = Guid.NewGuid();
        var userDiskOnly = Guid.NewGuid();

        // userCached is saved in cache and on disk
        store.Save(userCached, ["data1"]);

        // Delete userCached file on disk: it remains in _cache
        var cachedFilePath = Path.Combine(_tempDir, "Jellio", "test-user-ids", userCached + ".json");
        File.Delete(cachedFilePath);
        Assert.False(File.Exists(cachedFilePath));

        // Directly write userDiskOnly to disk without store knowing about it in cache
        var diskFilePath = Path.Combine(_tempDir, "Jellio", "test-user-ids", userDiskOnly + ".json");
        File.WriteAllText(diskFilePath, "[\"data2\"]");

        var userIds = store.UserIds();
        Assert.Contains(userCached, userIds);
        Assert.Contains(userDiskOnly, userIds);
    }

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
}
