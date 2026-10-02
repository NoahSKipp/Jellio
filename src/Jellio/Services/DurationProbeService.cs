using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

// The length of an episode whose library entry has none, or a wrong one
// (every Gelato stream). A converted stream can't tell the player: its
// own duration is only what has been produced so far. So the length is
// read once from the playback source with ffprobe, remembered until the
// server restarts, and stored as the exact length (RealDurationStore).
public class DurationProbeService(
    IMediaSourceManager mediaSourceManager,
    IUserManager userManager,
    IMediaEncoder mediaEncoder,
    RealDurationStore store,
    ILogger<DurationProbeService> logger)
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<Guid, long> _known = new();
    private readonly SemaphoreSlim _gate = new(2);

    public async Task<long?> ProbeAsync(BaseItem item, Guid userId, CancellationToken cancellationToken)
    {
        if (_known.TryGetValue(item.Id, out var cached))
        {
            return cached;
        }

        var user = userManager.GetUserById(userId);
        if (user is null || string.IsNullOrEmpty(mediaEncoder.ProbePath))
        {
            return null;
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_known.TryGetValue(item.Id, out cached))
            {
                return cached;
            }

            var sources = await mediaSourceManager
                .GetPlaybackMediaSources(item, user, false, false, cancellationToken)
                .ConfigureAwait(false);
            var source = sources.FirstOrDefault(candidate =>
                !string.IsNullOrEmpty(candidate.Path) && !candidate.Path.StartsWith("gelato://", StringComparison.OrdinalIgnoreCase));
            if (source is null)
            {
                return null;
            }

            var args = new List<string> { "-v", "error", "-hide_banner", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1" };
            if (source.RequiredHttpHeaders is { Count: > 0 })
            {
                args.Add("-headers");
                args.Add(string.Join("\r\n", source.RequiredHttpHeaders.Select(h => h.Key + ": " + h.Value)) + "\r\n");
            }

            args.Add("-i");
            args.Add(source.Path);

            var seconds = await RunAsync(args, cancellationToken).ConfigureAwait(false);
            if (seconds is not > 0)
            {
                return null;
            }

            var ticks = (long)(seconds.Value * TimeSpan.TicksPerSecond);
            _known[item.Id] = ticks;
            store.Set(item.Id, ticks, exact: true);
            return ticks;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not probe the length of {Name}", item.Name);
            return null;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<double?> RunAsync(List<string> args, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = mediaEncoder.ProbePath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in args)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ProbeTimeout);
        try
        {
            process.Start();
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                logger.LogWarning("Jellio: ffprobe exited {Code}: {Err}", process.ExitCode, (await errors.ConfigureAwait(false)).Trim());
                return null;
            }

            var text = (await output.ConfigureAwait(false)).Trim();
            return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) ? seconds : null;
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(true);
                }
            }
            catch (InvalidOperationException)
            {
                // Already exited.
            }

            cancellationToken.ThrowIfCancellationRequested();
            logger.LogWarning("Jellio: ffprobe timed out reading a length");
            return null;
        }
    }
}
