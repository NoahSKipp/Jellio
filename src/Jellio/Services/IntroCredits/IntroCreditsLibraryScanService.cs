using System;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.IntroCredits;

// The two real "make this happen without a reader having to watch two
// episodes of every season by hand first" asks IntroCreditsController's
// own POST /analyze/{itemId} (fired off one real playback at a time)
// does not cover on its own: a periodic sweep that progressively
// catches an existing library up on its own, and a real trigger the
// instant a new show's own first episodes actually land rather than
// waiting for this real timer's own next tick. IntroCreditsAnalyzer's
// own per-season dedup and MinReanalyzeGap already make firing this
// same real sweep repeatedly, or racing it against a real live
// playback's own trigger for the same season, a harmless no-op rather
// than real duplicate ffmpeg work.
//
// Subscribing itself stays defensive on purpose, same real lesson
// AchievementService already paid for: a hosted service throwing out of
// StartAsync takes the whole Kestrel host down with it, and a
// MissingMethodException from an ABI drift is only actually catchable
// from a separate NoInlining method, not the one whose own IL holds the
// call.
public class IntroCreditsLibraryScanService(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IntroCreditsAnalyzer analyzer,
    ILogger<IntroCreditsLibraryScanService> logger
) : IHostedService
{
    // Real low priority background work sharing a real home server's
    // own CPU with transcoding and everything else already on it: once
    // a day is plenty for a sweep whose own real job is catching up
    // whatever a season's own live playback triggers have not already
    // reached, not racing to finish a whole real library on day one.
    private static readonly TimeSpan SweepInterval = TimeSpan.FromHours(24);

    private readonly CancellationTokenSource _cts = new();
    private Task? _sweepLoop;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            Subscribe();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not subscribe to library events for intro/credits analysis.");
        }

        _sweepLoop = RunSweepLoopAsync(_cts.Token);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            libraryManager.ItemAdded -= OnItemAdded;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not unsubscribe from library events for intro/credits analysis.");
        }

        await _cts.CancelAsync().ConfigureAwait(false);
        if (_sweepLoop is not null)
        {
            try
            {
                await _sweepLoop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown, the loop below already only ever
                // awaits its own real delay through this same token.
            }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Subscribe() => libraryManager.ItemAdded += OnItemAdded;

    // A real new show import lands its own Series/Season/Episode items
    // one ItemAdded event at a time, not as a single real batch: only
    // Episode actually carries a real SeasonId to queue, and
    // IntroCreditsAnalyzer's own per-season dedup already collapses the
    // whole rest of that same season's own remaining real episode
    // events into the one real run this first one already queued.
    private void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        try
        {
            if (e.Item is not Episode episode || episode.SeasonId == Guid.Empty)
            {
                return;
            }

            var userId = AnyUserId();
            if (userId == Guid.Empty)
            {
                return;
            }

            analyzer.QueueSeasonAnalysis(episode.SeasonId, userId);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: could not queue intro/credits analysis for a newly added item.");
        }
    }

    private async Task RunSweepLoopAsync(CancellationToken cancellationToken)
    {
        // A real first sweep waits its own first full interval rather
        // than firing the moment this plugin's own host starts up: a
        // freshly (re)started server already has real startup work of
        // its own competing for the exact same CPU/IO this would add to.
        using var timer = new PeriodicTimer(SweepInterval);
        while (await WaitNextTickAsync(timer, cancellationToken).ConfigureAwait(false))
        {
            try
            {
                var userId = AnyUserId();
                if (userId != Guid.Empty)
                {
                    analyzer.QueueLibraryAnalysis(userId);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: library-wide intro/credits sweep failed to queue.");
            }
        }
    }

    private static async Task<bool> WaitNextTickAsync(PeriodicTimer timer, CancellationToken cancellationToken)
    {
        try
        {
            return await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    // Any real signed in user works equally well here: IMediaSourceManager's
    // own GetPlaybackMediaSources only ever uses this to apply that
    // user's own real parental/library access rules, and a real
    // background sweep has no one real specific reader's own session to
    // prefer over any other.
    private Guid AnyUserId() => userManager.GetUsers().FirstOrDefault()?.Id ?? Guid.Empty;
}
