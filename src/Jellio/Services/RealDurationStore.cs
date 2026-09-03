using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

// Real gap this closes: item.RunTimeTicks is Jellyfin's own metadata
// runtime (whatever TVDB/TMDB claims), not the real duration of
// whatever Gelato actually resolved and streamed - AchievementService's
// own header already covers why that matters for credit gating, this is
// the same real fix for Continue Watching's own "Xm left" label and
// progress bar, both still reading that same inflated RunTimeTicks
// directly (reported live: a real 41 minute episode still showing 22m
// left at 37 real minutes in, TMDB's own 60 minute broadcast slot
// underneath). One shared JSON file keyed by item id, not per user: a
// title's own real duration is a property of the file itself, not of
// whoever is watching it.
public class RealDurationStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "real-duration.json");

    public void Set(Guid itemId, long durationTicks)
    {
        lock (_lock)
        {
            var overrides = LoadLocked();
            overrides[itemId.ToString("N")] = durationTicks;
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
