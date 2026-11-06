using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Jellio.Services;
using MediaBrowser.Common.Configuration;
using Xunit;

namespace Jellio.Tests;

public class RealDurationStoreTests : IDisposable
{
    private readonly string _tempDir;
    private readonly IApplicationPaths _appPaths;

    public RealDurationStoreTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "jellio-durationstore-" + Guid.NewGuid().ToString("N"));
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
    public void SetAndGetMany_PersistsAndReadsDurations()
    {
        var store = new RealDurationStore(_appPaths);
        var id1 = Guid.NewGuid();
        var id2 = Guid.NewGuid();
        var idNonExistent = Guid.NewGuid();

        store.Set(id1, 10000L);
        store.Set(id2, 20000L);

        var filePath = Path.Combine(_tempDir, "Jellio", "real-duration.json");
        Assert.True(File.Exists(filePath));

        var results = store.GetMany([id1, id2, idNonExistent]);
        Assert.Equal(2, results.Count);
        Assert.Equal(10000L, results[id1.ToString("N")]);
        Assert.Equal(20000L, results[id2.ToString("N")]);
        Assert.False(results.ContainsKey(idNonExistent.ToString("N")));
    }

    [Fact]
    public void Set_ExactFlagBehavior()
    {
        var store = new RealDurationStore(_appPaths);
        var id = Guid.NewGuid();

        store.Set(id, 50000L);

        // Lower duration with exact = false does not overwrite
        store.Set(id, 30000L, exact: false);
        var res1 = store.GetMany([id]);
        Assert.Equal(50000L, res1[id.ToString("N")]);

        // Lower duration with exact = true does overwrite
        store.Set(id, 30000L, exact: true);
        var res2 = store.GetMany([id]);
        Assert.Equal(30000L, res2[id.ToString("N")]);
    }

    [Fact]
    public void InMemoryCacheHit_EliminatesDiskReads()
    {
        var store = new RealDurationStore(_appPaths);
        var id = Guid.NewGuid();
        var filePath = Path.Combine(_tempDir, "Jellio", "real-duration.json");

        store.Set(id, 42000L);
        Assert.True(File.Exists(filePath));

        // Overwrite file on disk directly
        File.WriteAllText(filePath, "{\"00000000000000000000000000000001\": 99999}");

        // GetMany reads directly from cache, avoiding disk read
        var fromCache = store.GetMany([id]);
        Assert.True(fromCache.ContainsKey(id.ToString("N")));
        Assert.Equal(42000L, fromCache[id.ToString("N")]);

        // Clear cache and verify it reloads from disk
        store.ClearCache();
        var reloaded = store.GetMany([id, Guid.Parse("00000000-0000-0000-0000-000000000001")]);
        Assert.False(reloaded.ContainsKey(id.ToString("N")));
        Assert.Equal(99999L, reloaded["00000000000000000000000000000001"]);
    }

    [Fact]
    public void CorruptedFileHandling_CreatesCorruptedBackupAndFallsBackToEmpty()
    {
        var dir = Path.Combine(_tempDir, "Jellio");
        Directory.CreateDirectory(dir);
        var filePath = Path.Combine(dir, "real-duration.json");

        File.WriteAllText(filePath, "{ this is corrupted json for real-duration");

        var store = new RealDurationStore(_appPaths);
        var id = Guid.NewGuid();

        // Must not throw, should fall back to empty
        var results = store.GetMany([id]);
        Assert.Empty(results);

        // Verify corrupted backup file was created
        var corruptedFiles = Directory.EnumerateFiles(dir, "real-duration.json.corrupted.*.bak").ToList();
        Assert.Single(corruptedFiles);

        var corruptedContent = File.ReadAllText(corruptedFiles[0]);
        Assert.Equal("{ this is corrupted json for real-duration", corruptedContent);
    }

    [Fact]
    public void AtomicSave_CleansUpTempFiles()
    {
        var store = new RealDurationStore(_appPaths);
        var id = Guid.NewGuid();

        store.Set(id, 15000L);

        var dir = Path.Combine(_tempDir, "Jellio");
        var tmpFiles = Directory.EnumerateFiles(dir, "*.tmp").ToList();
        Assert.Empty(tmpFiles);
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
