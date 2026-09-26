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
public partial class MangaRequestController(SuwayomiClient suwayomi, IUserManager userManager, ILogger<MangaRequestController> logger) : ControllerBase
{
    private const int MaxSources = 16;
    private const int ResultsPerSource = 6;
    private static readonly TimeSpan SearchBudget = TimeSpan.FromSeconds(25);

    public record SourceResult(long SourceId, string SourceName, string Lang, IReadOnlyList<MangaResult> Results);

    public record MangaResult(int MangaId, string Title, string? Author, string? Status, bool InLibrary, string ThumbnailUrl, double Match);

    public record RequestBody(int MangaId, string? Title);

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
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(SearchBudget);
        using var throttle = new SemaphoreSlim(4);
        var searches = sources.Take(MaxSources).Select(async source =>
        {
            await throttle.WaitAsync(budget.Token).ConfigureAwait(false);
            try
            {
                var found = await suwayomi.SearchAsync(source.Id, query, budget.Token).ConfigureAwait(false) ?? [];
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

        return Ok(searches
            .Where(search => search.IsCompletedSuccessfully && search.Result.Results.Count > 0)
            .Select(search => search.Result)
            .OrderByDescending(source => source.Results[0].Match)
            .ThenBy(source => source.SourceName, StringComparer.OrdinalIgnoreCase));
    }

    [HttpPost("request")]
    public async Task<IActionResult> RequestSeries([FromBody] RequestBody body, CancellationToken cancellationToken)
    {
        if (body is null || body.MangaId <= 0)
        {
            return BadRequest("MangaId is required");
        }

        var result = await suwayomi.AddAndDownloadAsync(body.MangaId, cancellationToken).ConfigureAwait(false);
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
