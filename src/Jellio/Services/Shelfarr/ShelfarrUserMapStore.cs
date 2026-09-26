using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Shelfarr;

// One shared JSON file keyed by Jellyfin user id, same real shape
// IntroCreditsStore/RealDurationStore already use: which Shelfarr User
// id (API::V1::UsersController#create's own real response, confirmed
// directly) a given Jellyfin reader was silently provisioned onto, so
// Controllers/BookRequestController.cs only ever calls POST
// /api/v1/users once per real reader, ever, rather than on every
// single request they make.
public class ShelfarrUserMapStore(IApplicationPaths applicationPaths)
{
    private readonly object _lock = new();

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "shelfarr-users.json");

    public int? Get(Guid jellyfinUserId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            return all.TryGetValue(Key(jellyfinUserId), out var shelfarrUserId) ? shelfarrUserId : null;
        }
    }

    public void Set(Guid jellyfinUserId, int shelfarrUserId)
    {
        lock (_lock)
        {
            var all = LoadLocked();
            all[Key(jellyfinUserId)] = shelfarrUserId;
            SaveLocked(all);
        }
    }

    private static string Key(Guid jellyfinUserId) => jellyfinUserId.ToString("N");

    private Dictionary<string, int> LoadLocked()
    {
        if (!File.Exists(StorePath))
        {
            return new Dictionary<string, int>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(StorePath))
                ?? new Dictionary<string, int>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, int>();
        }
    }

    private void SaveLocked(Dictionary<string, int> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllText(StorePath, JsonSerializer.Serialize(all));
    }
}
