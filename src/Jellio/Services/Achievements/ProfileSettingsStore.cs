using System;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

public class ProfileSettingsStore(IApplicationPaths applicationPaths)
{
    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "profile-settings");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public ProfileSettings Load(Guid userId)
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

    public void Save(Guid userId, ProfileSettings settings)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(settings));
    }
}
