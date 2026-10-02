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
public record StreamChapter(string Id, int ChapterId, int MangaId, string Name, float Number, string? Scanlator, bool IsDownloaded, int PageCount, long UploadDate, int SourceOrder = 0);

public record StreamSeries(int MangaId, string Title, string? Author, string? Status, string Key, IReadOnlyList<StreamChapter> Chapters);

public record StreamTitle(int MangaId, string Title, string Key);

/// <summary>
/// Manga read straight from Suwayomi's sources, the way Mihon reads:
/// Suwayomi's library holds the series, each reader's shelf shows their
/// own, and pages come from the source (via Suwayomi) as they're read.
/// Chapters load per series, when a series is shown or opened, and are
/// cached. Nothing is kept on the server unless a reader saves a series
/// (SuwayomiClient.EnqueueDownloadsAsync).
/// </summary>
public class MangaStreamService(SuwayomiClient suwayomi)
{
    private const int ParallelSeries = 6;
    private static readonly TimeSpan TitlesTtl = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan SeriesTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan PagesTtl = TimeSpan.FromMinutes(30);

    private readonly ConcurrentDictionary<int, (DateTime At, IReadOnlyList<string> Pages)> _pages = new();
    private readonly ConcurrentDictionary<int, (DateTime At, StreamSeries Series)> _series = new();
    private readonly ConcurrentDictionary<string, (StreamChapter Chapter, StreamSeries Series)> _byId = new(StringComparer.Ordinal);
    private (DateTime At, IReadOnlyList<StreamTitle> Titles)? _titles;

    public static string ChapterId(int chapterId)
    {
        var hash = MD5.HashData(Encoding.UTF8.GetBytes("jellio:suwayomi-chapter:" + chapterId));
        return new Guid(hash).ToString("N");
    }

    public void Invalidate()
    {
        _titles = null;
        _series.Clear();
    }

    // Every series in Suwayomi's library, titles only (cheap).
    public async Task<IReadOnlyList<StreamTitle>?> GetTitlesAsync(CancellationToken cancellationToken)
    {
        if (_titles is { } cached && DateTime.UtcNow - cached.At < TitlesTtl)
        {
            return cached.Titles;
        }

        var library = await suwayomi.GetLibraryAsync(cancellationToken).ConfigureAwait(false);
        if (library is null)
        {
            return _titles?.Titles;
        }

        var titles = library.Select(entry => new StreamTitle(entry.Id, entry.Title, ShelfStore.SeriesKey(entry.Title))).ToList();
        _titles = (DateTime.UtcNow, titles);
        return titles;
    }

    // One series with its chapters; a series Suwayomi has never loaded
    // chapters for gets them fetched from the source now.
    public async Task<StreamSeries?> GetSeriesAsync(int mangaId, CancellationToken cancellationToken)
    {
        if (_series.TryGetValue(mangaId, out var cached) && DateTime.UtcNow - cached.At < SeriesTtl)
        {
            return cached.Series;
        }

        var titles = await GetTitlesAsync(cancellationToken).ConfigureAwait(false);
        var title = titles?.FirstOrDefault(entry => entry.MangaId == mangaId);
        if (title is null)
        {
            return null;
        }

        var chapters = await suwayomi.GetChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false);
        if (chapters is { Count: 0 })
        {
            await suwayomi.FetchChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false);
            chapters = await suwayomi.GetChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false);
        }

        if (chapters is null)
        {
            return cached.Series;
        }

        var series = ToSeries(mangaId, title.Title, null, null, chapters);
        _series[mangaId] = (DateTime.UtcNow, series);
        foreach (var chapter in series.Chapters)
        {
            _byId[chapter.Id] = (chapter, series);
        }

        return series;
    }

    // Several series, a few at a time.
    public async Task<IReadOnlyList<StreamSeries>> GetSeriesAsync(IEnumerable<int> mangaIds, CancellationToken cancellationToken)
    {
        using var throttle = new SemaphoreSlim(ParallelSeries);
        var loads = mangaIds.Distinct().Select(async id =>
        {
            await throttle.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await GetSeriesAsync(id, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                throttle.Release();
            }
        }).ToList();
        var loaded = await Task.WhenAll(loads).ConfigureAwait(false);
        return loaded.OfType<StreamSeries>().ToList();
    }

    // A chapter by its stream id. mangaHint (the series it belongs to, when
    // the caller knows it) saves looking through every series.
    public async Task<(StreamChapter Chapter, StreamSeries Series)?> FindChapterAsync(string id, int? mangaHint, CancellationToken cancellationToken)
    {
        var key = id.Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
        if (_byId.TryGetValue(key, out var hit))
        {
            return hit;
        }

        if (mangaHint is > 0)
        {
            await GetSeriesAsync(mangaHint.Value, cancellationToken).ConfigureAwait(false);
            if (_byId.TryGetValue(key, out var hinted))
            {
                return hinted;
            }
        }

        var titles = await GetTitlesAsync(cancellationToken).ConfigureAwait(false);
        if (titles is null)
        {
            return null;
        }

        await GetSeriesAsync(titles.Select(title => title.MangaId).Where(mangaId => !_series.ContainsKey(mangaId)), cancellationToken).ConfigureAwait(false);
        return _byId.TryGetValue(key, out var found) ? found : null;
    }

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
                chapter.UploadDate,
                chapter.SourceOrder))
            .ToList();
        return new StreamSeries(mangaId, title, author, status, ShelfStore.SeriesKey(title), ordered);
    }
}
