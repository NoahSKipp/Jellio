using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Achievements;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

// Badges live entirely off ISessionManager.PlaybackStopped, the same real
// event stock Jellyfin's own playback reporting already fires, no new
// client instrumentation needed. Credit gate mirrors the real-watch fix
// other gamification plugins had to add after the fact (mark-as-played and
// seek-to-end spam must not count): PlayedToCompletion or >=90% of the
// item's own RunTimeTicks, whichever real signal is available.
//
// Real bug, found live: item.RunTimeTicks is the library's own metadata
// runtime (whatever the matched TVDB/TMDB entry claims), not the real
// duration of whatever Gelato actually resolved and streamed. Reality TV
// specifically (Below Deck Mediterranean, reported live) routinely lists
// a broadcast time slot (with ads) well past the real ad-stripped file's
// own actual length, so a reader who watches an episode start to finish
// still lands under 90% of that inflated figure, real Jellyfin's own
// native played-status tracking (UserDataManager.UpdatePlayState) has
// the exact same blind spot since it reads the same real RunTimeTicks.
// CreditRealWatchAsync below is the real fix, not a workaround: fed by
// screens/player.js's own real <video>.duration once its own
// 'durationchange' settles (that reflects the real stream Gelato handed
// the browser, whatever the library's own metadata claims separately),
// the same real client-observed-ratio pattern
// GROUP_WATCH_COMPLETION_THRESHOLD already uses there for the identical
// real reason. Left OnPlaybackStopped's own metadata based gate in place
// rather than replacing it: any other real Jellyfin client (mobile,
// Kodi, ...) hitting this same server has no equivalent report to send
// instead, so it stays the fallback for those, CreditUserAsync's own
// recent-credit guard is what keeps the two from double counting one
// real sitting when both fire for this app's own web player.
//
// Subscribing itself stays defensive on purpose, same real lesson
// DefaultAvatarService already paid for: a hosted service throwing out of
// StartAsync takes the whole Kestrel host down with it, and a
// MissingMethodException from an ABI drift is only actually catchable from
// a separate NoInlining method, not the one whose own IL holds the call.
public class AchievementService(
    ISessionManager sessionManager,
    ILibraryManager libraryManager,
    AchievementStore store,
    ILogger<AchievementService> logger
) : IHostedService
{
    private const double CompletionThreshold = 0.9;
    private const int MaxRecentActivity = 20;
    private static readonly TimeSpan BingeGap = TimeSpan.FromMinutes(45);
    private static readonly TimeSpan RecentCreditGuard = TimeSpan.FromMinutes(30);
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            Subscribe();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not subscribe to playback events for achievements.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            sessionManager.PlaybackStopped -= OnPlaybackStopped;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not unsubscribe from playback events for achievements.");
        }

        return Task.CompletedTask;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Subscribe() => sessionManager.PlaybackStopped += OnPlaybackStopped;

    private async void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        try
        {
            if (!IsRealWatch(e))
            {
                return;
            }

            foreach (var user in e.Users)
            {
                await CreditUserAsync(user.Id, e.Item).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not credit a playback towards achievements.");
        }
    }

    private static bool IsRealWatch(PlaybackStopEventArgs e)
    {
        if (e.Item is null)
        {
            return false;
        }

        if (e.PlayedToCompletion)
        {
            return true;
        }

        return e.Item.RunTimeTicks is > 0
            && e.PlaybackPositionTicks is not null
            && (double)e.PlaybackPositionTicks.Value / e.Item.RunTimeTicks.Value >= CompletionThreshold;
    }

    // (userId, itemId) rather than just userId: a real binge session
    // crediting three different episodes 40 seconds apart must not have
    // episode two or three's own real credit swallowed by a guard meant
    // for the exact same episode firing twice, not adjacent ones.
    private readonly Dictionary<(Guid UserId, Guid ItemId), DateTime> _recentCredits = new();

    public async Task CreditRealWatchAsync(Guid userId, Guid itemId)
    {
        var item = libraryManager.GetItemById(itemId);
        if (item is null)
        {
            return;
        }

        await CreditUserAsync(userId, item).ConfigureAwait(false);
    }

    private async Task CreditUserAsync(Guid userId, BaseItem item)
    {
        var kind = item.GetBaseItemKind();
        var isEpisode = kind == Jellyfin.Data.Enums.BaseItemKind.Episode;
        var isMovie = kind == Jellyfin.Data.Enums.BaseItemKind.Movie;
        if (!isEpisode && !isMovie)
        {
            return;
        }

        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            // Real dedupe: OnPlaybackStopped's own metadata based gate
            // and CreditRealWatchAsync's own client-reported gate can
            // both legitimately fire for the exact same real sitting
            // (this app's own web player reports both), and would
            // otherwise double count one real episode as two.
            var creditKey = (userId, item.Id);
            if (_recentCredits.TryGetValue(creditKey, out var lastCreditedAt) && DateTime.UtcNow - lastCreditedAt < RecentCreditGuard)
            {
                return;
            }

            _recentCredits[creditKey] = DateTime.UtcNow;
            if (_recentCredits.Count > 200)
            {
                // Unbounded otherwise, this server never restarting for
                // months at a time is a real case, not a hypothetical
                // one. Trims whatever has already aged out of the real
                // guard window above rather than a blind full clear.
                var expired = _recentCredits.Where(kvp => DateTime.UtcNow - kvp.Value >= RecentCreditGuard).Select(kvp => kvp.Key).ToList();
                foreach (var key in expired)
                {
                    _recentCredits.Remove(key);
                }
            }

            var stats = store.Load(userId);
            var now = DateTime.Now;
            var nowUtc = DateTime.UtcNow;

            if (isMovie)
            {
                stats.MoviesCompleted++;
            }
            else
            {
                stats.EpisodesCompleted++;
            }

            stats.CurrentBingeStreak =
                isEpisode && stats.LastCompletionUtc.HasValue && stats.LastCompletionWasEpisode && nowUtc - stats.LastCompletionUtc.Value <= BingeGap
                    ? stats.CurrentBingeStreak + 1
                    : isEpisode ? 1 : 0;
            stats.BestBingeStreak = Math.Max(stats.BestBingeStreak, stats.CurrentBingeStreak);
            stats.LastCompletionUtc = nowUtc;
            stats.LastCompletionWasEpisode = isEpisode;

            if (now.Hour >= 2 && now.Hour < 5)
            {
                stats.NightOwlCompletions++;
            }

            if (now.Hour >= 5 && now.Hour < 8)
            {
                stats.EarlyBirdCompletions++;
            }

            if (now.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            {
                stats.WeekendCompletions++;
            }

            var today = now.Date;
            if (stats.LastStreakDate != today)
            {
                stats.CurrentDailyStreak = stats.LastStreakDate == today.AddDays(-1) ? stats.CurrentDailyStreak + 1 : 1;
                stats.LastStreakDate = today;
                stats.BestDailyStreak = Math.Max(stats.BestDailyStreak, stats.CurrentDailyStreak);
            }

            foreach (var genre in item.Genres ?? [])
            {
                stats.GenreCompletions[genre] = stats.GenreCompletions.GetValueOrDefault(genre) + 1;
            }

            var dayKey = now.ToString("yyyy-MM-dd");
            if (stats.CurrentDayKey != dayKey)
            {
                stats.CurrentDayKey = dayKey;
                stats.CurrentDayRuntimeTicks = 0;
            }

            stats.CurrentDayRuntimeTicks += item.RunTimeTicks ?? 0;
            stats.BestSingleDayRuntimeTicks = Math.Max(stats.BestSingleDayRuntimeTicks, stats.CurrentDayRuntimeTicks);

            stats.RecentActivity.Insert(
                0,
                new ActivityEntry(
                    item.Id,
                    item.Name,
                    kind.ToString(),
                    (item as Episode)?.SeriesName,
                    (item as Episode)?.SeriesId,
                    nowUtc,
                    item.ParentIndexNumber,
                    item.IndexNumber));
            if (stats.RecentActivity.Count > MaxRecentActivity)
            {
                stats.RecentActivity.RemoveRange(MaxRecentActivity, stats.RecentActivity.Count - MaxRecentActivity);
            }

            ApplyCatalog(stats, nowUtc);

            store.Save(userId, stats);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    // Group Watch state (is this reader currently in a group, how many
    // others are actually in it right now) is only ever known client
    // side, components/groupWatch.js's own real SyncPlay WebSocket
    // state, the same real trust model GroupWatchInviteController's own
    // header already documents for the identical reason: no server side
    // event exists to credit these off instead. AchievementsController's
    // own two group-watch endpoints call these directly rather than
    // going through OnPlaybackStopped at all, sharing the exact same
    // _writeLock and ApplyCatalog() the real playback-stop path above
    // already uses so the two can never race each other over the same
    // per user JSON file.
    public async Task CreditGroupWatchStartedAsync(Guid userId)
    {
        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var stats = store.Load(userId);
            stats.GroupsStarted++;
            ApplyCatalog(stats, DateTime.UtcNow);
            store.Save(userId, stats);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task CreditGroupWatchTogetherAsync(Guid userId)
    {
        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var stats = store.Load(userId);
            stats.GroupWatchesTogether++;
            ApplyCatalog(stats, DateTime.UtcNow);
            store.Save(userId, stats);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static void ApplyCatalog(UserAchievementStats stats, DateTime nowUtc)
    {
        foreach (var badge in AchievementCatalog.All)
        {
            if (!stats.UnlockedBadgeIds.Contains(badge.Id) && badge.IsUnlocked(stats))
            {
                stats.UnlockedBadgeIds.Add(badge.Id);
                stats.UnlockedAt[badge.Id] = nowUtc;
            }
        }
    }
}
