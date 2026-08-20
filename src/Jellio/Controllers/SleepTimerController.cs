using System.Security.Claims;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Starts, cancels and reports a per user/device duration sleep timer,
/// backed by SleepTimerService's background loop. User id is read from
/// the real "Jellyfin-UserId" claim every authenticated request already
/// carries (confirmed against jellyfin-plugin-jellysleep's own
/// JellysleepController.cs, which reads the same claim the same way, and
/// against the server's own Jellyfin.Api.Constants.InternalClaimTypes.UserId,
/// not guessed).
/// </summary>
[ApiController]
[Route("Jellio/sleep-timer")]
[Authorize]
public class SleepTimerController(SleepTimerService sleepTimerService) : ControllerBase
{
    public record StartRequest(int Minutes);

    [HttpPost("start")]
    public IActionResult Start([FromBody] StartRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (request.Minutes is < 1 or > 480)
        {
            return BadRequest("Minutes must be between 1 and 480");
        }

        var status = sleepTimerService.Start(userId, GetDeviceId(), request.Minutes);
        return Ok(status);
    }

    [HttpPost("cancel")]
    public IActionResult Cancel()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var cancelled = sleepTimerService.Cancel(userId, GetDeviceId());
        return cancelled ? Ok() : NotFound();
    }

    [HttpGet("status")]
    public IActionResult Status()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(sleepTimerService.GetStatus(userId, GetDeviceId()));
    }

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

    private string? GetDeviceId()
    {
        return (HttpContext.User.Identity as ClaimsIdentity)?.FindFirst("Jellyfin-DeviceId")?.Value;
    }
}
