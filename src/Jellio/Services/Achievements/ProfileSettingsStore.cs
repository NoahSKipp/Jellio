using System;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

public class ProfileSettingsStore(IApplicationPaths applicationPaths)
{
    // Real bug, audit-found: Controllers/ProfileController.cs's own
    // privacy/grouplist-enabled/bio actions each did their own real
    // Load then Save with nothing between them, so two of a reader's
    // own real requests landing close together (two tabs, a fast
    // double click) could each Load the same real on disk version and
    // the second real Save would silently clobber the first one's own
    // change. One flat lock, same real proportional-to-scale reasoning
    // GroupWatchRankingService's own header gives for its own single
    // lock: every real operation here is a small file, not I/O heavy
    // enough for a per-user lock registry to earn its own real
    // complexity at this plugin's own real friends-only scale.
    private readonly object _lock = new();

    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "profile-settings");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public ProfileSettings Load(Guid userId)
    {
        lock (_lock)
        {
            return LoadLocked(userId);
        }
    }

    // Real atomic Load-mutate-Save a caller needs instead of its own
    // separate Load()/Save() pair: this class's own header above
    // explains why a caller doing those two steps itself, with real
    // time for another request to land between them, is exactly the
    // real bug this exists to close off.
    public ProfileSettings Update(Guid userId, Action<ProfileSettings> mutate)
    {
        lock (_lock)
        {
            var settings = LoadLocked(userId);
            mutate(settings);
            SaveLocked(userId, settings);
            return settings;
        }
    }

    public void Save(Guid userId, ProfileSettings settings)
    {
        lock (_lock)
        {
            SaveLocked(userId, settings);
        }
    }

    private ProfileSettings LoadLocked(Guid userId)
    {
        var path = StorePath(userId);
        if (!File.Exists(path))
        {
            return new ProfileSettings();
        }

        try
        {
            return JsonSerializer.Deserialize<ProfileSettings>(File.ReadAllText(path)) ?? new ProfileSettings();
        }
        catch (JsonException)
        {
            return new ProfileSettings();
        }
    }

    private void SaveLocked(Guid userId, ProfileSettings settings)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(settings));
    }
}
