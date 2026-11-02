using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

public class RealDurationStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();

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

    private Dictionary<string, long> LoadLocked()
    {
        if (!File.Exists(StorePath))
        {
            return new Dictionary<string, long>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, long>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, long>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, long>();
        }
    }

    private void SaveLocked(Dictionary<string, long> overrides)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllText(StorePath, JsonSerializer.Serialize(overrides));
    }
}
