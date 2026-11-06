using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

public class RealDurationStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();
    private Dictionary<string, long>? _cache;

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "real-duration.json");

    public void Set(Guid itemId, long durationTicks, bool exact = false)
    {
        lock (_lock)
        {
            var overrides = LoadLocked();
            var key = itemId.ToString("N");
            if (!exact && overrides.TryGetValue(key, out var existing) && existing >= durationTicks)
            {
                return;
            }

            overrides[key] = durationTicks;
            SaveLocked(overrides);
        }
    }

    public Dictionary<string, long> GetMany(IEnumerable<Guid> itemIds)
    {
        lock (_lock)
        {
            var overrides = LoadLocked();
            var result = new Dictionary<string, long>();
            foreach (var itemId in itemIds)
            {
                var key = itemId.ToString("N");
                if (overrides.TryGetValue(key, out var ticks))
                {
                    result[key] = ticks;
                }
            }

            return result;
        }
    }

    public void ClearCache()
    {
        lock (_lock)
        {
            _cache = null;
        }
    }

    private Dictionary<string, long> LoadLocked()
    {
        if (_cache != null)
        {
            return _cache;
        }

        if (!File.Exists(StorePath))
        {
            _cache = new Dictionary<string, long>();
            return _cache;
        }

        try
        {
            _cache = JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, long>();
            return _cache;
        }
        catch (JsonException)
        {
            var corruptBackup = StorePath + ".corrupted." + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ".bak";
            try
            {
                File.Copy(StorePath, corruptBackup, overwrite: true);
            }
            catch
            {
            }

            _cache = new Dictionary<string, long>();
            return _cache;
        }
    }

    private void SaveLocked(Dictionary<string, long> overrides)
    {
        var dir = Path.GetDirectoryName(StorePath)!;
        Directory.CreateDirectory(dir);

        var tempPath = StorePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(overrides));
            File.Move(tempPath, StorePath, overwrite: true);
        }
        catch
        {
            if (File.Exists(tempPath))
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch
                {
                }
            }
            throw;
        }
    }
}
