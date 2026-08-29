using System;

namespace Jellio.Services.Achievements;

public record AchievementDefinition(
    string Id,
    string Name,
    string Description,
    AchievementRarity Rarity,
    Func<UserAchievementStats, bool> IsUnlocked
);
