using System.Collections.Concurrent;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

/// <summary>
/// Duration sleep timers, one active per user/device pair. Real mechanism,
/// confirmed against a real plugin doing the same thing
/// (jellyfin-plugin-jellysleep's own Services/SleepTimerService.cs) before
/// writing anything: a background loop plus
/// ISessionManager.SendPlaystateCommand(Stop) is what actually stops
/// playback server side, no client side video hooking needed, unlike the
/// pause screen or now playing features this is not limited by
/// playbackManager being unreachable from an injected script, the server
/// already has a real remote control channel to any session.
///
/// Scoped to duration timers only for this slice, not Jellysleep's
/// episode-count timers, which need wiring into playback stop/start
/// events for correctness (an interrupted episode should not silently
/// count toward the target). That is real, separate scope, not a shortcut
/// taken here, revisit only if a duration-only timer turns out to not be
/// enough for real use.
/// </summary>
public class SleepTimerService(
    ILogger<SleepTimerService> logger,
    ISessionManager sessionManager
) : BackgroundService
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(15);

    private readonly ConcurrentDictionary<string, DateTime> _timers = new();

    public SleepTimerStatus Start(Guid userId, string? deviceId, int minutes)
    {
        var key = Key(userId, deviceId);
        var endTime = DateTime.UtcNow.AddMinutes(minutes);
        _timers[key] = endTime;
        logger.LogInformation(
            "Jellio: sleep timer started for user {UserId} device {DeviceId}, {Minutes} minutes",
            userId,
            deviceId ?? "any",
            minutes
        );
        return new SleepTimerStatus(true, endTime);
    }

    public bool Cancel(Guid userId, string? deviceId)
    {
        return _timers.TryRemove(Key(userId, deviceId), out _);
    }

    public SleepTimerStatus GetStatus(Guid userId, string? deviceId)
    {
        if (_timers.TryGetValue(Key(userId, deviceId), out var endTime))
        {
            return new SleepTimerStatus(true, endTime);
        }

        return new SleepTimerStatus(false, null);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckExpiredAsync().ConfigureAwait(false);
                await Task.Delay(CheckInterval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Jellio: error in sleep timer background loop");
                await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken).ConfigureAwait(false);
            }
        }
    }

    private async Task CheckExpiredAsync()
    {
        var now = DateTime.UtcNow;
        foreach (var (key, endTime) in _timers)
        {
            if (endTime > now)
            {
                continue;
            }

            if (!_timers.TryRemove(key, out _))
            {
                continue;
            }

            var (userId, deviceId) = ParseKey(key);
            await StopPlaybackAsync(userId, deviceId).ConfigureAwait(false);
        }
    }

    private async Task StopPlaybackAsync(Guid userId, string? deviceId)
    {
        var sessions = sessionManager.Sessions.Where(s =>
            s.UserId == userId && (string.IsNullOrEmpty(deviceId) || s.DeviceId == deviceId)
        );

        foreach (var session in sessions)
        {
            logger.LogInformation(
                "Jellio: sleep timer expired, stopping playback for user {UserId} session {SessionId}",
                userId,
                session.Id
            );

            await sessionManager
                .SendPlaystateCommand(
                    session.Id,
                    session.Id,
                    new PlaystateRequest { Command = PlaystateCommand.Stop },
                    CancellationToken.None
                )
                .ConfigureAwait(false);
        }
    }

    private static string Key(Guid userId, string? deviceId) => $"{userId}:{deviceId ?? string.Empty}";

    private static (Guid UserId, string? DeviceId) ParseKey(string key)
    {
        var parts = key.Split(':', 2);
        var userId = Guid.Parse(parts[0]);
        var deviceId = parts.Length > 1 && parts[1].Length > 0 ? parts[1] : null;
        return (userId, deviceId);
    }
}

public record SleepTimerStatus(bool Active, DateTime? EndTimeUtc);
