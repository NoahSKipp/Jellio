using System;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.ScrubPreview;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Seek bar hover thumbnails for titles without Jellyfin trickplay
/// (ScrubPreviewService). One JPEG per ScrubPreviewService.BucketSeconds.
/// </summary>
[ApiController]
[Route("Jellio/scrub-preview")]
[Authorize]
public class ScrubPreviewController(ScrubPreviewService previews, ILibraryManager libraryManager) : ControllerBase
{
    [HttpGet("{itemId}/{seconds}.jpg")]
    public async Task<IActionResult> Get([FromRoute] Guid itemId, [FromRoute] int seconds, [FromQuery] string? mediaSourceId, CancellationToken cancellationToken)
    {
        if (
            HttpContext.User.Identity is not ClaimsIdentity identity
            || !Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
        )
        {
            return BadRequest("Invalid user session");
        }

        var item = libraryManager.GetItemById(itemId);
        if (item is null || seconds < 0)
        {
            return NotFound();
        }

        var frame = await previews.GetFrameAsync(item, userId, mediaSourceId, seconds, cancellationToken).ConfigureAwait(false);
        if (frame is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(frame, "image/jpeg");
    }
}
