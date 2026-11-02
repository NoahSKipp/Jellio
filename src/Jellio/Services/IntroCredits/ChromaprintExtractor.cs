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
