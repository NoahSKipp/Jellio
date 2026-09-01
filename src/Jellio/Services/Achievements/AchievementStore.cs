using System;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

// Shared by AchievementService (the only writer) and AchievementsController
// (read only, including reading another user's own file for the future
// profile page), same one-file-per-user-id shape JsonUserStore exists for.
public class AchievementStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<UserAchievementStats> _store =
        new(applicationPaths, "achievements", () => new UserAchievementStats());

    public UserAchievementStats Load(Guid userId) => _store.Load(userId);

    public void Save(Guid userId, UserAchievementStats stats) => _store.Save(userId, stats);
}
