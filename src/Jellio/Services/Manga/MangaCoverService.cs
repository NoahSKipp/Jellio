using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

/// <summary>
/// The cover of a manga series on the Manga shelf. Series there are
/// folders of chapter files, and Jellyfin's only image for each file is
/// that chapter's first page, so the series' real cover comes from, in
/// order: a cover image in the series folder, Suwayomi's own cover for the
/// series (matched by title, which is also its folder name), or AniList's
/// by title search. Where each series' cover comes from is remembered.
/// </summary>
public class MangaCoverService(SuwayomiClient suwayomi, AniListClient aniList, ILogger<MangaCoverService> logger)
{
    private static readonly string[] CoverNames = ["cover", "folder", "poster", "series"];
    private static readonly string[] ImageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
    private static readonly TimeSpan MissTtl = TimeSpan.FromHours(1);

    // folder path -> where its cover comes from (null: none found, retried
    // after MissTtl).
    private readonly ConcurrentDictionary<string, (DateTime At, string? Source)> _sources = new(StringComparer.Ordinal);

    public async Task<(byte[] Bytes, string ContentType)?> GetCoverAsync(string seriesFolder, CancellationToken cancellationToken)
    {
        if (_sources.TryGetValue(seriesFolder, out var known) && (known.Source is not null || DateTime.UtcNow - known.At < MissTtl))
        {
            return known.Source is null ? null : await LoadAsync(known.Source, cancellationToken).ConfigureAwait(false);
        }

        var source = await ResolveAsync(seriesFolder, cancellationToken).ConfigureAwait(false);
        _sources[seriesFolder] = (DateTime.UtcNow, source);
        return source is null ? null : await LoadAsync(source, cancellationToken).ConfigureAwait(false);
    }

    private async Task<string?> ResolveAsync(string seriesFolder, CancellationToken cancellationToken)
    {
        try
        {
            if (Directory.Exists(seriesFolder))
            {
                var file = Directory.EnumerateFiles(seriesFolder)
                    .FirstOrDefault(path =>
                        CoverNames.Contains(Path.GetFileNameWithoutExtension(path), StringComparer.OrdinalIgnoreCase)
                        && ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase));
                if (file is not null)
                {
                    return "file:" + file;
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: could not look for a cover in {Folder}", seriesFolder);
        }

        var title = Path.GetFileName(seriesFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var wanted = Normalize(title);
        if (SuwayomiClient.IsConfigured)
        {
            var library = await suwayomi.GetLibraryAsync(cancellationToken).ConfigureAwait(false);
            var match = library?.FirstOrDefault(entry => Normalize(entry.Title) == wanted);
            if (match is { Id: > 0 } found)
            {
                return "suwayomi:" + found.Id;
            }
        }

        var series = await aniList.BrowseAsync("SEARCH_MATCH", null, null, title, 0, cancellationToken).ConfigureAwait(false);
        var best = series?.FirstOrDefault(entry => Normalize(entry.Title) == wanted || (entry.AltTitle is not null && Normalize(entry.AltTitle) == wanted))
            ?? series?.FirstOrDefault();
        return best?.CoverUrl is { } cover ? "anilist:" + cover : null;
    }

    private async Task<(byte[] Bytes, string ContentType)?> LoadAsync(string source, CancellationToken cancellationToken)
    {
        if (source.StartsWith("file:", StringComparison.Ordinal))
        {
            var path = source[5..];
            try
            {
                var bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                var type = Path.GetExtension(path).ToLowerInvariant() switch
                {
                    ".png" => "image/png",
                    ".webp" => "image/webp",
                    _ => "image/jpeg",
                };
                return (bytes, type);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        if (source.StartsWith("suwayomi:", StringComparison.Ordinal) && int.TryParse(source[9..], out var mangaId))
        {
            return await suwayomi.GetThumbnailAsync(mangaId, cancellationToken).ConfigureAwait(false);
        }

        return source.StartsWith("anilist:", StringComparison.Ordinal)
            ? await aniList.GetCoverAsync(source[8..], cancellationToken).ConfigureAwait(false)
            : null;
    }

    private static string Normalize(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var c in text.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c))
            {
                builder.Append(c);
            }
        }

        return builder.ToString();
    }
}
