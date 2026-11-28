using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

// A client left paused with the screen off keeps its session alive for days
// and keeps showing up as watching. After the limit this ends only the
// playback state through the normal stop path, so the resume position stays
// and the item is not marked played. The access token, device and session are
// left alone; the next playback start from that client works as usual.
public class StalePausedSessionService(
    ISessionManager sessionManager,
    ILogger<StalePausedSessionService> logger
) : IHostedService, IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, PausedEntry> _tracked = new();
    private Timer? _timer;
    private int _running;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            _timer = new Timer(_ => _ = CheckAsync(), null, Interval, Interval);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not start the stale paused session check.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        _timer = null;
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _timer?.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task CheckAsync()
    {
        if (Interlocked.Exchange(ref _running, 1) == 1)
        {
            return;
        }

        try
        {
            var hours = JellioPlugin.Instance?.Configuration.StalePausedSessionHours
                ?? StalePausedSessions.DefaultLimitHours;
            var limit = StalePausedSessions.LimitFromHours(hours);
            var now = DateTime.UtcNow;
            var sessions = sessionManager.Sessions.ToList();

            StalePausedSessions.Prune(_tracked, sessions.Select(s => s.Id).ToHashSet());

            foreach (var session in sessions)
            {
                try
                {
                    await CheckSessionAsync(session, now, limit).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _tracked.TryRemove(session.Id, out _);
                    logger.LogWarning(ex, "Jellio: could not end stale paused playback for a session.");
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: stale paused session check failed.");
        }
        finally
        {
            Interlocked.Exchange(ref _running, 0);
        }
    }

    private async Task CheckSessionAsync(SessionInfo session, DateTime now, TimeSpan limit)
    {
        var item = session.NowPlayingItem;
        var state = session.PlayState;
        var seen = new PausedObservation(
            item is null ? (Guid?)null : item.Id,
            item is not null && state is not null && state.IsPaused,
            state?.PositionTicks
        );

        if (!StalePausedSessions.Evaluate(_tracked, session.Id, seen, now, limit) || item is null)
        {
            return;
        }

        var minutes = (int)(limit.TotalMinutes);
        await sessionManager
            .OnPlaybackStopped(
                new PlaybackStopInfo
                {
                    SessionId = session.Id,
                    ItemId = item.Id,
                    MediaSourceId = state?.MediaSourceId,
                    PositionTicks = state?.PositionTicks,
                }
            )
            .ConfigureAwait(false);

        logger.LogInformation(
            "Jellio: ended playback state of item {ItemId} on device {DeviceName}, paused for over {Minutes} minutes.",
            item.Id,
            session.DeviceName,
            minutes
        );
    }
}
