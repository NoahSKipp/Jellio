using System;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.IntroCredits;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Jellio's own real intro/credits detection, not a reskin of Intro
/// Skipper's own native /Episode/{id}/Timestamps or Media Segments
/// endpoints (runtime/api.js's own getIntroSkipperSegments already
/// reads both of those first, this is a real third tier underneath
/// them): IntroCreditsAnalyzer cross-references a small forward-looking
/// batch of a season's own episodes directly against the same resolved
/// stream URL real playback already uses. Real feedback this whole file
/// exists to answer was Intro Skipper's own analysis never running at
/// all against a real .strm-backed remote library; real feedback again,
/// later, was that Gelato's own resolution only works from inside a
/// real request like this controller's own POST already is, not from a
/// detached background job (IntroCreditsAnalyzer's own header explains
/// why), which is why this stays a real request-scoped batch rather
/// than a whole-library sweep.
/// </summary>
[ApiController]
[Route("Jellio/introcredits")]
[Authorize]
public class IntroCreditsController(IntroCreditsStore store, IntroCreditsAnalyzer analyzer) : ControllerBase
{
    public record SegmentRange(double Start, double End);

    public record SegmentsResponse(SegmentRange? Introduction, SegmentRange? Credits);

    // screens/player.js's own real getIntroSkipperSegments chain reads
    // this last, after both Intro Skipper's own real lookups and the
    // embedded chapter name fallback come back empty: this file's own
    // real analyzer only ever has something to say once at least one
    // other episode of the exact same season has already been
    // fingerprinted, not the first time a season is ever opened at all.
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

    // Awaited, not fired and forgotten: Gelato's own real resolution
    // gate (IntroCreditsAnalyzer's own header explains it) only works
    // from inside a real request this controller action already is,
    // exiting early would hand the rest of the work a real HttpContext
    // that no longer exists. Still never something a reader's own real
    // Play tap waits on: screens/player.js's own real caller fires this
    // with a generous client side timeout and ignores whatever comes
    // back, same non-blocking real shape prefetchStreams already uses,
    // just a real request this server side keeps running to completion
    // regardless of how long the client itself keeps listening.
    [HttpPost("analyze/{itemId}")]
    public async Task<IActionResult> Analyze(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        // CancellationToken.None on purpose, not HttpContext.RequestAborted:
        // screens/player.js's own real caller does not wait on this
        // response at all, so the underlying connection can look
        // "aborted" long before this real batch is actually done: tying
        // this to that same real token would cut a real still-useful
        // analysis short over a real client that was never going to read
        // the result anyway.
        await analyzer.AnalyzeBatchAsync(itemId, userId, CancellationToken.None);
        return Accepted();
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
