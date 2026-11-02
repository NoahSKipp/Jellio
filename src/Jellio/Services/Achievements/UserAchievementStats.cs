using System;
using System.Collections.Generic;

namespace Jellio.Services.Achievements;

public class UserAchievementStats
{
    public int MoviesCompleted { get; set; }

    public int EpisodesCompleted { get; set; }

    public int CurrentBingeStreak { get; set; }

    public int BestBingeStreak { get; set; }

    public DateTime? LastCompletionUtc { get; set; }

    public bool LastCompletionWasEpisode { get; set; }

    public int NightOwlCompletions { get; set; }

    public int EarlyBirdCompletions { get; set; }

    public int WeekendCompletions { get; set; }

    public DateTime? LastStreakDate { get; set; }

    public int CurrentDailyStreak { get; set; }

    public int BestDailyStreak { get; set; }

    public int GroupsStarted { get; set; }

    // Time spent watching Live TV channels and streams added by link, from
    // LiveWatchingService's check-ins.
    public long LiveTvTicks { get; set; }

    public int GroupWatchesTogether { get; set; }

    public Dictionary<string, int> GenreCompletions { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public string? CurrentDayKey { get; set; }

    public long CurrentDayRuntimeTicks { get; set; }

    public long BestSingleDayRuntimeTicks { get; set; }

    // AchievementCatalog.Version these unlocks were last checked against.
    public int CatalogVersion { get; set; }

    public HashSet<string> UnlockedBadgeIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public Dictionary<string, DateTime> UnlockedAt { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public HashSet<string> SuppressedBadgeIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    // Badge unlocks removed from the Feed by their owner or an admin. The
    // badge itself stays unlocked; only the Feed entry goes.
    public HashSet<string> HiddenFeedBadgeIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public List<ActivityEntry> RecentActivity { get; set; } = [];

    /// <summary>Every movie and episode this user has finished, so a repeat shows as a rewatch.</summary>
    public HashSet<Guid> CompletedItemIds { get; set; } = [];

    public int BooksCompleted { get; set; }

    public int AudiobooksCompleted { get; set; }

    public int MangaVolumesCompleted { get; set; }

    public long PagesRead { get; set; }

    public long MangaPagesRead { get; set; }

    public long ListenedTicks { get; set; }

    // Active time in the reader: books in ReadingTicks, manga, manhwa
    // and manhua in MangaReadingTicks.
    public long ReadingTicks { get; set; }

    public long MangaReadingTicks { get; set; }

    public HashSet<string> CompletedReadingIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public DateTime? LastReadingDate { get; set; }

    public int CurrentReadingStreak { get; set; }

    public int BestReadingStreak { get; set; }

    public int TotalCompleted => MoviesCompleted + EpisodesCompleted;

    public int MaxGenreCompletions
    {
        get
        {
            var max = 0;
            foreach (var count in GenreCompletions.Values)
            {
                if (count > max)
                {
                    max = count;
                }
            }

            return max;
        }
    }
}

public record ActivityEntry(
    Guid ItemId,
    string ItemName,
    string ItemType,
    string? SeriesName,
    Guid? SeriesId,
    DateTime CompletedAtUtc,
    int? SeasonNumber = null,
    int? EpisodeNumber = null,
    int? PagesRead = null,
    int? CurrentPage = null,
    int? PageCount = null,
    long? ListenedTicks = null,
    bool Finished = false,
    bool Rewatch = false);
