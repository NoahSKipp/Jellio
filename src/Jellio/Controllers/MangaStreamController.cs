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
    SuwayomiClient suwayomi,
    ReadingProgressStore progressStore,
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

        var library = await stream.GetLibraryAsync(cancellationToken).ConfigureAwait(false);
        if (library is null)
        {
            return StatusCode(502, "Suwayomi could not be reached");
        }

        var progress = progressStore.GetAll(userId);
        return Ok(library.Select(series => Summarize(series, progress)).ToList());
    }

    [HttpGet("series/{mangaId:int}")]
    public async Task<IActionResult> Series(int mangaId, CancellationToken cancellationToken)
    {
        var series = await stream.GetSeriesAsync(mangaId, cancellationToken).ConfigureAwait(false);
        return series is null ? NotFound() : Ok(series);
    }

    // A chapter by its stream id, for the reader.
    [HttpGet("chapter/{id}")]
    public async Task<IActionResult> Chapter(string id, CancellationToken cancellationToken)
    {
        var found = await stream.FindChapterAsync(id, cancellationToken).ConfigureAwait(false);
        if (found is null)
        {
            return NotFound();
        }

        var (chapter, series) = found.Value;
        return Ok(new { chapter.Id, chapter.ChapterId, chapter.MangaId, chapter.Name, chapter.PageCount, SeriesTitle = series.Title, SeriesKey = series.Key });
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

    private static SeriesSummary Summarize(StreamSeries series, Dictionary<string, ReadingProgressRecord> progress)
    {
        var chapters = series.Chapters;
        var furthestRead = -1;
        var readCount = 0;
        DateTimeOffset? lastRead = null;
        for (var i = 0; i < chapters.Count; i++)
        {
            if (!progress.TryGetValue(chapters[i].Id, out var record) || record.Progress <= 0)
            {
                continue;
            }

            lastRead = lastRead is null || record.UpdatedAt > lastRead ? record.UpdatedAt : lastRead;
            if (record.Progress >= Finished)
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
            if (!progress.TryGetValue(chapters[i].Id, out var record) || record.Progress < Finished)
            {
                resume = i;
            }
        }

        return new SeriesSummary(
            series.MangaId,
            series.Title,
            series.Author,
            series.Status,
            series.Key,
            chapters.Count,
            chapters.Count(chapter => chapter.IsDownloaded),
            readCount,
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
