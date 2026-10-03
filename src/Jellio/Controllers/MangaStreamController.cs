using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Manga;
using Jellio.Services.Reading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// The Manga shelf's streamed series (MangaStreamService): Suwayomi's
/// library with this reader's progress, chapters, pages as they're read,
/// a chapter as a CBZ for reading offline, and saving a series to the
/// server.
/// </summary>
[ApiController]
[Route("Jellio/manga/stream")]
[Authorize]
public class MangaStreamController(
    MangaStreamService stream,
    MangaUpdatesService updates,
    SuwayomiClient suwayomi,
    ReadingProgressStore progressStore,
    ShelfStore shelfStore,
    ILogger<MangaStreamController> logger) : ControllerBase
{
    private const double Finished = 0.98;

    public record ChapterRef(string Id, int ChapterId, string Name);

    public record SeriesSummary(
        int MangaId,
        string Title,
        string? Author,
        string? Status,
        string Key,
        int ChapterCount,
        int DownloadedCount,
        int ReadCount,
        long LatestUpload,
        DateTimeOffset? LastReadAt,
        ChapterRef? Resume,
        string? FirstChapterId);

    public record SaveBody(List<int>? ChapterIds);

    [HttpGet("library")]
    public async Task<IActionResult> Library(CancellationToken cancellationToken)
    {
        if (!SuwayomiClient.IsConfigured || !TryUser(out var userId))
        {
            return Ok(Array.Empty<SeriesSummary>());
        }

        // This reader's series only: Discover and requests find the rest.
        var titles = await stream.GetTitlesAsync(cancellationToken).ConfigureAwait(false);
        if (titles is null)
        {
            return StatusCode(502, "Suwayomi could not be reached");
        }

        var mine = shelfStore.Library(userId);
        var ids = titles.Where(title => mine.Contains(ShelfStore.SeriesShelfKey(title.Title))).Select(title => title.MangaId);
        var library = await stream.GetSeriesAsync(ids, cancellationToken).ConfigureAwait(false);
        var progress = progressStore.GetAll(userId);
        var prefs = shelfStore.Load(userId).Series;
        return Ok(library.Select(series => Summarize(series, progress, prefs.GetValueOrDefault(ShelfStore.SeriesShelfKey(series.Title)))).ToList());
    }

    public record UpdateItem(string SeriesKey, string SeriesTitle, int MangaId, StreamChapter Chapter, long SeenAt, bool Read);

    // Chapters that turned up in the last library refreshes, newest
    // first, for this reader's series (Mihon's Updates).
    [HttpGet("updates")]
    public Task<IActionResult> Updates(CancellationToken cancellationToken) => UpdatesResult(cancellationToken);

    [HttpPost("updates/refresh")]
    public async Task<IActionResult> RefreshUpdates(CancellationToken cancellationToken)
    {
        await updates.RefreshAsync(true, cancellationToken).ConfigureAwait(false);
        return await UpdatesResult(cancellationToken).ConfigureAwait(false);
    }

    private async Task<IActionResult> UpdatesResult(CancellationToken cancellationToken)
    {
        var data = updates.Load();
        if (!SuwayomiClient.IsConfigured || !TryUser(out var userId))
        {
            return Ok(new { data.LastRefreshAt, Items = Array.Empty<UpdateItem>() });
        }

        var titles = await stream.GetTitlesAsync(cancellationToken).ConfigureAwait(false);
        var mine = shelfStore.Library(userId);
        var mineByManga = (titles ?? Array.Empty<StreamTitle>()).Where(title => mine.Contains(ShelfStore.SeriesShelfKey(title.Title))).ToDictionary(title => title.MangaId);
        var cutoff = DateTimeOffset.UtcNow.AddDays(-60).ToUnixTimeMilliseconds();
        var recent = data.Recent.Where(entry => entry.SeenAt >= cutoff && mineByManga.ContainsKey(entry.MangaId)).Take(300).ToList();
        var seriesList = await stream.GetSeriesAsync(recent.Select(entry => entry.MangaId), cancellationToken).ConfigureAwait(false);
        var seriesByManga = seriesList.ToDictionary(series => series.MangaId);
        var progress = progressStore.GetAll(userId);
        var prefs = shelfStore.Load(userId).Series;

        var items = new List<UpdateItem>();
        foreach (var entry in recent)
        {
            if (!seriesByManga.TryGetValue(entry.MangaId, out var series))
            {
                continue;
            }

            var chapter = series.Chapters.FirstOrDefault(candidate => candidate.ChapterId == entry.ChapterId);
            if (chapter is null)
            {
                continue;
            }

            prefs.TryGetValue(ShelfStore.SeriesShelfKey(series.Title), out var seriesPrefs);
            if (seriesPrefs?.SkipUpdates == true)
            {
                continue;
            }

            var excluded = seriesPrefs?.ExcludedScanlators;
            if (excluded is { Count: > 0 } && chapter.Scanlator is not null && excluded.Contains(chapter.Scanlator, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            var read = progress.TryGetValue(chapter.Id, out var record) && record.Progress >= Finished;
            if (!read && seriesPrefs?.DuplicatesAsOne != false && chapter.Number >= 0)
            {
                read = series.Chapters.Any(other => other.Number == chapter.Number && progress.TryGetValue(other.Id, out var done) && done.Progress >= Finished);
            }

            items.Add(new UpdateItem(series.Key, series.Title, series.MangaId, chapter, entry.SeenAt, read));
        }

        return Ok(new { data.LastRefreshAt, Items = items });
    }

    // Any series in Suwayomi's library by its shelf key (not only this
    // reader's), for opening one that isn't on their shelf.
    [HttpGet("by-key")]
    public async Task<IActionResult> ByKey([FromQuery] string key, CancellationToken cancellationToken)
    {
        var titles = await stream.GetTitlesAsync(cancellationToken).ConfigureAwait(false);
        var match = titles?.FirstOrDefault(title => title.Key == (key ?? string.Empty));
        return match is null ? NotFound() : Ok(new { match.MangaId, match.Title, match.Key });
    }

    [HttpGet("series/{mangaId:int}")]
    public async Task<IActionResult> Series(int mangaId, CancellationToken cancellationToken)
    {
        var series = await stream.GetSeriesAsync(mangaId, cancellationToken).ConfigureAwait(false);
        return series is null ? NotFound() : Ok(series);
    }

    // A chapter by its stream id, for the reader.
    [HttpGet("chapter/{id}")]
    public async Task<IActionResult> Chapter(string id, [FromQuery] int? manga, CancellationToken cancellationToken)
    {
        var found = await stream.FindChapterAsync(id, manga, cancellationToken).ConfigureAwait(false);
        if (found is null)
        {
            return NotFound();
        }

        var (chapter, series) = found.Value;
        return Ok(new { chapter.Id, chapter.ChapterId, chapter.MangaId, chapter.Name, chapter.Number, chapter.Scanlator, chapter.PageCount, SeriesTitle = series.Title, SeriesKey = series.Key });
    }

    [HttpGet("chapter/{chapterId:int}/pages")]
    public async Task<IActionResult> Pages(int chapterId, CancellationToken cancellationToken)
    {
        var pages = await stream.GetPagesAsync(chapterId, cancellationToken).ConfigureAwait(false);
        return pages is null ? StatusCode(502, "The source didn't send this chapter's pages") : Ok(new { Count = pages.Count });
    }

    [HttpGet("chapter/{chapterId:int}/page/{index:int}")]
    public async Task<IActionResult> Page(int chapterId, int index, CancellationToken cancellationToken)
    {
        var image = await stream.GetPageAsync(chapterId, index, cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(image.Value.Bytes, image.Value.ContentType);
    }

    // The whole chapter as a CBZ (for keeping on a device), written out
    // page by page as the source sends them.
    [HttpGet("chapter/{chapterId:int}/cbz")]
    public async Task Cbz(int chapterId, CancellationToken cancellationToken)
    {
        var pages = await stream.GetPagesAsync(chapterId, cancellationToken).ConfigureAwait(false);
        if (pages is null)
        {
            Response.StatusCode = 502;
            return;
        }

        Response.ContentType = "application/vnd.comicbook+zip";
        Response.Headers.ContentDisposition = "attachment; filename=\"chapter-" + chapterId + ".cbz\"";
        var buffer = new ChunkStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            var ahead = new Queue<Task<(byte[] Bytes, string ContentType)?>>();
            var next = 0;
            for (var index = 0; index < pages.Count; index++)
            {
                while (next < pages.Count && ahead.Count < 4)
                {
                    ahead.Enqueue(stream.GetPageAsync(chapterId, next++, cancellationToken));
                }

                var image = await ahead.Dequeue().ConfigureAwait(false);
                if (image is null)
                {
                    logger.LogWarning("Jellio: page {Index} of Suwayomi chapter {ChapterId} failed", index, chapterId);
                    HttpContext.Abort();
                    return;
                }

                var entry = archive.CreateEntry((index + 1).ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + Extension(image.Value.ContentType), CompressionLevel.NoCompression);
                using (var entryStream = entry.Open())
                {
                    entryStream.Write(image.Value.Bytes);
                }

                await buffer.DrainAsync(Response.Body, cancellationToken).ConfigureAwait(false);
            }
        }

        await buffer.DrainAsync(Response.Body, cancellationToken).ConfigureAwait(false);
    }

    // Downloads the series (or some chapters) into the library through
    // Suwayomi, for keeping on the server.
    [HttpPost("series/{mangaId:int}/save")]
    public async Task<IActionResult> Save(int mangaId, [FromBody] SaveBody? body, CancellationToken cancellationToken)
    {
        var series = await stream.GetSeriesAsync(mangaId, cancellationToken).ConfigureAwait(false);
        if (series is null)
        {
            return NotFound();
        }

        var wanted = body?.ChapterIds is { Count: > 0 } ids ? ids.ToHashSet() : null;
        var queue = series.Chapters
            .Where(chapter => !chapter.IsDownloaded && (wanted is null || wanted.Contains(chapter.ChapterId)))
            .Select(chapter => chapter.ChapterId)
            .ToList();
        if (!await suwayomi.EnqueueDownloadsAsync(queue, cancellationToken).ConfigureAwait(false))
        {
            return StatusCode(502, "Suwayomi couldn't queue the downloads");
        }

        stream.Invalidate();
        return Ok(new { Queued = queue.Count });
    }

    // The counts the shelf shows, under this reader's settings for the
    // series: chapters from excluded scanlators are left out, and (unless
    // turned off) a chapter whose number is read from another scanlator
    // counts as read too, the same as the series page.
    private static SeriesSummary Summarize(StreamSeries series, Dictionary<string, ReadingProgressRecord> progress, SeriesPrefs? prefs)
    {
        var excluded = prefs?.ExcludedScanlators;
        // Hiding every group would leave nothing, so then none are hidden.
        var shown = excluded is { Count: > 0 }
            ? series.Chapters.Where(chapter => chapter.Scanlator is null || !excluded.Contains(chapter.Scanlator, StringComparer.OrdinalIgnoreCase)).ToList()
            : null;
        IReadOnlyList<StreamChapter> chapters = shown is { Count: > 0 } ? shown : series.Chapters;
        var duplicatesAsOne = prefs?.DuplicatesAsOne != false;
        var finishedNumbers = duplicatesAsOne
            ? chapters
                .Where(chapter => chapter.Number >= 0 && progress.TryGetValue(chapter.Id, out var done) && done.Progress >= Finished)
                .Select(chapter => chapter.Number)
                .ToHashSet()
            : new HashSet<float>();
        bool IsFinished(StreamChapter chapter) =>
            (progress.TryGetValue(chapter.Id, out var record) && record.Progress >= Finished)
            || (chapter.Number >= 0 && finishedNumbers.Contains(chapter.Number));

        var furthestRead = -1;
        var readCount = 0;
        DateTimeOffset? lastRead = null;
        for (var i = 0; i < chapters.Count; i++)
        {
            if (progress.TryGetValue(chapters[i].Id, out var record) && record.Progress > 0)
            {
                lastRead = lastRead is null || record.UpdatedAt > lastRead ? record.UpdatedAt : lastRead;
            }

            if (IsFinished(chapters[i]))
            {
                furthestRead = i;
                readCount++;
            }
        }

        // Same rule as the web shelf (components/mangaSeries.js resumePoint).
        var resume = -1;
        for (var i = furthestRead + 1; i < chapters.Count && resume == -1; i++)
        {
            if (progress.TryGetValue(chapters[i].Id, out var record) && record.Progress is > 0 and < Finished)
            {
                resume = i;
            }
        }

        for (var i = furthestRead + 1; i < chapters.Count && resume == -1; i++)
        {
            if (!IsFinished(chapters[i]))
            {
                resume = i;
            }
        }

        var chapterCount = duplicatesAsOne
            ? chapters.Where(c => c.Number >= 0).Select(c => c.Number).Distinct().Count() + chapters.Count(c => c.Number < 0)
            : chapters.Count;
        var uniqueReadCount = duplicatesAsOne
            ? finishedNumbers.Count + chapters.Where(c => c.Number < 0 && IsFinished(c)).Select(c => c.Id).Distinct().Count()
            : readCount;

        return new SeriesSummary(
            series.MangaId,
            series.Title,
            series.Author,
            series.Status,
            series.Key,
            chapterCount,
            chapters.Count(chapter => chapter.IsDownloaded),
            uniqueReadCount,
            chapters.Count > 0 ? chapters.Max(chapter => chapter.UploadDate) : 0,
            lastRead,
            resume == -1 ? null : new ChapterRef(chapters[resume].Id, chapters[resume].ChapterId, chapters[resume].Name),
            chapters.Count > 0 ? chapters[0].Id : null);
    }

    private static string Extension(string contentType) => contentType switch
    {
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/avif" => ".avif",
        _ => ".jpg",
    };

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }

    // What ZipArchive writes, held until it's copied to the response
    // asynchronously (Kestrel refuses synchronous writes). Not seekable, so
    // ZipArchive writes straight through with data descriptors.
    private sealed class ChunkStream : Stream
    {
        private readonly MemoryStream _buffer = new();
        private long _written;

        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _written;
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            _buffer.Write(buffer, offset, count);
            _written += count;
        }

        public override void Flush()
        {
        }

        public async Task DrainAsync(Stream target, CancellationToken cancellationToken)
        {
            if (_buffer.Length == 0)
            {
                return;
            }

            _buffer.Position = 0;
            await _buffer.CopyToAsync(target, cancellationToken).ConfigureAwait(false);
            _buffer.SetLength(0);
            await target.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
