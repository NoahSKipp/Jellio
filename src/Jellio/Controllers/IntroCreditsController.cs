using System;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.CommunitySkip;
using Jellio.Services.IntroCredits;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Jellio's own real Skip Intro/Credits detection, two real tiers deep.
/// screens/player.js's own getIntroSkipperSegments chain now tries this
/// controller's own GET .../community/{itemId} first (Services/CommunitySkip,
/// the same real community-database approach a real open source
/// reference, NuvioTV, already ships - no stream or ffmpeg access at
/// all, general TV/movie coverage from TheIntroDB plus anime specific
/// coverage from AniSkip/Anime-Skip), before ever falling back to Intro
/// Skipper's own native/legacy lookups, embedded chapter names, or this
/// file's own GET .../{itemId} (Services/IntroCredits, this plugin's own
/// cross-episode audio analyzer): real feedback was explicit that this
/// plugin's own analysis should only ever be a real last resort once
/// every other real signal has already come back empty, and should
/// never run automatically at a real cost to a reader's own debrid
/// quota - see POST .../scan/{itemId} below for the one real, deliberate
/// way it still runs at all.
/// </summary>
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

    // Tried first, screens/player.js's own real getIntroSkipperSegments
    // chain reads this before Intro Skipper's own real lookups, the
    // embedded chapter name fallback, or this file's own GET
    // .../{itemId} below: a real community database lookup needs no
    // stream, no ffmpeg, and answers the same real instant a season is
    // opened for the very first time, unlike every other real tier this
    // plugin has.
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

    // The real last resort: this plugin's own cross-episode audio
    // analyzer, only ever has something to say once an admin has
    // explicitly run POST .../scan/{itemId} below against this item's
    // own season/show and the community tier itself came back short.
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

    // The one real explicit trigger left for this plugin's own
    // chromaprint analyzer - components/cardOptionsMenu.js's own real
    // admin-only "Find Skip Intro/Credits" right-click action, a Movie
    // or a whole Series (every season) at once. Awaited, not fired and
    // forgotten: Gelato's own real resolution gate (IntroCreditsAnalyzer's
    // own header explains it) only works from inside a real request this
    // controller action already is, exiting early would hand the rest of
    // the work a real HttpContext that no longer exists. A full series
    // can genuinely take minutes (Services/CommunitySkip's own free tier
    // first, this plugin's own debrid-backed fallback only for whatever
    // it leaves uncovered), so runtime/api.js's own real caller fires
    // this with a generous client side timeout and does not block on the
    // response body, same non-blocking real shape prefetchStreams already
    // uses - this server side keeps running to completion regardless of
    // how long the client itself keeps listening.
    [HttpPost("scan/{itemId}")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> Scan(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        // CancellationToken.None on purpose, not HttpContext.RequestAborted:
        // see this method's own header for why a real client disconnect
        // (or a generous but still finite client side timeout) should
        // never cut a real still-running scan short.
        var result = await bulkScanner.ScanAsync(itemId, userId, CancellationToken.None).ConfigureAwait(false);
        return Ok(new ScanResponse(result.EpisodesScanned, result.CommunityHits, result.AnalyzerHits));
    }

    private static double TicksToSeconds(long ticks) => ticks / (double)TimeSpan.TicksPerSecond;

    private Guid GetUserId()
    {
        if (
            HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
