using System;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

// Shared by AchievementService (the only writer) and AchievementsController
// (read only, including reading another user's own file for the future
// profile page), same one-file-per-user-id shape NextUpHiddenController
// already uses under PluginConfigurationsPath.
public class AchievementStore(IApplicationPaths applicationPaths)
{
    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "achievements");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public UserAchievementStats Load(Guid userId)
    {
        var path = StorePath(userId);
        if (!File.Exists(path))
        {
            return new UserAchievementStats();
        }

        try
        {
            return JsonSerializer.Deserialize<UserAchievementStats>(File.ReadAllText(path)) ?? new UserAchievementStats();
        }
        catch (JsonException)
        {
            return new UserAchievementStats();
        }
    }

    public void Save(Guid userId, UserAchievementStats stats)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(stats));
    }
}
