using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.IntroCredits;

// Runs the same real ffmpeg binary IMediaEncoder already resolves for
// every other real transcode this plugin's own host already does
// (jellyfin-ffmpeg's own real chromaprint muxer, -f chromaprint, the
// same underlying real mechanism Intro Skipper's own analysis already
// depends on - if this server's own ffmpeg build could not produce a
// real chromaprint fingerprint at all, Intro Skipper would never work
// here either, not just for this library's own remote titles), fed the
// exact same real MediaSourceInfo.Path real playback already streams
// from directly rather than downloading a real temp copy first: ffmpeg
// itself already knows how to read an HTTP input incrementally,
// including a real byte range seek for -ss when the far end actually
// supports one, the same real capability real seeking during playback
// already depends on for this exact same URL.
public class ChromaprintExtractor(IMediaEncoder mediaEncoder, ILogger<ChromaprintExtractor> logger)
{
    private static readonly TimeSpan ExtractTimeout = TimeSpan.FromSeconds(45);

    public async Task<int[]?> ExtractAsync(MediaSourceInfo source, double offsetSeconds, double windowSeconds, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(source.Path) || windowSeconds <= 0)
        {
            return null;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = mediaEncoder.EncoderPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in BuildArguments(source, offsetSeconds, windowSeconds))
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(ExtractTimeout);

        try
        {
            process.Start();
            var stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(timeoutCts.Token);
            await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            var stdout = await stdoutTask.ConfigureAwait(false);

            if (process.ExitCode != 0)
            {
                var stderr = await stderrTask.ConfigureAwait(false);
                // LogWarning, not LogDebug: same real mistake the browser
                // console side of this exact feature already made twice
                // (console.debug never showing up in a real reader's own
                // devtools). Jellyfin's own default server log level is
                // Information, Debug is invisible there unless an admin
                // already knows to turn it on first - exactly the one
                // real reason ffmpeg failing here would look identical to
                // "no match found" from the outside.
                logger.LogWarning(
                    "Jellio: chromaprint extraction exited {Code} for {Path} at {Offset}s: {Err}",
                    process.ExitCode,
                    source.Path,
                    offsetSeconds,
                    Truncate(stderr));
                return null;
            }

            return ParseFingerprint(stdout);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            logger.LogWarning("Jellio: chromaprint extraction timed out for {Path} at {Offset}s", source.Path, offsetSeconds);
            return null;
        }
        catch (Exception ex)
        {
            TryKill(process);
            logger.LogWarning(ex, "Jellio: chromaprint extraction threw for {Path}", source.Path);
            return null;
        }
    }

    private static void TryKill(Process process)
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
            // Already exited between the check and the kill, nothing left to do.
        }
    }

    // ArgumentList, not a single Arguments string: a raw resolved URL or
    // a real header value can carry characters (spaces, quotes) .NET's
    // own cross-platform argv splitter for a plain Arguments string
    // would need real escaping for, ArgumentList hands each element to
    // the process as its own real argv entry with no shell/quoting step
    // in between to get wrong.
    //
    // -ss before -i: input seeking, ffmpeg's own faster real path for an
    // HTTP source (a real byte range request when the far end honours
    // one, rather than decoding and discarding everything before it).
    // -map 0:a:0 rather than trusting a bare -i default stream pick: a
    // real remote source can carry more than one real audio track, only
    // the first is ever what a default real playback session already
    // negotiates. 11025Hz mono matches chromaprint's own real internal
    // resample rate, decoding straight to it here rather than at its
    // own default (44.1kHz then internally resampled again) is strictly
    // less real work for the exact same real fingerprint.
    private static string[] BuildArguments(MediaSourceInfo source, double offsetSeconds, double windowSeconds)
    {
        var args = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error" };

        if (source.RequiredHttpHeaders is { Count: > 0 })
        {
            var headerLines = string.Join("\r\n", source.RequiredHttpHeaders.Select(h => h.Key + ": " + h.Value));
            args.Add("-headers");
            args.Add(headerLines + "\r\n");
        }

        args.Add("-ss");
        args.Add(offsetSeconds.ToString("0.###", CultureInfo.InvariantCulture));
        args.Add("-i");
        args.Add(source.Path);
        args.Add("-t");
        args.Add(windowSeconds.ToString("0.###", CultureInfo.InvariantCulture));
        args.AddRange(["-map", "0:a:0", "-ac", "1", "-ar", "11025", "-f", "chromaprint", "-fp_format", "raw", "-"]);
        return [.. args];
    }

    // ffmpeg's own chromaprint muxer with -fp_format raw writes the
    // fingerprint as a plain comma separated list of signed 32-bit ints
    // straight to stdout, no binary framing of its own to parse first.
    private static int[]? ParseFingerprint(string stdout)
    {
        var trimmed = stdout.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        var parts = trimmed.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            return null;
        }

        var result = new int[parts.Length];
        for (var i = 0; i < parts.Length; i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out result[i]))
            {
                return null;
            }
        }

        return result;
    }

    private static string Truncate(string text) => text.Length > 400 ? text[..400] : text;
}
