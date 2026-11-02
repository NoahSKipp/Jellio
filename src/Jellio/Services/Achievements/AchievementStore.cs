using System;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

public class AchievementStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<UserAchievementStats> _store =
        new(applicationPaths, "achievements", () => new UserAchievementStats());

    // Every read runs the one-time re-check after thresholds go up, saving
    // the result so it only ever happens once per user.
    public UserAchievementStats Load(Guid userId)
    {
        var stats = _store.Load(userId);
        if (stats.CatalogVersion < AchievementCatalog.Version)
        {
            stats = _store.Update(userId, AchievementCatalog.RecheckAction);
        }

        return stats;
    }

    public void Save(Guid userId, UserAchievementStats stats) => _store.Save(userId, stats);

    public UserAchievementStats Update(Guid userId, Action<UserAchievementStats> mutate) =>
        _store.Update(userId, stats =>
        {
            AchievementCatalog.Recheck(stats);
            mutate(stats);
        });
}
