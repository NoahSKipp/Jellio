using System;
using System.Security.Claims;
using Jellio.Services.Downloads;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Limits how many offline downloads are converted on the server at once
/// (ConversionSlotService), and says whether it can encode HEVC without
/// falling back to the CPU, so the apps ask for a smaller file only when
/// that is quick.
/// </summary>
[ApiController]
[Route("Jellio/downloads/conversions")]
[Authorize]
public class DownloadConversionsController(ConversionSlotService slots, IServerConfigurationManager configurationManager) : ControllerBase
{
    public record ClaimBody(Guid ItemId);

    [HttpGet]
    public IActionResult GetStatus()
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        var status = slots.GetStatus(userId);
        return Ok(new { status.Active, status.Max, status.Yours, status.Available, HevcEncoding = HevcEncodingIsFast() });
    }

    [HttpPost]
    public IActionResult Claim([FromBody] ClaimBody body)
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        var (slotId, status) = slots.TryClaim(userId, body.ItemId);
        if (slotId is null)
        {
            return StatusCode(
                StatusCodes.Status429TooManyRequests,
                new
                {
                    status.Active,
                    status.Max,
                    Message = BusyMessage(status.Max),
                });
        }

        return Ok(new { SlotId = slotId, status.Active, status.Max });
    }

    [HttpPost("{slotId}/heartbeat")]
    public IActionResult Heartbeat([FromRoute] string slotId)
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        return slots.Heartbeat(slotId, userId) ? NoContent() : NotFound();
    }

    [HttpDelete("{slotId}")]
    public IActionResult Release([FromRoute] string slotId)
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        slots.Release(slotId, userId);
        return NoContent();
    }

    public static string BusyMessage(int max) =>
        "The server is already converting " + max + " downloads for other people. Try again in a few minutes, or choose Original file.";

    // HEVC encoding on the CPU is far slower than H.264, so only when
    // Jellyfin is set to encode it in hardware.
    private bool HevcEncodingIsFast()
    {
        var options = configurationManager.GetEncodingOptions();
        return options.AllowHevcEncoding
            && options.EnableHardwareEncoding
            && options.HardwareAccelerationType != HardwareAccelerationType.none;
    }

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }
}
