using System;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellio.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

using Jellio.Services.Reading;

namespace Jellio.Controllers;

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

        var accessToken = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        var user = string.IsNullOrWhiteSpace(accessToken) ? null : userManager.GetUserById(userId);
        List<WatchlistCalendarItem>? entries = null;
        if (user != null)
        {
            var monitored = calendarService.GetMonitoredItems(user);
            entries = await calendarService.GetWatchlistCalendarAsync(monitored, accessToken!).ConfigureAwait(false);
        }

        var shelfData = entries == null ? null : shelfStore.Load(userId);
        var notifications = store.UpdateIfChanged(userId, notifications =>
        {
            if (entries == null)
            {
                return false;
            }

            var added = false;

            var today = DateTime.UtcNow.Date;
            var known = notifications.Select(n => n.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var entry in entries)
            {
                if (entry.Date.Date != today)
                {
                    continue;
                }

                // Check if user has muted notifications (SkipUpdates) for this show or movie
                var itemKey = entry.ItemId.ToString("N").ToLowerInvariant();
                if (shelfData!.Series.TryGetValue("s:" + itemKey, out var prefs) ||
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
                added = true;
            }

            return added;
        });

        return Ok(notifications);
    }

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
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
