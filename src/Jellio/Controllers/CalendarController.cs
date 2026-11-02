using System;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/calendar")]
[Authorize]
public class CalendarController(
    IUserManager userManager,
    CalendarService calendarService,
    UpcomingHiddenStore upcomingHidden
) : ControllerBase
{
    // Remove from Upcoming on a card; DELETE puts it back.
    [HttpPost("hidden/{itemId:guid}")]
    public IActionResult Hide(Guid itemId) => SetHidden(itemId, hide: true);

    [HttpDelete("hidden/{itemId:guid}")]
    public IActionResult Unhide(Guid itemId) => SetHidden(itemId, hide: false);

    private IActionResult SetHidden(Guid itemId, bool hide)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (hide)
        {
            upcomingHidden.Hide(userId, itemId);
        }
        else
        {
            upcomingHidden.Unhide(userId, itemId);
        }

        calendarService.ForgetMonitored(userId);
        return NoContent();
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return Ok(Array.Empty<WatchlistCalendarItem>());
        }

        var user = userManager.GetUserById(userId);
        if (user == null)
        {
            return BadRequest("Invalid user session");
        }

        var monitored = calendarService.GetMonitoredItems(user);
        var results = await calendarService.GetWatchlistCalendarAsync(monitored, accessToken).ConfigureAwait(false);
        return Ok(results);
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
}
