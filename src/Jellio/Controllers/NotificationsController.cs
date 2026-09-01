using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Real per user watchlist release notifications: the same real
/// watchlist scan Controllers/CalendarController.cs already does
/// (CalendarService.GetWatchlistCalendarAsync, shared rather than a
/// second copy), generating one persisted notification the first real
/// day an entry's own release date actually arrives (Date.Date equals
/// today), not again on every later request the same day. Backed by
/// NotificationStore's own real per user JSON file.
/// Computed on request rather than a background loop, same real reason
/// CalendarController's own header already gives: a reader's own
/// client already polls this on a real interval (frontend/components/
/// notifications.js), nothing here needs to be warm ahead of that.
/// </summary>
[ApiController]
[Route("Jellio/notifications")]
[Authorize]
public class NotificationsController(
    NotificationStore store,
    ILibraryManager libraryManager,
    IUserManager userManager,
    CalendarService calendarService
) : ControllerBase
{
    public record BroadcastRequest(string? Message);

    private const int MaxAnnouncementLength = 300;

    [HttpGet]
    public async Task<ActionResult<List<WatchlistNotification>>> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        // The watchlist scan itself (an outbound TMDB call) stays outside
        // the store's own atomic Update below, same real reason the disk
        // stores elsewhere in this plugin never hold their own lock
        // across a real network call: only the real Load-mutate-Save
        // around notifications itself needs to be atomic, not whatever
        // produced the entries going into it.
        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        var user = string.IsNullOrWhiteSpace(accessToken) ? null : userManager.GetUserById(userId);
        List<WatchlistCalendarItem>? entries = null;
        if (user != null)
        {
            var watchlist = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IsFavorite = true,
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            });

            entries = await calendarService.GetWatchlistCalendarAsync(watchlist, accessToken!).ConfigureAwait(false);
        }

        var notifications = store.Update(userId, notifications =>
        {
            if (entries == null)
            {
                return;
            }

            var today = DateTime.UtcNow.Date;
            var known = notifications.Select(n => n.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in entries)
            {
                // Only the real day an entry's own date actually arrives,
                // never before (this reader has not missed anything yet)
                // and never after (CalendarService's own real PickDigitalRelease/
                // PickNextEpisode already drop anything already in the
                // past, so entries here are never anything but today or
                // still ahead).
                if (entry.Date.Date != today)
                {
                    continue;
                }

                var id = entry.ItemId + ":" + entry.Date.ToString("yyyy-MM-dd");
                if (!known.Add(id))
                {
                    continue;
                }

                notifications.Insert(
                    0,
                    new WatchlistNotification(
                        id,
                        entry.ItemId,
                        entry.Name,
                        entry.Type,
                        entry.Date,
                        entry.Kind,
                        entry.Detail,
                        DateTime.UtcNow,
                        false
                    )
                );
            }
        });

        return Ok(notifications);
    }

    // Real feedback asked for a way to announce restarts/maintenance to
    // every real user, delivered through this exact same real per user
    // store rather than a second one: Configuration/config.html's own
    // dashboard page is where this actually gets sent from (only an
    // admin can reach that real Jellyfin dashboard route at all), and
    // RequiresElevation below is the same real server side check every
    // other admin only endpoint across real Jellyfin/its plugins uses,
    // confirmed against real source before writing this, not trusting
    // the dashboard's own routing alone. ItemId is Guid.Empty (nothing
    // real to link to), Kind "announcement" is what frontend/components/
    // notifications.js's own messageFor/subtitleFor/openItem/buildRow
    // key off of to skip the poster art and the click-through a real
    // watchlist entry gets. No real time push of its own: this rides
    // that same file's own existing 5 minute poll, same real trade off
    // every other notification here already accepts rather than a new
    // timer just for this.
    [HttpPost("broadcast")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult Broadcast([FromBody] BroadcastRequest request)
    {
        var message = request.Message?.Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            return BadRequest("Message is required");
        }

        if (message.Length > MaxAnnouncementLength)
        {
            return BadRequest("Message is too long. Please keep it under " + MaxAnnouncementLength + " characters.");
        }

        var now = DateTime.UtcNow;
        foreach (var user in userManager.GetUsers())
        {
            store.Update(user.Id, notifications => notifications.Insert(
                0,
                new WatchlistNotification(
                    "announcement:" + Guid.NewGuid(),
                    Guid.Empty,
                    message,
                    "Announcement",
                    now,
                    "announcement",
                    null,
                    now,
                    false
                )
            ));
        }

        return Ok();
    }

    [HttpPost("read")]
    public IActionResult MarkRead()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Update(userId, notifications =>
        {
            for (var i = 0; i < notifications.Count; i++)
            {
                if (!notifications[i].Read)
                {
                    notifications[i] = notifications[i] with { Read = true };
                }
            }
        });

        return Ok();
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Update(userId, notifications =>
            notifications.RemoveAll(n => string.Equals(n.Id, id, StringComparison.OrdinalIgnoreCase)));

        return Ok();
    }

    [HttpDelete]
    public IActionResult Clear()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Save(userId, []);
        return Ok();
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
