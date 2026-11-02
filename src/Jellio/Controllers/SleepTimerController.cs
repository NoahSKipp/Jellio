using System.Security.Claims;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

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
            User.TryGetJellyfinUserId(out var userId)
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
