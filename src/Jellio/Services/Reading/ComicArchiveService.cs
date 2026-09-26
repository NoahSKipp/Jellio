using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;
using SharpCompress.Archives;

namespace Jellio.Services.Reading;

/// <summary>
/// CBR (RAR) and CB7 (7z) comics repacked as CBZ, the one comic archive a
/// browser can open (screens/reader.js reads it with JSZip). Pages are
/// copied, not recompressed, into a cached CBZ keyed by the file and its
/// last write time, so a volume is converted once and re-read for free.
/// </summary>
public class ComicArchiveService(IApplicationPaths applicationPaths, ILogger<ComicArchiveService> logger)
{
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromDays(14);

    private readonly ConcurrentDictionary<string, object> _locks = new(StringComparer.Ordinal);

    private string CacheDirectory => Path.Combine(applicationPaths.CachePath, "jellio-comics");

    public static bool NeedsConversion(string path)
    {
        var extension = Path.GetExtension(path);
        return extension.Equals(".cbr", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".cb7", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".cbt", StringComparison.OrdinalIgnoreCase);
    }

    public string? GetCbz(Guid itemId, string sourcePath)
    {
        var stamp = File.GetLastWriteTimeUtc(sourcePath).Ticks;
        var target = Path.Combine(CacheDirectory, itemId.ToString("N") + "-" + stamp.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".cbz");
        if (File.Exists(target))
        {
            return target;
        }

        var gate = _locks.GetOrAdd(target, _ => new object());
        lock (gate)
        {
            if (File.Exists(target))
            {
                return target;
            }

            Directory.CreateDirectory(CacheDirectory);
            PruneCache();
            var partial = target + ".partial";
            try
            {
                using (var archive = ArchiveFactory.Open(sourcePath))
                using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write))
                using (var zip = new ZipArchive(output, ZipArchiveMode.Create))
                {
                    foreach (var entry in archive.Entries.Where(entry => !entry.IsDirectory && entry.Key is not null))
                    {
                        // Page images are already compressed; storing them
                        // is much faster and no bigger.
                        var zipEntry = zip.CreateEntry(entry.Key!.Replace('\\', '/'), CompressionLevel.NoCompression);
                        using var from = entry.OpenEntryStream();
                        using var to = zipEntry.Open();
                        from.CopyTo(to);
                    }
                }

                File.Move(partial, target, true);
                return target;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: could not convert comic archive {Path}", sourcePath);
                TryDelete(partial);
                return null;
            }
            finally
            {
                _locks.TryRemove(target, out _);
            }
        }
    }

    private void PruneCache()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(CacheDirectory))
            {
                var lastUsed = File.GetLastAccessTimeUtc(file) > File.GetLastWriteTimeUtc(file) ? File.GetLastAccessTimeUtc(file) : File.GetLastWriteTimeUtc(file);
                if (DateTime.UtcNow - lastUsed > CacheLifetime)
                {
                    TryDelete(file);
                }
            }
        }
        catch (IOException ex)
        {
            logger.LogDebug(ex, "Jellio: could not prune the comic cache");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // In use or already gone; the next prune gets it.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }
}
