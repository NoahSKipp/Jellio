using System;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
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

using Jellio.Services.Reading;

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
public partial class NotificationsController(
    NotificationStore store,
    IUserManager userManager,
    CalendarService calendarService,
    ShelfStore shelfStore,
    MediaBrowser.Common.Configuration.IApplicationPaths applicationPaths
) : ControllerBase
{
    // UserId: one reader to send it to; left out, every reader gets it.
    // Image: an optional picture as a data URL or plain base64.
    public record BroadcastRequest(string? Message, Guid? UserId = null, string? Image = null);

    // A picture is shrunk to fit this box before it's stored, so a phone
    // photo doesn't arrive full size in every toast.
    private const int AnnouncementImageMaxDimension = 800;
    private const int AnnouncementImageMaxBytes = 10 * 1024 * 1024;
    private const int AnnouncementImageMaxDecode = 12000;

    private string AnnouncementImageDirectory =>
        System.IO.Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "announcements");

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
            var monitored = calendarService.GetMonitoredItems(user);
            entries = await calendarService.GetWatchlistCalendarAsync(monitored, accessToken!).ConfigureAwait(false);
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

                // Check if user has muted notifications (SkipUpdates) for this show or movie
                var itemKey = entry.ItemId.ToString("N").ToLowerInvariant();
                var shelfData = shelfStore.Load(userId);
                if (shelfData.Series.TryGetValue("s:" + itemKey, out var prefs) ||
                    shelfData.Series.TryGetValue(itemKey, out prefs) ||
                    shelfData.Series.TryGetValue(entry.ItemId.ToString(), out prefs))
                {
                    if (prefs.SkipUpdates == true)
                    {
                        continue;
                    }
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
        var message = request.Message?.Trim() ?? string.Empty;
        var hasImage = !string.IsNullOrWhiteSpace(request.Image);
        if (string.IsNullOrWhiteSpace(message) && !hasImage)
        {
            return BadRequest("Message is required");
        }

        string? imageId = null;
        if (hasImage)
        {
            var saved = SaveAnnouncementImage(request.Image!);
            if (saved.Error is not null)
            {
                return BadRequest(saved.Error);
            }

            imageId = saved.ImageId;
        }

        if (message.Length > MaxAnnouncementLength)
        {
            return BadRequest("Message is too long. Please keep it under " + MaxAnnouncementLength + " characters.");
        }

        var recipients = userManager.GetUsers().ToList();
        if (request.UserId is { } targetId && targetId != Guid.Empty)
        {
            recipients = recipients.Where(user => user.Id == targetId).ToList();
            if (recipients.Count == 0)
            {
                return NotFound("That user no longer exists");
            }
        }

        var now = DateTime.UtcNow;
        foreach (var user in recipients)
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
                    false,
                    ImageId: imageId
                )
            ));
        }

        return Ok();
    }

    [HttpGet("image/{imageId}")]
    public IActionResult AnnouncementImage([FromRoute] string imageId)
    {
        if (!AnnouncementImageName().IsMatch(imageId ?? string.Empty))
        {
            return NotFound();
        }

        var path = System.IO.Path.Combine(AnnouncementImageDirectory, imageId!);
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=604800";
        var contentType = imageId!.EndsWith(".png", StringComparison.Ordinal)
            ? "image/png"
            : imageId.EndsWith(".gif", StringComparison.Ordinal) ? "image/gif" : "image/jpeg";
        return PhysicalFile(path, contentType);
    }

    // Decodes, shrinks to fit AnnouncementImageMaxDimension and stores the
    // picture as JPEG (PNG when it has transparency to keep).
    private (string? ImageId, string? Error) SaveAnnouncementImage(string data)
    {
        var comma = data.IndexOf(',', StringComparison.Ordinal);
        var base64 = data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma > 0 ? data[(comma + 1)..] : data;
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64.Trim());
        }
        catch (FormatException)
        {
            return (null, "The image couldn't be read.");
        }

        if (bytes.Length > AnnouncementImageMaxBytes)
        {
            return (null, "Image too large. Please use one under 10 MB.");
        }

        try
        {
            using (var identifyStream = new System.IO.MemoryStream(bytes))
            {
                var info = SixLabors.ImageSharp.Image.Identify(identifyStream);
                if (info is null || info.Width > AnnouncementImageMaxDecode || info.Height > AnnouncementImageMaxDecode)
                {
                    return (null, "That image's dimensions are too large.");
                }
            }

            // A GIF is kept as sent so it still animates; resizing would
            // keep only its first frame.
            if (bytes.Length > 6 && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F')
            {
                System.IO.Directory.CreateDirectory(AnnouncementImageDirectory);
                var gifName = Guid.NewGuid().ToString("N") + ".gif";
                System.IO.File.WriteAllBytes(System.IO.Path.Combine(AnnouncementImageDirectory, gifName), bytes);
                return (gifName, null);
            }

            using var image = SixLabors.ImageSharp.Image.Load<SixLabors.ImageSharp.PixelFormats.Rgba32>(bytes);
            if (image.Width > AnnouncementImageMaxDimension || image.Height > AnnouncementImageMaxDimension)
            {
                image.Mutate(x => x.Resize(new SixLabors.ImageSharp.Processing.ResizeOptions
                {
                    Mode = SixLabors.ImageSharp.Processing.ResizeMode.Max,
                    Size = new SixLabors.ImageSharp.Size(AnnouncementImageMaxDimension, AnnouncementImageMaxDimension),
                }));
            }

            var transparent = false;
            image.ProcessPixelRows(rows =>
            {
                for (var y = 0; y < rows.Height && !transparent; y++)
                {
                    foreach (var pixel in rows.GetRowSpan(y))
                    {
                        if (pixel.A < 255)
                        {
                            transparent = true;
                            break;
                        }
                    }
                }
            });

            System.IO.Directory.CreateDirectory(AnnouncementImageDirectory);
            var name = Guid.NewGuid().ToString("N") + (transparent ? ".png" : ".jpg");
            var path = System.IO.Path.Combine(AnnouncementImageDirectory, name);
            if (transparent)
            {
                image.Save(path, new SixLabors.ImageSharp.Formats.Png.PngEncoder());
            }
            else
            {
                image.Save(path, new SixLabors.ImageSharp.Formats.Jpeg.JpegEncoder { Quality = 85 });
            }

            return (name, null);
        }
        catch (SixLabors.ImageSharp.ImageFormatException)
        {
            return (null, "That file isn't an image Jellio can read (JPEG, PNG, GIF or WebP).");
        }
    }

    [System.Text.RegularExpressions.GeneratedRegex("^[a-f0-9]{32}\\.(jpg|png|gif)$")]
    private static partial System.Text.RegularExpressions.Regex AnnouncementImageName();

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
