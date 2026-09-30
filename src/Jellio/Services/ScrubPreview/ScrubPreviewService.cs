using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.ScrubPreview;

// Seek bar hover thumbnails for titles Jellyfin has no trickplay for
// (every Gelato stream: Jellyfin only generates trickplay for local
// files). One frame per bucket, grabbed with ffmpeg straight from the
// playback source the same way ChromaprintExtractor reads it, then
// cached on disk. The resolved source is cached too, so hovering does
// not make Gelato resolve the stream again for every frame.
public class ScrubPreviewService(
    IMediaSourceManager mediaSourceManager,
    IUserManager userManager,
    IMediaEncoder mediaEncoder,
    IApplicationPaths applicationPaths,
    ILogger<ScrubPreviewService> logger)
{
    public const int BucketSeconds = 10;
    private const int ThumbnailWidth = 320;
    private const int MaxCachedTitles = 150;
    private static readonly TimeSpan SourceTtl = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan FrameTimeout = TimeSpan.FromSeconds(20);

    private readonly SemaphoreSlim _ffmpegGate = new(3);
    private readonly ConcurrentDictionary<string, (MediaSourceInfo Source, DateTime At)> _sources = new();
    private readonly ConcurrentDictionary<string, Lazy<Task<byte[]?>>> _inFlight = new();

    private string CacheRoot => Path.Combine(applicationPaths.CachePath, "jellio-scrub");

    public async Task<byte[]?> GetFrameAsync(BaseItem item, Guid userId, string? mediaSourceId, int seconds, CancellationToken cancellationToken)
    {
        var bucket = Math.Max(0, seconds / BucketSeconds) * BucketSeconds;
        var titleDir = Path.Combine(CacheRoot, item.Id.ToString("N") + "-" + Hash(mediaSourceId ?? string.Empty));
        var file = Path.Combine(titleDir, bucket.ToString(CultureInfo.InvariantCulture) + ".jpg");
        if (File.Exists(file))
        {
            return await File.ReadAllBytesAsync(file, cancellationToken).ConfigureAwait(false);
        }

        // Two hovers over the same bucket share one ffmpeg run.
        var lazy = _inFlight.GetOrAdd(file, _ => new Lazy<Task<byte[]?>>(() => GrabAsync(item, userId, mediaSourceId, bucket, titleDir, file)));
        try
        {
            return await lazy.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (lazy.Value.IsCompleted)
            {
                _inFlight.TryRemove(file, out _);
            }
        }
    }

    private async Task<byte[]?> GrabAsync(BaseItem item, Guid userId, string? mediaSourceId, int bucket, string titleDir, string file)
    {
        try
        {
            var source = await ResolveSourceAsync(item, userId, mediaSourceId).ConfigureAwait(false);
            if (source is null)
            {
                return null;
            }

            await _ffmpegGate.WaitAsync().ConfigureAwait(false);
            byte[]? frame;
            try
            {
                // A little into the bucket, not its very first frame, so
                // bucket 0 isn't always a black opening frame.
                frame = await RunFfmpegAsync(source, bucket + (BucketSeconds / 2.0)).ConfigureAwait(false);
            }
            finally
            {
                _ffmpegGate.Release();
            }

            if (frame is null || frame.Length == 0)
            {
                return null;
            }

            var isNewTitle = !Directory.Exists(titleDir);
            Directory.CreateDirectory(titleDir);
            await File.WriteAllBytesAsync(file, frame).ConfigureAwait(false);
            if (isNewTitle)
            {
                TrimCache();
            }

            return frame;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: scrub preview failed for {Name} at {Bucket}s", item.Name, bucket);
            return null;
        }
        finally
        {
            _inFlight.TryRemove(file, out _);
        }
    }

    private async Task<MediaSourceInfo?> ResolveSourceAsync(BaseItem item, Guid userId, string? mediaSourceId)
    {
        var key = item.Id.ToString("N") + "|" + (mediaSourceId ?? string.Empty);
        if (_sources.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.At < SourceTtl)
        {
            return cached.Source;
        }

        var user = userManager.GetUserById(userId);
        if (user is null)
        {
            return null;
        }

        var sources = await mediaSourceManager
            .GetPlaybackMediaSources(item, user, false, false, CancellationToken.None)
            .ConfigureAwait(false);
        var withPath = sources.Where(candidate => !string.IsNullOrEmpty(candidate.Path)).ToList();
        var source = withPath.FirstOrDefault(candidate => string.Equals(candidate.Id, mediaSourceId, StringComparison.OrdinalIgnoreCase))
            ?? withPath.FirstOrDefault();
        if (source is null || source.Path.StartsWith("gelato://", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        _sources[key] = (source, DateTime.UtcNow);
        return source;
    }

    private async Task<byte[]?> RunFfmpegAsync(MediaSourceInfo source, double offsetSeconds)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = mediaEncoder.EncoderPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in BuildArguments(source, offsetSeconds))
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        using var timeout = new CancellationTokenSource(FrameTimeout);
        try
        {
            process.Start();
            using var output = new MemoryStream();
            var copy = process.StandardOutput.BaseStream.CopyToAsync(output, timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            await copy.ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                logger.LogWarning(
                    "Jellio: scrub preview ffmpeg exited {Code} at {Offset}s: {Err}",
                    process.ExitCode,
                    offsetSeconds,
                    Truncate(await stderr.ConfigureAwait(false)));
                return null;
            }

            return output.ToArray();
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            logger.LogWarning("Jellio: scrub preview ffmpeg timed out at {Offset}s", offsetSeconds);
            return null;
        }
    }

    // -ss before -i: input seeking, a byte range request on an HTTP
    // source rather than decoding everything before the frame.
    private static List<string> BuildArguments(MediaSourceInfo source, double offsetSeconds)
    {
        var args = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error" };
        if (source.RequiredHttpHeaders is { Count: > 0 })
        {
            args.Add("-headers");
            args.Add(string.Join("\r\n", source.RequiredHttpHeaders.Select(h => h.Key + ": " + h.Value)) + "\r\n");
        }

        args.AddRange([
            "-ss", offsetSeconds.ToString("0.###", CultureInfo.InvariantCulture),
            "-i", source.Path,
            "-map", "0:v:0",
            "-frames:v", "1",
            "-an", "-sn",
            "-vf", "scale=" + ThumbnailWidth + ":-2",
            "-q:v", "6",
            "-f", "image2", "-c:v", "mjpeg", "-",
        ]);
        return args;
    }

    // Keeps the newest MaxCachedTitles titles' frames.
    private void TrimCache()
    {
        try
        {
            var titles = new DirectoryInfo(CacheRoot).GetDirectories()
                .OrderByDescending(dir => dir.LastWriteTimeUtc)
                .Skip(MaxCachedTitles);
            foreach (var dir in titles)
            {
                dir.Delete(true);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: could not trim the scrub preview cache");
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
            // Already exited.
        }
    }

    private static string Hash(string value) =>
        Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(value)))[..12].ToLowerInvariant();

    private static string Truncate(string value) => value.Length <= 500 ? value : value[..500];
}
