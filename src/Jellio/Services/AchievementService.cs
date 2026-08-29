using System;
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
// Subscribing itself stays defensive on purpose, same real lesson
// DefaultAvatarService already paid for: a hosted service throwing out of
// StartAsync takes the whole Kestrel host down with it, and a
// MissingMethodException from an ABI drift is only actually catchable from
// a separate NoInlining method, not the one whose own IL holds the call.
public class AchievementService(
    ISessionManager sessionManager,
    AchievementStore store,
    ILogger<AchievementService> logger
) : IHostedService
{
    private const double CompletionThreshold = 0.9;
    private const int MaxRecentActivity = 20;
    private static readonly TimeSpan BingeGap = TimeSpan.FromMinutes(45);
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
