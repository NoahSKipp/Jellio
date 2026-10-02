using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using Jellio.Services.Manga;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// Manga, manhwa and manhua requests through Suwayomi (SuwayomiClient):
/// find a series on the configured Suwayomi sources, then add it to
/// Suwayomi's library and download every chapter. Its downloads folder is
/// meant to be the Jellyfin library the Manga shelf reads.
/// </summary>
[ApiController]
[Route("Jellio/manga")]
[Authorize]
public partial class MangaRequestController(
    SuwayomiClient suwayomi,
    MangaImportService importService,
    MangaStreamService streamService,
    Jellio.Services.Reading.ShelfStore shelfStore,
    Jellio.Services.Reading.ReadingProgressStore progressStore,
    MangaCoverService coverService,
    ILibraryManager libraryManager,
    IUserManager userManager,
    ILogger<MangaRequestController> logger) : ControllerBase
{
    private const int MaxBackupBytes = 64 * 1024 * 1024;
    private const int MaxSources = 16;
    private const int ResultsPerSource = 6;
    private static readonly TimeSpan SearchBudget = TimeSpan.FromSeconds(25);

    public record SourceResult(long SourceId, string SourceName, string Lang, IReadOnlyList<MangaResult> Results);

    public record MangaResult(int MangaId, string Title, string? Author, string? Status, bool InLibrary, string ThumbnailUrl, double Match);

    // Searched/Failed: how many sources were asked and how many errored or
    // ran out of time; Languages and InstalledLanguages explain an empty
    // result (no sources at all, or none in the configured languages).
    public record SearchResponse(
        int Searched,
        int Failed,
        IReadOnlyList<string> Languages,
        IReadOnlyList<string> InstalledLanguages,
        int TotalSources,
        int NsfwSources,
        IReadOnlyList<SourceResult> Sources);

    // AddToLibrary: false when the reader is only opening the series to
    // read (Discover's Read); reading it adds it to their shelf anyway.
    // Force: add it even though the library has a series by that title.
    public record RequestBody(int MangaId, string? Title, bool AddToLibrary = true, bool Force = false);

    // The same series from another source: ToMangaId replaces FromMangaId
    // on the reader's shelf, keeping their progress.
    public record MigrateBody(int FromMangaId, int ToMangaId, string? ToTitle);

    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken cancellationToken)
    {
        if (!SuwayomiClient.IsConfigured)
        {
            return Ok(new { Configured = false, Reachable = false, DownloadAsCbz = false, AutoDownloadNewChapters = false });
        }

        var settings = await suwayomi.GetSettingsAsync(cancellationToken).ConfigureAwait(false);
        return Ok(new
        {
            Configured = true,
            Reachable = settings is not null,
            DownloadAsCbz = settings?.DownloadAsCbz ?? false,
            AutoDownloadNewChapters = settings?.AutoDownloadNewChapters ?? false,
        });
    }

    /// <summary>
    /// Searches every configured-language source at once (four at a time,
    /// within a time budget) and returns each source's closest matches,
    /// best-matching sources first.
    /// </summary>
    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q, CancellationToken cancellationToken)
    {
        var query = q?.Trim();
        if (string.IsNullOrEmpty(query) || query.Length > 120)
        {
            return BadRequest("q must be 1 to 120 characters");
        }

        var sources = await suwayomi.GetSourcesAsync(cancellationToken).ConfigureAwait(false);
        if (sources is null)
        {
            return StatusCode(502, "Suwayomi could not be reached or is not configured");
        }

        var wanted = Normalize(query);
        var toSearch = sources.Matching.Take(MaxSources).ToList();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(SearchBudget);
        using var throttle = new SemaphoreSlim(4);
        var searches = toSearch.Select(async Task<SourceResult?> (SuwayomiSource source) =>
        {
            await throttle.WaitAsync(budget.Token).ConfigureAwait(false);
            try
            {
                var found = await suwayomi.SearchAsync(source.Id, query, budget.Token).ConfigureAwait(false);
                if (found is null)
                {
                    return null;
                }

                var results = found
                    .Select(manga => new MangaResult(
                        manga.Id,
                        manga.Title,
                        manga.Author,
                        manga.Status,
                        manga.InLibrary,
                        "/Jellio/manga/thumbnail/" + manga.Id,
                        Similarity(wanted, Normalize(manga.Title))))
                    .OrderByDescending(result => result.Match)
                    .Take(ResultsPerSource)
                    .ToList();
                return new SourceResult(source.Id, source.Name, source.Lang, results);
            }
            finally
            {
                throttle.Release();
            }
        }).ToList();

        try
        {
            await Task.WhenAll(searches).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Out of time: return the sources that answered.
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: a Suwayomi source search failed");
        }

        var answered = searches
            .Where(search => search.IsCompletedSuccessfully && search.Result is not null)
            .Select(search => search.Result!)
            .ToList();
        var failed = toSearch.Count - answered.Count;
        if (failed > 0)
        {
            logger.LogInformation("Jellio: {Failed} of {Searched} Suwayomi sources failed or timed out searching {Query}", failed, toSearch.Count, query);
        }

        return Ok(new SearchResponse(
            toSearch.Count,
            failed,
            SuwayomiClient.Languages().Order(StringComparer.Ordinal).ToList(),
            sources.InstalledLanguages,
            sources.Total,
            sources.Nsfw,
            answered
                .Where(source => source.Results.Count > 0)
                .OrderByDescending(source => source.Results[0].Match)
                .ThenBy(source => source.SourceName, StringComparer.OrdinalIgnoreCase)
                .ToList()));
    }

    // Switch a series to another source (Mihon's migrate): the new one is
    // added and its chapters loaded, the reader's progress is carried over
    // by chapter number, their settings and place on the shelf move to the
    // new series, and the old one leaves the server's library unless
    // someone else is still reading it.
    [HttpPost("migrate")]
    public async Task<IActionResult> Migrate([FromBody] MigrateBody body, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (body is null || body.FromMangaId <= 0 || body.ToMangaId <= 0 || body.FromMangaId == body.ToMangaId || userId == Guid.Empty)
        {
            return BadRequest();
        }

        var from = await streamService.GetSeriesAsync(body.FromMangaId, cancellationToken).ConfigureAwait(false);
        if (from is null)
        {
            return NotFound();
        }

        var added = await suwayomi.AddAndFetchAsync(body.ToMangaId, cancellationToken).ConfigureAwait(false);
        streamService.Invalidate();
        var to = added.Success ? await streamService.GetSeriesAsync(body.ToMangaId, cancellationToken).ConfigureAwait(false) : null;
        if (to is null)
        {
            return StatusCode(502, added.Message ?? "Suwayomi couldn't load the new source's chapters");
        }

        var progress = progressStore.GetAll(userId);
        var carried = new List<(Guid, string, double, int?, DateTimeOffset?)>();
        foreach (var chapter in from.Chapters.Where(chapter => chapter.Number >= 0))
        {
            if (!progress.TryGetValue(chapter.Id, out var record) || record.Progress <= 0)
            {
                continue;
            }

            foreach (var match in to.Chapters.Where(candidate => candidate.Number == chapter.Number))
            {
                if (Guid.TryParseExact(match.Id, "N", out var matchId))
                {
                    carried.Add((matchId, record.Locator, record.Progress, record.TotalPages, record.UpdatedAt));
                }
            }
        }

        var written = progressStore.SetMany(userId, carried, true);

        var fromKey = Jellio.Services.Reading.ShelfStore.SeriesShelfKey(from.Title);
        var toKey = Jellio.Services.Reading.ShelfStore.SeriesShelfKey(to.Title);
        shelfStore.MoveSeries(userId, fromKey, toKey);

        var removed = false;
        if (!shelfStore.OthersHaveSeries(userId, fromKey))
        {
            removed = await suwayomi.RemoveFromLibraryAsync(body.FromMangaId, cancellationToken).ConfigureAwait(false);
            streamService.Invalidate();
        }

        logger.LogInformation(
            "Jellio: migrated {Title} from Suwayomi manga {From} to {To}, {Count} chapters of progress carried, old source removed: {Removed}",
            to.Title,
            body.FromMangaId,
            body.ToMangaId,
            written,
            removed);
        return Ok(new { Migrated = written, Removed = removed, MangaId = to.MangaId, to.Title, to.Key });
    }

    [HttpPost("request")]
    public async Task<IActionResult> RequestSeries([FromBody] RequestBody body, CancellationToken cancellationToken)
    {
        if (body is null || body.MangaId <= 0)
        {
            return BadRequest("MangaId is required");
        }

        // The same title already in the library from another source: say so
        // rather than quietly adding a second copy.
        if (!body.Force && !string.IsNullOrWhiteSpace(body.Title))
        {
            var wanted = Jellio.Services.Reading.ShelfStore.SeriesKey(body.Title);
            var titles = await streamService.GetTitlesAsync(cancellationToken).ConfigureAwait(false);
            var existing = titles?.FirstOrDefault(title => title.MangaId != body.MangaId && title.Key == wanted);
            if (existing is not null)
            {
                return Ok(new { Status = "duplicate", Existing = new { existing.MangaId, existing.Title, existing.Key } });
            }
        }

        // Streamed from the source unless the admin keeps requests on the
        // server too.
        var result = JellioPlugin.Instance?.Configuration.SuwayomiDownloadRequests == true
            ? await suwayomi.AddAndDownloadAsync(body.MangaId, cancellationToken).ConfigureAwait(false)
            : await suwayomi.AddAndFetchAsync(body.MangaId, cancellationToken).ConfigureAwait(false);
        streamService.Invalidate();

        // On the requester's own shelf.
        var requesterId = GetUserId();
        if (result.Success && body.AddToLibrary && requesterId != Guid.Empty && !string.IsNullOrWhiteSpace(body.Title))
        {
            shelfStore.SetInLibrary(requesterId, Jellio.Services.Reading.ShelfStore.SeriesShelfKey(body.Title), true);
        }

        var requester = HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
                ? userManager.GetUserById(userId)?.Username
                : null;
        if (result.Success)
        {
            logger.LogInformation(
                "Jellio: {User} requested {Title} (Suwayomi manga {MangaId}), {Queued} of {Total} chapters queued",
                requester ?? "a user",
                body.Title ?? "a series",
                body.MangaId,
                result.QueuedChapters,
                result.TotalChapters);
        }

        return Ok(new
        {
            Status = !result.Success ? "error" : result.AlreadyInLibrary ? "exists" : "added",
            result.QueuedChapters,
            result.TotalChapters,
            result.Message,
        });
    }

    public record ImportStatus(MangaImportJob? Job, int PendingChapters);

    /// <summary>
    /// Imports the caller's Mihon library from a backup file (.tachibk,
    /// sent as the raw request body): series in their library are added
    /// to Suwayomi and downloaded from where they left off, and their
    /// progress is applied as the chapters reach Jellyfin.
    /// </summary>
    [HttpPost("import")]
    [RequestSizeLimit(MaxBackupBytes)]
    public async Task<IActionResult> Import(CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (!SuwayomiClient.IsConfigured)
        {
            return BadRequest("Suwayomi isn't set up on this server");
        }

        using var buffer = new System.IO.MemoryStream();
        await Request.Body.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (buffer.Length == 0 || buffer.Length > MaxBackupBytes)
        {
            return BadRequest("Send a Mihon backup file (.tachibk)");
        }

        MihonBackup backup;
        try
        {
            backup = MihonBackupReader.Read(buffer.ToArray());
        }
        catch (Exception ex) when (ex is System.IO.InvalidDataException or OverflowException)
        {
            logger.LogInformation(ex, "Jellio: rejected a Mihon backup");
            return BadRequest("That file isn't a Mihon backup. Create one in Mihon under Settings, Data and storage, Create backup.");
        }

        var library = backup.Manga.Where(manga => manga.Favorite).ToList();
        if (library.Count == 0)
        {
            return BadRequest("This backup has no series in its library");
        }

        var job = importService.Start(userId, library, backup.Categories);
        if (job is null)
        {
            return Conflict("An import is already running");
        }

        var requester = userManager.GetUserById(userId)?.Username ?? userId.ToString("N");
        logger.LogInformation("Jellio: {User} started a Mihon import of {Count} series", requester, library.Count);
        return Ok(new ImportStatus(job, importService.PendingCount(userId)));
    }

    [HttpGet("import")]
    public IActionResult ImportProgress()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var job = importService.GetJob(userId);
        if (job is null)
        {
            return Ok(new ImportStatus(null, importService.PendingCount(userId)));
        }

        lock (job)
        {
            return Ok(new ImportStatus(job, importService.PendingCount(userId)));
        }
    }

    // The real cover of the series a chapter file belongs to (its folder),
    // for the Manga shelf's series cards (MangaCoverService).
    [HttpGet("series-cover/{itemId:guid}")]
    public async Task<IActionResult> SeriesCover(Guid itemId, CancellationToken cancellationToken)
    {
        var folder = libraryManager.GetItemById(itemId)?.Path is { Length: > 0 } path ? System.IO.Path.GetDirectoryName(path) : null;
        if (string.IsNullOrEmpty(folder))
        {
            return NotFound();
        }

        var image = await coverService.GetCoverAsync(folder, cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(image.Value.Bytes, image.Value.ContentType);
    }

    [HttpGet("thumbnail/{mangaId:int}")]
    public async Task<IActionResult> Thumbnail(int mangaId, CancellationToken cancellationToken)
    {
        var image = await suwayomi.GetThumbnailAsync(mangaId, cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(image.Value.Bytes, image.Value.ContentType);
    }

    private Guid GetUserId() =>
        HttpContext.User.Identity is ClaimsIdentity identity
        && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
            ? userId
            : Guid.Empty;

    private static string Normalize(string text) =>
        NonWord().Replace(text.ToLowerInvariant(), " ").Trim();

    // Word overlap, weighted so an exact title scores 1.
    private static double Similarity(string a, string b)
    {
        if (a.Length == 0 || b.Length == 0)
        {
            return 0;
        }

        if (a == b)
        {
            return 1;
        }

        var wordsA = a.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        var wordsB = b.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        var shared = wordsA.Count(wordsB.Contains);
        return 0.9 * shared / Math.Max(wordsA.Count, wordsB.Count);
    }

    [GeneratedRegex(@"[^\p{L}\p{N}]+")]
    private static partial Regex NonWord();
}
