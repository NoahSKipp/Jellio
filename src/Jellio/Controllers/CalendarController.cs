using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Real per user Watchlist (IsFavorite, the same real flag
/// runtime/api.js's own getWatchlistItems already reads through the
/// public Items API), scanned server side here for a real
/// ProviderIds.Tmdb on each real Movie/Series, then handed to
/// CalendarService's own real TMDB lookups. Computed on request rather
/// than a background loop: CalendarService's own in memory cache
/// already absorbs repeat lookups across users and page loads, a real
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
    public record CalendarItem(Guid ItemId, string Name, string Type, DateTime Date, string Kind, string? Detail);

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
            return Ok(Array.Empty<CalendarItem>());
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

        var results = new List<CalendarItem>();
        foreach (var item in watchlist)
        {
            // ProviderIds is a plain Dictionary<string, string> (real
            // shape confirmed against BaseItem.cs before writing this,
            // no GetProviderId/MetadataProvider helper actually exists
            // on this Jellyfin version to wrap it). "Tmdb" is the real
            // literal key GelatoManager itself writes, confirmed live
            // against a real sample of imported items rather than
            // assumed: ProviderIds.Imdb never once present, even on
            // mainstream titles.
            if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) || string.IsNullOrEmpty(tmdbId))
            {
                continue;
            }

            var entry = item is Movie
                ? await calendarService.GetMovieEntryAsync(tmdbId, accessToken).ConfigureAwait(false)
                : item is Series
                    ? await calendarService.GetSeriesEntryAsync(tmdbId, accessToken).ConfigureAwait(false)
                    : null;

            if (entry == null)
            {
                continue;
            }

            results.Add(new CalendarItem(item.Id, item.Name, item is Movie ? "Movie" : "Series", entry.Date, entry.Kind, entry.Detail));
        }

        return Ok(results.OrderBy(r => r.Date));
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
