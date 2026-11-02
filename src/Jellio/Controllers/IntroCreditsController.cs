using System;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.CommunitySkip;
using Jellio.Services.IntroCredits;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/introcredits")]
[Authorize]
public class IntroCreditsController(
    IntroCreditsStore store,
    IntroCreditsBulkScanner bulkScanner,
    CommunitySkipProvider communitySkipProvider,
    ILibraryManager libraryManager) : ControllerBase
{
    public record SegmentRange(double Start, double End);

    public record SegmentsResponse(SegmentRange? Introduction, SegmentRange? Credits);

    [HttpGet("community/{itemId}")]
    public async Task<IActionResult> GetCommunity(Guid itemId, CancellationToken cancellationToken)
    {
        var item = libraryManager.GetItemById(itemId);
        var result = item switch
        {
            Episode episode => await communitySkipProvider.GetSkipIntervalsAsync(episode, cancellationToken).ConfigureAwait(false),
            MediaBrowser.Controller.Entities.Movies.Movie movie => await communitySkipProvider.GetSkipIntervalsForMovieAsync(movie, cancellationToken).ConfigureAwait(false),
            _ => null,
        };

        if (result is null)
        {
            return Ok(new SegmentsResponse(null, null));
        }

        var introduction = result.IntroductionStart is { } introStart && result.IntroductionEnd is { } introEnd && introEnd > introStart
            ? new SegmentRange(introStart, introEnd)
            : null;
        var credits = result.CreditsStart is { } creditsStart && result.CreditsEnd is { } creditsEnd && creditsEnd > creditsStart
            ? new SegmentRange(creditsStart, creditsEnd)
            : null;

        return Ok(new SegmentsResponse(introduction, credits));
    }

    [HttpGet("{itemId}")]
    public IActionResult Get(Guid itemId)
    {
        var record = store.Get(itemId);
        if (record is null)
        {
            return Ok(new SegmentsResponse(null, null));
        }

        var introduction = record.IntroEndTicks > 0
            ? new SegmentRange(TicksToSeconds(record.IntroStartTicks), TicksToSeconds(record.IntroEndTicks))
            : null;
        var credits = record.CreditsEndTicks > 0
            ? new SegmentRange(TicksToSeconds(record.CreditsStartTicks), TicksToSeconds(record.CreditsEndTicks))
            : null;

        return Ok(new SegmentsResponse(introduction, credits));
    }

    public record ScanResponse(int EpisodesScanned, int CommunityHits, int AnalyzerHits);

    [HttpPost("scan/{itemId}")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> Scan(Guid itemId, [FromQuery] bool useAnalyzerFallback)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var result = await bulkScanner.ScanAsync(itemId, useAnalyzerFallback, userId, CancellationToken.None).ConfigureAwait(false);
        return Ok(new ScanResponse(result.EpisodesScanned, result.CommunityHits, result.AnalyzerHits));
    }

    private static double TicksToSeconds(long ticks) => ticks / (double)TimeSpan.TicksPerSecond;

    private Guid GetUserId()
    {
        if (
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
