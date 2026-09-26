using System;
using System.Collections.Generic;

namespace Jellio.Services.Achievements;

// One of these per user, JSON persisted, same file-per-user shape
// NextUpHiddenController already uses. Fields below are either a badge
// predicate's own input or bookkeeping a predicate has no business
// reading directly (LastCompletionUtc, CurrentBingeStreak, the current
// day's own running runtime), kept here anyway so a restart does not
// lose an in-progress binge streak or day tally.
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

    // Neither one rides the real playback-stop event PlaybackStopped
    // credits everything else off: Group Watch state (who is in this
    // reader's own group right now) is only ever known client side,
    // components/groupWatch.js's own real SyncPlay WebSocket state, the
    // same real trust model GroupWatchInviteController's own header
    // already documents for the exact same reason. AchievementsController's
    // own two group-watch endpoints credit these directly instead.
    public int GroupsStarted { get; set; }

    public int GroupWatchesTogether { get; set; }

    public Dictionary<string, int> GenreCompletions { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public string? CurrentDayKey { get; set; }

    public long CurrentDayRuntimeTicks { get; set; }

    public long BestSingleDayRuntimeTicks { get; set; }

    public HashSet<string> UnlockedBadgeIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public Dictionary<string, DateTime> UnlockedAt { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    // AchievementService.ApplyCatalog only ever adds a badge, never
    // removes one: most thresholds here share one real counter across
    // several badges (MoviesCompleted alone backs all three
    // movie-buff-* tiers), so an admin relocking one badge (Controllers/
    // AchievementsController.cs's own {userId}/badges/{badgeId}/lock)
    // without this would see it silently reappear the very next time
    // that same counter's own predicate got re-checked on this user's
    // next completed movie or episode, still sitting well past
    // whichever threshold it already cleared. Checked by ApplyCatalog
    // alongside UnlockedBadgeIds; only that relock endpoint and the
    // full reset endpoint below it ever touch this set.
    public HashSet<string> SuppressedBadgeIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    // The profile page's own real feed, newest first, capped in
    // AchievementService rather than here: real GET /Users/{id}/Items
    // (getRecentlyCompleted's own real endpoint) only answers for the
    // caller's own id or an admin, no real way to build another user's
    // own feed from it, so this rides the same real playback-stop
    // credit AchievementService already computes instead of a second
    // event pipeline just for this.
    public List<ActivityEntry> RecentActivity { get; set; } = [];

    // Books, audiobooks and manga (AchievementService.CreditReadingSessionAsync,
    // fed by the reader and the audiobook player). A volume counts as
    // finished once, however many times it is reread.
    public int BooksCompleted { get; set; }

    public int AudiobooksCompleted { get; set; }

    public int MangaVolumesCompleted { get; set; }

    public long PagesRead { get; set; }

    public long MangaPagesRead { get; set; }

    public long ListenedTicks { get; set; }

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

// SeasonNumber/EpisodeNumber (BaseItem's own ParentIndexNumber/
// IndexNumber, real fields on the base type itself, not Episode-only)
// exist for FeedController's own real "finished episodes 1-8" grouping,
// not read anywhere else here. ItemId/SeriesId exist so the feed and
// profile activity rows can show real cover art (screens/feed.js's own
// getImageUrl(entry.SeriesId || entry.ItemId, ...)), same real series
// poster over episode thumbnail preference NowPlayingPanel already
// makes for this exact reason.
//
// Reading/listening entries (ItemType "Book", "Manga" or "AudioBook")
// also carry what that session covered: pages read and where the reader
// got to out of how many, or how long they listened, and whether they
// finished. Sessions on the same book the same day merge into one entry.
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
    bool Finished = false);
