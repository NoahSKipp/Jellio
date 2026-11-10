using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Extensions;
using Jellio.Services.Segments;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaSegments;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/segments")]
[Authorize]
public class SegmentsController(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSegmentManager mediaSegmentManager,
    IntroSkipperTimestamps introSkipper,
    ILogger<SegmentsController> logger) : ControllerBase
{
    public record SegmentDto(string Type, int StartMs, int EndMs);

    public record SegmentsResponse(IReadOnlyList<SegmentDto> Segments, string Source);

    // Skip segments for one item: Jellyfin's Media Segments, or the Intro
    // Skipper plugin's when those have no intro or outro.
    [HttpGet("{itemId}")]
    public async Task<ActionResult<SegmentsResponse>> Get(Guid itemId, CancellationToken cancellationToken)
    {
        if (!User.TryGetJellyfinUserId(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        var user = userManager.GetUserById(userId);
        var item = libraryManager.GetItemById(itemId);
        if (user is null || item is null || !item.IsVisible(user))
        {
            return NotFound();
        }

        IReadOnlyList<(MediaSegmentType Type, long StartTicks, long EndTicks)> native = [];
        try
        {
            var segments = await mediaSegmentManager.GetSegmentsAsync(item, null, libraryManager.GetLibraryOptions(item), true).ConfigureAwait(false);
            native = segments.Select(s => (s.Type, s.StartTicks, s.EndTicks)).ToList();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Jellio: Media Segments lookup failed for {ItemId}", itemId);
        }

        IReadOnlyList<NormalizedSegment> fromIntroSkipper = [];
        if (!SkipSegmentNormalizer.HasIntroOrOutro(native))
        {
            fromIntroSkipper = await introSkipper.GetAsync(itemId, Request, cancellationToken).ConfigureAwait(false);
        }

        var chosen = SkipSegmentNormalizer.Choose(native, fromIntroSkipper);
        return Ok(new SegmentsResponse(
            chosen.Segments.Select(s => new SegmentDto(s.Type, s.StartMs, s.EndMs)).ToList(),
            chosen.Source));
    }
}
