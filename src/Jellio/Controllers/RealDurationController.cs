using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// RealDurationStore's own header explains the real gap this closes:
/// item.RunTimeTicks is Jellyfin's own metadata runtime, not whatever
/// Gelato actually resolved and streamed. screens/player.js's own real
/// &lt;video&gt;.duration (or, when that never resolves, its own real
/// positionSeconds once 'ended'/Up Next confirm a genuine full watch)
/// reports a known-good real duration here; runtime/api.js's own
/// getResumeItems then asks for whatever this plugin already knows
/// about the items it is about to render, no new field on Jellyfin's
/// own native response required.
/// </summary>
[ApiController]
[Route("Jellio/real-duration")]
[Authorize]
public class RealDurationController(RealDurationStore store) : ControllerBase
{
    public record ReportRequest(Guid ItemId, long DurationTicks);

    [HttpPost]
    public IActionResult Report([FromBody] ReportRequest request)
    {
        if (request.ItemId == Guid.Empty || request.DurationTicks <= 0)
        {
            return BadRequest();
        }

        store.Set(request.ItemId, request.DurationTicks);
        return Ok();
    }

    // Comma separated rather than one call per item: getResumeItems
    // above renders up to twenty cards at once, and this only ever
    // needs to run once for the whole row.
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
