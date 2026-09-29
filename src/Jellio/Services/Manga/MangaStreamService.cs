using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Reading;

namespace Jellio.Services.Manga;

// Id: a stable Guid for the chapter (StreamIds), what reading progress,
// bookmarks and downloads on the device are keyed by.
public record StreamChapter(string Id, int ChapterId, int MangaId, string Name, float Number, string? Scanlator, bool IsDownloaded, int PageCount, long UploadDate);

public record StreamSeries(int MangaId, string Title, string? Author, string? Status, string Key, IReadOnlyList<StreamChapter> Chapters);

/// <summary>
/// Manga read straight from Suwayomi's sources, the way Mihon reads:
/// Suwayomi's library is the shelf, and pages come from the source (via
/// Suwayomi) as they're read. Nothing is kept on the server unless a
/// reader saves a series (SuwayomiClient.EnqueueDownloadsAsync).
/// </summary>
public class MangaStreamService(SuwayomiClient suwayomi)
{
    private static readonly TimeSpan LibraryTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan PagesTtl = TimeSpan.FromMinutes(30);

    private readonly SemaphoreSlim _libraryLock = new(1, 1);
    private readonly ConcurrentDictionary<int, (DateTime At, IReadOnlyList<string> Pages)> _pages = new();
    private (DateTime At, List<StreamSeries> Series, Dictionary<string, (StreamChapter Chapter, StreamSeries Series)> ById)? _library;

    public static string ChapterId(int chapterId)
    {
        var hash = MD5.HashData(Encoding.UTF8.GetBytes("jellio:suwayomi-chapter:" + chapterId));
        return new Guid(hash).ToString("N");
    }

    public void Invalidate() => _library = null;

    public async Task<IReadOnlyList<StreamSeries>?> GetLibraryAsync(CancellationToken cancellationToken)
    {
        if (_library is { } cached && DateTime.UtcNow - cached.At < LibraryTtl)
        {
            return cached.Series;
        }

        await _libraryLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_library is { } fresh && DateTime.UtcNow - fresh.At < LibraryTtl)
            {
                return fresh.Series;
            }

            var library = await suwayomi.GetLibraryWithChaptersAsync(cancellationToken).ConfigureAwait(false);
            if (library is null)
            {
                return _library?.Series;
            }

            var series = library.Select(manga => ToSeries(manga.Id, manga.Title, manga.Author, manga.Status, manga.Chapters)).ToList();
            Store(series);
            return series;
        }
        finally
        {
            _libraryLock.Release();
        }
    }

    // One series; a series Suwayomi has never loaded chapters for gets them
    // fetched from the source now.
    public async Task<StreamSeries?> GetSeriesAsync(int mangaId, CancellationToken cancellationToken)
    {
        var library = await GetLibraryAsync(cancellationToken).ConfigureAwait(false);
        var series = library?.FirstOrDefault(entry => entry.MangaId == mangaId);
        if (series is null || series.Chapters.Count > 0)
        {
            return series;
        }

        await suwayomi.FetchChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false);
        var chapters = await suwayomi.GetChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false);
        if (chapters is null || chapters.Count == 0)
        {
            return series;
        }

        var loaded = ToSeries(series.MangaId, series.Title, series.Author, series.Status, chapters);
        if (_library is { } current)
        {
            var list = current.Series.Select(entry => entry.MangaId == mangaId ? loaded : entry).ToList();
            Store(list);
        }

        return loaded;
    }

    public async Task<(StreamChapter Chapter, StreamSeries Series)?> FindChapterAsync(string id, CancellationToken cancellationToken)
    {
        var key = id.Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
        if (_library?.ById.TryGetValue(key, out var hit) == true)
        {
            return hit;
        }

        await GetLibraryAsync(cancellationToken).ConfigureAwait(false);
        return _library?.ById.TryGetValue(key, out var found) == true ? found : null;
    }

    public async Task<(StreamChapter Chapter, StreamSeries Series)?> FindChapterAsync(int chapterId, CancellationToken cancellationToken) =>
        await FindChapterAsync(ChapterId(chapterId), cancellationToken).ConfigureAwait(false);

    public async Task<IReadOnlyList<string>?> GetPagesAsync(int chapterId, CancellationToken cancellationToken)
    {
        if (_pages.TryGetValue(chapterId, out var cached) && DateTime.UtcNow - cached.At < PagesTtl)
        {
            return cached.Pages;
        }

        var pages = await suwayomi.FetchChapterPagesAsync(chapterId, cancellationToken).ConfigureAwait(false);
        if (pages is null || pages.Count == 0)
        {
            return null;
        }

        _pages[chapterId] = (DateTime.UtcNow, pages);
        return pages;
    }

    public async Task<(byte[] Bytes, string ContentType)?> GetPageAsync(int chapterId, int index, CancellationToken cancellationToken)
    {
        var pages = await GetPagesAsync(chapterId, cancellationToken).ConfigureAwait(false);
        if (pages is null || index < 0 || index >= pages.Count)
        {
            return null;
        }

        var image = await suwayomi.GetImageAsync(pages[index], cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            // The page list can go stale (the source moved its images).
            _pages.TryRemove(chapterId, out _);
        }

        return image;
    }

    private static StreamSeries ToSeries(int mangaId, string title, string? author, string? status, IReadOnlyList<SuwayomiStreamChapter> chapters)
    {
        var ordered = chapters
            .OrderBy(chapter => chapter.ChapterNumber < 0 ? float.MaxValue : chapter.ChapterNumber)
            .ThenBy(chapter => chapter.SourceOrder)
            .Select(chapter => new StreamChapter(
                ChapterId(chapter.Id),
                chapter.Id,
                mangaId,
                chapter.Name,
                chapter.ChapterNumber,
                chapter.Scanlator,
                chapter.IsDownloaded,
                chapter.PageCount,
                chapter.UploadDate))
            .ToList();
        return new StreamSeries(mangaId, title, author, status, ShelfStore.SeriesKey(title), ordered);
    }

    private void Store(List<StreamSeries> series)
    {
        var byId = new Dictionary<string, (StreamChapter, StreamSeries)>(StringComparer.Ordinal);
        foreach (var entry in series)
        {
            foreach (var chapter in entry.Chapters)
            {
                byId[chapter.Id] = (chapter, entry);
            }
        }

        _library = (DateTime.UtcNow, series, byId);
    }
}
