using System;
using System.Threading.Tasks;
using System.Security.Claims;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Real per user Watchlist (IsFavorite, the same real flag
/// runtime/api.js's own getWatchlistItems already reads through the
/// public Items API), scanned server side here for a real
/// ProviderIds.Tmdb on each real Movie/Series, then handed to
/// CalendarService's own real TMDB lookups (GetWatchlistCalendarAsync,
/// shared with Controllers/NotificationsController.cs's own identical
/// real scan rather than duplicated). Computed on request rather than
/// a background loop: CalendarService's own in memory cache already
/// absorbs repeat lookups across users and page loads, a real
/// scheduled task would only ever be warming a cache nothing here
/// needs warm ahead of time for a install at this real scale.
/// </summary>
[ApiController]
[Route("Jellio/calendar")]
[Authorize]
public class CalendarController(
    ILibraryManager libraryManager,
    IUserManager userManager,
    CalendarService calendarService
) : ControllerBase
{
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

        var watchlist = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IsFavorite = true,
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
        });

        var results = await calendarService.GetWatchlistCalendarAsync(watchlist, accessToken).ConfigureAwait(false);
        return Ok(results);
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
}
