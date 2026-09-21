using System;
using System.Security.Claims;
using Jellio.Services.IntroCredits;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Jellio's own real intro/credits detection, not a reskin of Intro
/// Skipper's own native /Episode/{id}/Timestamps or Media Segments
/// endpoints (runtime/api.js's own getIntroSkipperSegments already
/// reads both of those first, this is a real third tier underneath
/// them): IntroCreditsAnalyzer cross-references a season's own episodes
/// directly against the same resolved stream URL real playback already
/// uses, real feedback this whole file exists to answer was Intro
/// Skipper's own analysis never running at all against a real
/// .strm-backed remote library.
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

    // Fire and forget: screens/player.js's own real playback start
    // fires this the same non-blocking real way it already fires
    // Gelato's own prefetchStreams, no reason for a reader's own actual
    // Play tap to wait on a real background fingerprinting pass that
    // can take real minutes once ffmpeg itself is involved.
    [HttpPost("analyze/{itemId}")]
    public IActionResult Analyze(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        analyzer.QueueSeasonAnalysisForEpisode(itemId, userId);
        return Accepted();
    }

    // Real feedback asked for both a periodic sweep (IntroCreditsLibraryScanService's
    // own real timer already covers that) and a way to kick the exact
    // same real work off by hand rather than waiting on it - admin only,
    // the same real gate every other whole-library operation in native
    // Jellyfin already sits behind, this one included: IntroCreditsAnalyzer's
    // own real per-season dedup already makes a redundant real call here
    // (this endpoint hit twice, or hit while the timer's own real sweep
    // is still mid-run) a harmless no-op rather than a second real pass.
    [HttpPost("analyze-library")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult AnalyzeLibrary()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        // force: true - an explicit real click here should always get a
        // real fresh attempt, not silently do nothing because
        // MinReanalyzeGap already thinks every episode was tried
        // recently. IntroCreditsLibraryScanService's own periodic sweep
        // still respects that gap, this button is the one real way
        // around it.
        analyzer.QueueLibraryAnalysis(userId, force: true);
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
