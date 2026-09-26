using System.Collections.Generic;

namespace Jellio.Services.Achievements;

// A fixed, hand-picked set rather than the compound-criteria authoring
// engines other gamification plugins build: this plugin has no admin
// UI for badge authoring and no real need for one yet, so a static list
// evaluated against UserAchievementStats stays the whole feature.
public static class AchievementCatalog
{
    private const long TicksPerHour = 36_000_000_000L;

    public static readonly IReadOnlyList<AchievementDefinition> ReadingBadges =
    [
        new("first-book", "First Chapter", "Finish your first book.", AchievementRarity.Common, s => s.BooksCompleted >= 1),
        new("bookworm", "Bookworm", "Finish 10 books.", AchievementRarity.Rare, s => s.BooksCompleted >= 10),
        new("bibliophile", "Bibliophile", "Finish 50 books.", AchievementRarity.Epic, s => s.BooksCompleted >= 50),
        new("page-turner", "Page Turner", "Read 1,000 pages.", AchievementRarity.Common, s => s.PagesRead >= 1_000),
        new("page-devourer", "Page Devourer", "Read 10,000 pages.", AchievementRarity.Rare, s => s.PagesRead >= 10_000),
        new("library-of-alexandria", "Library of Alexandria", "Read 50,000 pages.", AchievementRarity.Legendary, s => s.PagesRead >= 50_000),
        new("first-listen", "All Ears", "Finish your first audiobook.", AchievementRarity.Common, s => s.AudiobooksCompleted >= 1),
        new("audiophile", "Audiophile", "Finish 10 audiobooks.", AchievementRarity.Rare, s => s.AudiobooksCompleted >= 10),
        new("marathon-listener", "Marathon Listener", "Listen to 100 hours of audiobooks.", AchievementRarity.Epic, s => s.ListenedTicks >= 100 * TicksPerHour),
        new("first-volume", "Volume One", "Finish your first manga, manhwa or manhua volume.", AchievementRarity.Common, s => s.MangaVolumesCompleted >= 1),
        new("manga-collector", "Otaku", "Finish 25 manga, manhwa or manhua volumes.", AchievementRarity.Rare, s => s.MangaVolumesCompleted >= 25),
        new("manga-master", "Weeaboo", "Finish 100 manga, manhwa or manhua volumes.", AchievementRarity.Epic, s => s.MangaVolumesCompleted >= 100),
        new("reading-habit", "Reading Habit", "Read or listen 7 days in a row.", AchievementRarity.Rare, s => s.BestReadingStreak >= 7),
        new("reading-ritual", "Reading Ritual", "Read or listen 30 days in a row.", AchievementRarity.Epic, s => s.BestReadingStreak >= 30),
    ];

    public static readonly IReadOnlyList<AchievementDefinition> All =
    [
        new("first-watch", "First Watch", "Finish your first movie or episode.", AchievementRarity.Common, s => s.TotalCompleted >= 1),
        new("movie-buff-bronze", "Movie Buff", "Finish 10 movies.", AchievementRarity.Common, s => s.MoviesCompleted >= 10),
        new("movie-buff-silver", "Film Fanatic", "Finish 50 movies.", AchievementRarity.Rare, s => s.MoviesCompleted >= 50),
        new("movie-buff-gold", "Cinephile", "Finish 150 movies.", AchievementRarity.Epic, s => s.MoviesCompleted >= 150),
        new("binge-couch-potato", "Couch Potato", "Watch 5 episodes in one sitting.", AchievementRarity.Common, s => s.BestBingeStreak >= 5),
        new("binge-marathoner", "Marathoner", "Watch 10 episodes in one sitting.", AchievementRarity.Rare, s => s.BestBingeStreak >= 10),
        new("binge-legend", "Binge Legend", "Watch 20 episodes in one sitting.", AchievementRarity.Epic, s => s.BestBingeStreak >= 20),
        new("night-owl", "Night Owl", "Finish something between 2 and 5 in the morning.", AchievementRarity.Rare, s => s.NightOwlCompletions >= 1),
        new("night-owl-veteran", "Night Owl Veteran", "Finish 10 things between 2 and 5 in the morning.", AchievementRarity.Epic, s => s.NightOwlCompletions >= 10),
        new("weekend-warrior", "Weekend Warrior", "Finish 10 things on a Saturday or Sunday.", AchievementRarity.Common, s => s.WeekendCompletions >= 10),
        new("genre-explorer", "Genre Explorer", "Finish something in 5 different genres.", AchievementRarity.Common, s => s.GenreCompletions.Count >= 5),
        new("genre-devotee", "Genre Devotee", "Finish 25 things in a single genre.", AchievementRarity.Rare, s => s.MaxGenreCompletions >= 25),
        new("marathon-day", "Marathon Day", "Watch 8 hours in a single day.", AchievementRarity.Epic, s => s.BestSingleDayRuntimeTicks >= 8 * TicksPerHour),
        new("century-club", "Century Club", "Finish 100 movies and episodes combined.", AchievementRarity.Legendary, s => s.TotalCompleted >= 100),
        new("tv-buff-bronze", "TV Enthusiast", "Finish 50 episodes.", AchievementRarity.Common, s => s.EpisodesCompleted >= 50),
        new("tv-buff-silver", "Show Devourer", "Finish 200 episodes.", AchievementRarity.Rare, s => s.EpisodesCompleted >= 200),
        new("tv-buff-gold", "Episode Machine", "Finish 500 episodes.", AchievementRarity.Epic, s => s.EpisodesCompleted >= 500),
        new("early-bird", "Early Bird", "Finish something between 5 and 8 in the morning.", AchievementRarity.Rare, s => s.EarlyBirdCompletions >= 1),
        new("early-bird-veteran", "Early Bird Veteran", "Finish 10 things between 5 and 8 in the morning.", AchievementRarity.Epic, s => s.EarlyBirdCompletions >= 10),
        new("weekend-devotee", "Weekend Devotee", "Finish 50 things on a Saturday or Sunday.", AchievementRarity.Rare, s => s.WeekendCompletions >= 50),
        new("genre-connoisseur", "Genre Connoisseur", "Finish something in 10 different genres.", AchievementRarity.Rare, s => s.GenreCompletions.Count >= 10),
        new("streak-week", "Weekly Habit", "Watch something 7 days in a row.", AchievementRarity.Rare, s => s.BestDailyStreak >= 7),
        new("streak-month", "Dedicated Viewer", "Watch something 30 days in a row.", AchievementRarity.Epic, s => s.BestDailyStreak >= 30),
        new("legend-club", "Legend", "Finish 500 movies and episodes combined.", AchievementRarity.Legendary, s => s.TotalCompleted >= 500),
        new("group-starter", "Group Starter", "Start your first Group Watch.", AchievementRarity.Common, s => s.GroupsStarted >= 1),
        new("group-host", "Host with the Most", "Start 10 Group Watch sessions.", AchievementRarity.Rare, s => s.GroupsStarted >= 10),
        new("watch-together", "Better Together", "Finish something in a Group Watch session.", AchievementRarity.Common, s => s.GroupWatchesTogether >= 1),
        new("watch-together-veteran", "Regular Watch Party", "Finish 10 things in a Group Watch session.", AchievementRarity.Rare, s => s.GroupWatchesTogether >= 10),
        new("watch-together-legend", "Watch Party Legend", "Finish 50 things in a Group Watch session.", AchievementRarity.Epic, s => s.GroupWatchesTogether >= 50),
        new("horror-fan", "Horror Fan", "Finish 10 horror titles.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Horror") >= 10),
        new("comedy-fan", "Comedy Fan", "Finish 10 comedy titles.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Comedy") >= 10),
        new("documentary-buff", "Documentary Buff", "Finish 10 documentaries.", AchievementRarity.Rare, s => s.GenreCompletions.GetValueOrDefault("Documentary") >= 10),
        .. ReadingBadges,
    ];
}
