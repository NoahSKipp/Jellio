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

    // The real atomic Load-mutate-Save NotificationStore's own callers
    // already lean on JsonUserStore<T> for: AchievementsController's own
    // admin only activity-delete/badge-lock/reset endpoints below each
    // need one, and a plain Load()-then-Save() pair here would race
    // AchievementService's own real playback-stop writer the exact same
    // real way every other caller of this file's own underlying store
    // already had to stop doing.
    public UserAchievementStats Update(Guid userId, Action<UserAchievementStats> mutate) => _store.Update(userId, mutate);
}
