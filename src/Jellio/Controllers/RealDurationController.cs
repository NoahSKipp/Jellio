using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/real-duration")]
[Authorize]
public class RealDurationController(RealDurationStore store, DurationProbeService probe, ILibraryManager libraryManager) : ControllerBase
{
    public record ReportRequest(Guid ItemId, long DurationTicks, bool Exact = false);

    public record ProbeRequest(Guid ItemId);

    // The length read from the playback source itself, for a title whose
    // converted stream can't report it.
    [HttpPost("probe")]
    public async Task<IActionResult> Probe([FromBody] ProbeRequest request, CancellationToken cancellationToken)
    {
        if (
            !User.TryGetJellyfinUserId(out var userId)
        )
        {
            return BadRequest("Invalid user session");
        }

        var item = libraryManager.GetItemById(request.ItemId);
        if (item is null)
        {
            return NotFound();
        }

        var ticks = await probe.ProbeAsync(item, userId, cancellationToken).ConfigureAwait(false);
        return ticks is null ? NoContent() : Ok(new { DurationTicks = ticks.Value });
    }

    [HttpPost]
    public IActionResult Report([FromBody] ReportRequest request)
    {
        if (request.ItemId == Guid.Empty || request.DurationTicks <= 0)
        {
            return BadRequest();
        }

        store.Set(request.ItemId, request.DurationTicks, request.Exact);
        return Ok();
    }

    [HttpGet]
    public ActionResult<Dictionary<string, long>> Get([FromQuery] string ids)
    {
        if (string.IsNullOrWhiteSpace(ids))
        {
            return Ok(new Dictionary<string, long>());
        }

        var itemIds = ids
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(id => Guid.TryParse(id, out var parsed) ? parsed : Guid.Empty)
            .Where(id => id != Guid.Empty);

        return Ok(store.GetMany(itemIds));
    }
}
