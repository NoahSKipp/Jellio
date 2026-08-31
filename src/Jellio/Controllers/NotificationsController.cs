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

    public record BroadcastRequest(string? Message);

    private const int MaxAnnouncementLength = 300;

    // Real bug, audit-found: this list never got pruned at all, a
    // watchlist release notification added once per item per real day
    // and an admin broadcast appended into every real user's own file
    // forever. Same real cap AchievementService.MaxRecentActivity
    // already uses for the identical real "keep a real backlog, not an
    // unbounded one" reason. Newest first (index 0), so trimming the
    // tail below drops the real oldest entries, never the ones a
    // reader has not looked at yet.
    private const int MaxStoredNotifications = 100;

    // Real bug, audit-found: every one of Get()/Broadcast()/MarkRead()/
    // Delete() below did its own real Load then Save with real time
    // between them for another request to land in, the same real
    // lost-update shape ProfileSettingsStore.cs's own header now
    // explains for the identical reason. Static, not an instance field,
    // for the same real reason NextUpHiddenController.cs's own lock
    // already is: a fresh controller instance per real request.
    private static readonly object Lock = new();

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

        // The watchlist scan itself (an outbound TMDB call) stays outside
        // the lock below, same real reason the disk stores elsewhere in
        // this plugin never hold their own lock across a real network
        // call: only the real Load-mutate-Save around notifications
        // itself needs to be atomic, not whatever produced the entries
        // going into it.
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

        lock (Lock)
        {
            var notifications = Load(userId);

            if (entries != null)
            {
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
                    TrimToLimit(notifications);
                    Save(userId, notifications);
                }
            }

            return Ok(notifications);
        }
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
        lock (Lock)
        {
            foreach (var user in userManager.GetUsers())
            {
                var notifications = Load(user.Id);
                notifications.Insert(
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
                );
                TrimToLimit(notifications);
                Save(user.Id, notifications);
            }
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

        lock (Lock)
        {
            var notifications = Load(userId);
            if (notifications.Any(n => !n.Read))
            {
                Save(userId, notifications.Select(n => n with { Read = true }).ToList());
            }
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

        lock (Lock)
        {
            var notifications = Load(userId);
            var remaining = notifications.Where(n => !string.Equals(n.Id, id, StringComparison.OrdinalIgnoreCase)).ToList();
            if (remaining.Count != notifications.Count)
            {
                Save(userId, remaining);
            }
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

        lock (Lock)
        {
            Save(userId, []);
        }

        return Ok();
    }

    private static void TrimToLimit(List<WatchlistNotification> notifications)
    {
        if (notifications.Count > MaxStoredNotifications)
        {
            notifications.RemoveRange(MaxStoredNotifications, notifications.Count - MaxStoredNotifications);
        }
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
