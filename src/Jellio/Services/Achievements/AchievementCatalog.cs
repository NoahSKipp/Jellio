using System.Collections.Generic;

namespace Jellio.Services.Achievements;

// A fixed, hand-picked set rather than the compound-criteria authoring
// engines other gamification plugins build: this plugin has no admin
// UI for badge authoring and no real need for one yet, so a static list
// evaluated against UserAchievementStats stays the whole feature.
public static class AchievementCatalog
{
    private const long TicksPerHour = 36_000_000_000L;

    // Bumped whenever thresholds are raised: AchievementStore re-checks a
    // user's unlocked badges once against the new numbers.
    public const int Version = 2;

    // Locks again any unlocked badge whose (now raised) requirement isn't
    // met any more. Returns whether anything changed.
    public static bool Recheck(UserAchievementStats stats)
    {
        if (stats.CatalogVersion >= Version)
        {
            return false;
        }

        foreach (var badge in All)
        {
            if (stats.UnlockedBadgeIds.Contains(badge.Id) && !badge.IsUnlocked(stats))
            {
                stats.UnlockedBadgeIds.Remove(badge.Id);
                stats.UnlockedAt.Remove(badge.Id);
            }
        }

        stats.CatalogVersion = Version;
        return true;
    }

    public static void RecheckAction(UserAchievementStats stats) => Recheck(stats);

    public static readonly IReadOnlyList<AchievementDefinition> ReadingBadges =
    [
        new("first-book", "First Chapter", "Finish your first book.", AchievementRarity.Common, s => s.BooksCompleted >= 1),
        new("bookworm", "Bookworm", "Finish 15 books.", AchievementRarity.Rare, s => s.BooksCompleted >= 15),
        new("bibliophile", "Bibliophile", "Finish 75 books.", AchievementRarity.Legendary, s => s.BooksCompleted >= 75),
        new("page-turner", "Page Turner", "Read 1,000 pages.", AchievementRarity.Common, s => s.PagesRead >= 1_000),
        new("page-devourer", "Page Devourer", "Read 15,000 pages.", AchievementRarity.Rare, s => s.PagesRead >= 15_000),
        new("library-of-alexandria", "Library of Alexandria", "Read 100,000 pages.", AchievementRarity.Legendary, s => s.PagesRead >= 100_000),
        new("first-listen", "All Ears", "Finish your first audiobook.", AchievementRarity.Common, s => s.AudiobooksCompleted >= 1),
        new("audiophile", "Audiophile", "Finish 15 audiobooks.", AchievementRarity.Rare, s => s.AudiobooksCompleted >= 15),
        new("marathon-listener", "Marathon Listener", "Listen to 300 hours of audiobooks.", AchievementRarity.Legendary, s => s.ListenedTicks >= 300 * TicksPerHour),
        new("first-volume", "Volume One", "Finish your first manga, manhwa or manhua chapter.", AchievementRarity.Common, s => s.MangaVolumesCompleted >= 1),
        new("manga-collector", "Otaku", "Finish 250 manga, manhwa or manhua chapters.", AchievementRarity.Rare, s => s.MangaVolumesCompleted >= 250),
        new("manga-master", "Weeaboo", "Finish 2,000 manga, manhwa or manhua chapters.", AchievementRarity.Legendary, s => s.MangaVolumesCompleted >= 2_000),
        new("reading-habit", "Reading Habit", "Read or listen 7 days in a row.", AchievementRarity.Rare, s => s.BestReadingStreak >= 7),
        new("reading-ritual", "Reading Ritual", "Read or listen 60 days in a row.", AchievementRarity.Legendary, s => s.BestReadingStreak >= 60),
    ];

    public static readonly IReadOnlyList<AchievementDefinition> All =
    [
        new("first-watch", "First Watch", "Finish your first movie or episode.", AchievementRarity.Common, s => s.TotalCompleted >= 1),
        new("movie-buff-bronze", "Movie Buff", "Finish 10 movies.", AchievementRarity.Common, s => s.MoviesCompleted >= 10),
        new("movie-buff-silver", "Film Fanatic", "Finish 75 movies.", AchievementRarity.Rare, s => s.MoviesCompleted >= 75),
        new("movie-buff-gold", "Cinephile", "Finish 300 movies.", AchievementRarity.Legendary, s => s.MoviesCompleted >= 300),
        new("binge-couch-potato", "Couch Potato", "Watch 5 episodes in one sitting.", AchievementRarity.Common, s => s.BestBingeStreak >= 5),
        new("binge-marathoner", "Marathoner", "Watch 10 episodes in one sitting.", AchievementRarity.Rare, s => s.BestBingeStreak >= 10),
        new("binge-legend", "Binge Legend", "Watch 25 episodes in one sitting.", AchievementRarity.Legendary, s => s.BestBingeStreak >= 25),
        new("night-owl", "Night Owl", "Finish something between 2 and 5 in the morning.", AchievementRarity.Rare, s => s.NightOwlCompletions >= 1),
        new("night-owl-veteran", "Night Owl Veteran", "Finish 30 things between 2 and 5 in the morning.", AchievementRarity.Epic, s => s.NightOwlCompletions >= 30),
        new("weekend-warrior", "Weekend Warrior", "Finish 10 things on a Saturday or Sunday.", AchievementRarity.Common, s => s.WeekendCompletions >= 10),
        new("genre-explorer", "Genre Explorer", "Finish something in 5 different genres.", AchievementRarity.Common, s => s.GenreCompletions.Count >= 5),
        new("genre-devotee", "Genre Devotee", "Finish 75 things in a single genre.", AchievementRarity.Epic, s => s.MaxGenreCompletions >= 75),
        new("marathon-day", "Marathon Day", "Watch 10 hours in a single day.", AchievementRarity.Epic, s => s.BestSingleDayRuntimeTicks >= 10 * TicksPerHour),
        new("century-club", "Century Club", "Finish 100 movies and episodes combined.", AchievementRarity.Rare, s => s.TotalCompleted >= 100),
        new("tv-buff-bronze", "TV Enthusiast", "Finish 50 episodes.", AchievementRarity.Common, s => s.EpisodesCompleted >= 50),
        new("tv-buff-silver", "Show Devourer", "Finish 300 episodes.", AchievementRarity.Rare, s => s.EpisodesCompleted >= 300),
        new("tv-buff-gold", "Episode Machine", "Finish 1,500 episodes.", AchievementRarity.Legendary, s => s.EpisodesCompleted >= 1_500),
        new("early-bird", "Early Bird", "Finish something between 5 and 8 in the morning.", AchievementRarity.Rare, s => s.EarlyBirdCompletions >= 1),
        new("early-bird-veteran", "Early Bird Veteran", "Finish 30 things between 5 and 8 in the morning.", AchievementRarity.Epic, s => s.EarlyBirdCompletions >= 30),
        new("weekend-devotee", "Weekend Devotee", "Finish 150 things on a Saturday or Sunday.", AchievementRarity.Epic, s => s.WeekendCompletions >= 150),
        new("genre-connoisseur", "Genre Connoisseur", "Finish something in 15 different genres.", AchievementRarity.Epic, s => s.GenreCompletions.Count >= 15),
        new("streak-week", "Weekly Habit", "Watch something 7 days in a row.", AchievementRarity.Rare, s => s.BestDailyStreak >= 7),
        new("streak-month", "Dedicated Viewer", "Watch something 60 days in a row.", AchievementRarity.Legendary, s => s.BestDailyStreak >= 60),
        new("legend-club", "Legend", "Finish 2,000 movies and episodes combined.", AchievementRarity.Legendary, s => s.TotalCompleted >= 2_000),
        new("group-starter", "Group Starter", "Start your first Group Watch.", AchievementRarity.Common, s => s.GroupsStarted >= 1),
        new("group-host", "Host with the Most", "Start 25 Group Watch sessions.", AchievementRarity.Epic, s => s.GroupsStarted >= 25),
        new("watch-together", "Better Together", "Finish something in a Group Watch session.", AchievementRarity.Common, s => s.GroupWatchesTogether >= 1),
        new("watch-together-veteran", "Regular Watch Party", "Finish 15 things in a Group Watch session.", AchievementRarity.Rare, s => s.GroupWatchesTogether >= 15),
        new("watch-together-legend", "Watch Party Legend", "Finish 100 things in a Group Watch session.", AchievementRarity.Legendary, s => s.GroupWatchesTogether >= 100),
        new("horror-fan", "Horror Fan", "Finish 25 horror titles.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Horror") >= 25),
        new("comedy-fan", "Comedy Fan", "Finish 25 comedy titles.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Comedy") >= 25),
        new("documentary-buff", "Documentary Buff", "Finish 25 documentaries.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Documentary") >= 25),
        .. ReadingBadges,
    ];
}
