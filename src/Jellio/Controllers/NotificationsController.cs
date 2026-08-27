using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Claims;
using System.Text.Json;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
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
/// today), not again on every later request the same day. One plain
/// JSON array per user id, same real file-per-thing storage
/// NextUpHiddenController already uses under PluginConfigurationsPath
/// rather than a database this plugin has no other reason to carry.
/// Computed on request rather than a background loop, same real reason
/// CalendarController's own header already gives: a reader's own
/// client already polls this on a real interval (frontend/components/
/// notifications.js), nothing here needs to be warm ahead of that.
/// </summary>
[ApiController]
[Route("Jellio/notifications")]
[Authorize]
public class NotificationsController(
    IApplicationPaths applicationPaths,
    ILibraryManager libraryManager,
    IUserManager userManager,
    CalendarService calendarService
) : ControllerBase
{
    public record WatchlistNotification(
        string Id,
        Guid ItemId,
        string Name,
        string Type,
        DateTime Date,
        string Kind,
        string? Detail,
        DateTime CreatedUtc,
        bool Read
    );

    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "notifications");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    [HttpGet]
    public async Task<ActionResult<List<WatchlistNotification>>> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var notifications = Load(userId);

        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        var user = string.IsNullOrWhiteSpace(accessToken) ? null : userManager.GetUserById(userId);
        if (user != null)
        {
            var watchlist = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IsFavorite = true,
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            });

            var entries = await calendarService.GetWatchlistCalendarAsync(watchlist, accessToken!).ConfigureAwait(false);
            var today = DateTime.UtcNow.Date;
            var known = notifications.Select(n => n.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var changed = false;

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
                changed = true;
            }

            if (changed)
            {
                Save(userId, notifications);
            }
        }

        return Ok(notifications);
    }

    [HttpPost("read")]
    public IActionResult MarkRead()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var notifications = Load(userId);
        if (notifications.Any(n => !n.Read))
        {
            Save(userId, notifications.Select(n => n with { Read = true }).ToList());
        }

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

        var notifications = Load(userId);
        var remaining = notifications.Where(n => !string.Equals(n.Id, id, StringComparison.OrdinalIgnoreCase)).ToList();
        if (remaining.Count != notifications.Count)
        {
            Save(userId, remaining);
        }

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

        Save(userId, []);
        return Ok();
    }

    private List<WatchlistNotification> Load(Guid userId)
    {
        var path = StorePath(userId);
        if (!System.IO.File.Exists(path))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<WatchlistNotification>>(System.IO.File.ReadAllText(path)) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private void Save(Guid userId, List<WatchlistNotification> notifications)
    {
        Directory.CreateDirectory(StoreDirectory);
        System.IO.File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(notifications));
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
