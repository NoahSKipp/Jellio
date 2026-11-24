using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

// How old a stored last played date has to be before a playback start or stop
// stamps a new one.
public static class LastPlayedStamp
{
    public static readonly TimeSpan MinAge = TimeSpan.FromSeconds(30);

    // A progress report only fills in a missing date; a start or a stop that
    // was not a finished watch also refreshes an older one.
    public static bool NeedsStamp(DateTime? current, DateTime now, bool refreshOlder)
    {
        if (current is null)
        {
            return true;
        }

        return refreshOlder && now - current.Value > MinAge;
    }
}

// An item that is part way through sorts by its last played date in Continue
// Watching. A session that never ended cleanly, or a client path that skips
// the update, leaves that date empty and the item sorts last. This stamps the
// date whenever playback starts, stops part way, or reports progress while
// the date is missing, for every client.
public class LastPlayedStampService(
    ISessionManager sessionManager,
    IUserDataManager userDataManager,
    ILogger<LastPlayedStampService> logger
) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            sessionManager.PlaybackStart += OnPlaybackStart;
            sessionManager.PlaybackProgress += OnPlaybackProgress;
            sessionManager.PlaybackStopped += OnPlaybackStopped;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not subscribe to playback events to stamp last played dates.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            sessionManager.PlaybackStart -= OnPlaybackStart;
            sessionManager.PlaybackProgress -= OnPlaybackProgress;
            sessionManager.PlaybackStopped -= OnPlaybackStopped;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not unsubscribe from playback events for last played dates.");
        }

        return Task.CompletedTask;
    }

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e) => Stamp(e, refreshOlder: true);

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e) => Stamp(e, refreshOlder: false);

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e) => Stamp(e, refreshOlder: !e.PlayedToCompletion);

    private void Stamp(PlaybackProgressEventArgs e, bool refreshOlder)
    {
        try
        {
            if (e.Item is null || e.Users is null)
            {
                return;
            }

            foreach (var user in e.Users)
            {
                var data = userDataManager.GetUserData(user, e.Item);
                if (data is null)
                {
                    continue;
                }

                var now = DateTime.UtcNow;
                if (!LastPlayedStamp.NeedsStamp(data.LastPlayedDate, now, refreshOlder))
                {
                    continue;
                }

                data.LastPlayedDate = now;
                userDataManager.SaveUserData(user, e.Item, data, UserDataSaveReason.PlaybackProgress, CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not stamp the last played date.");
        }
    }
}
