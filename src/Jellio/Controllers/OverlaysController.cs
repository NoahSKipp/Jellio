using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Claims;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;

namespace Jellio.Controllers;

/// <summary>
/// Screen overlays an admin sends from the dashboard: a picture or a line
/// of text laid over the middle of a reader's screen at a chosen opacity
/// for a chosen number of seconds, then gone. Nothing is kept in their
/// notifications. Pending overlays live in memory and expire quickly,
/// the same way SoundsController's sounds do.
/// </summary>
[ApiController]
[Route("Jellio/overlays")]
[Authorize]
public partial class OverlaysController(IUserManager userManager, IApplicationPaths applicationPaths) : ControllerBase
{
    public record SendOverlayRequest(string? Text, string? Image, Guid? UserId = null, int Opacity = 80, int Seconds = 5);

    public record PendingOverlay(long Seq, string? Text, string? ImageId, int Opacity, int Seconds, DateTime SentAt);

    private const int MaxImageBytes = 10 * 1024 * 1024;
    private const int MaxImageDimension = 1600;
    private const int MaxImageDecode = 12000;
    private const int MaxTextLength = 200;
    private static readonly TimeSpan PendingLifetime = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan FileLifetime = TimeSpan.FromDays(1);

    private static readonly object Lock = new();
    private static readonly Dictionary<Guid, List<PendingOverlay>> Pending = new();
    private static long _seq;

    private string ImageDirectory => Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "overlays");

    [HttpPost]
    [Authorize(Policy = "RequiresElevation")]
    [RequestSizeLimit(MaxImageBytes * 4 / 3 + 8192)]
    public IActionResult Send([FromBody] SendOverlayRequest request)
    {
        var text = (request.Text ?? string.Empty).Trim();
        var hasImage = !string.IsNullOrWhiteSpace(request.Image);
        if (text.Length == 0 && !hasImage)
        {
            return BadRequest("Enter some text or choose an image.");
        }

        if (text.Length > MaxTextLength)
        {
            return BadRequest("Text is too long. Please keep it under " + MaxTextLength + " characters.");
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

        string? imageId = null;
        if (hasImage)
        {
            var saved = SaveImage(request.Image!);
            if (saved.Error is not null)
            {
                return BadRequest(saved.Error);
            }

            imageId = saved.ImageId;
        }

        var opacity = Math.Clamp(request.Opacity, 5, 100);
        var seconds = Math.Clamp(request.Seconds, 1, 60);
        var now = DateTime.UtcNow;
        lock (Lock)
        {
            foreach (var user in recipients)
            {
                if (!Pending.TryGetValue(user.Id, out var list))
                {
                    list = [];
                    Pending[user.Id] = list;
                }

                list.RemoveAll(overlay => now - overlay.SentAt > PendingLifetime);
                list.Add(new PendingOverlay(++_seq, text.Length > 0 ? text : null, imageId, opacity, seconds, now));
            }
        }

        return Ok();
    }

    // after < 0 is a client's first poll: it learns the current Seq
    // without showing anything sent before it was open.
    [HttpGet("pending")]
    public IActionResult GetPending([FromQuery] long after = -1)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var now = DateTime.UtcNow;
        lock (Lock)
        {
            if (after < 0 || !Pending.TryGetValue(userId, out var list))
            {
                return Ok(new { Latest = _seq, Overlays = Array.Empty<PendingOverlay>() });
            }

            list.RemoveAll(overlay => now - overlay.SentAt > PendingLifetime);
            return Ok(new { Latest = _seq, Overlays = list.Where(overlay => overlay.Seq > after).ToList() });
        }
    }

    [HttpGet("image/{imageId}")]
    public IActionResult GetImage([FromRoute] string imageId)
    {
        var match = ImageName().Match(imageId ?? string.Empty);
        if (!match.Success)
        {
            return NotFound();
        }

        var path = Path.Combine(ImageDirectory, imageId!);
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        var contentType = match.Groups[1].Value switch
        {
            "png" => "image/png",
            "gif" => "image/gif",
            _ => "image/jpeg",
        };
        Response.Headers.CacheControl = "private, max-age=86400";
        return PhysicalFile(path, contentType);
    }

    // A GIF is kept as sent so it still animates; anything else is
    // shrunk to fit MaxImageDimension and stored as JPEG, or PNG when
    // it has transparency to keep.
    private (string? ImageId, string? Error) SaveImage(string data)
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

        if (bytes.Length > MaxImageBytes)
        {
            return (null, "Image too large. Please use one under 10 MB.");
        }

        try
        {
            using (var identifyStream = new MemoryStream(bytes))
            {
                var info = SixLabors.ImageSharp.Image.Identify(identifyStream);
                if (info is null || info.Width > MaxImageDecode || info.Height > MaxImageDecode)
                {
                    return (null, "That image's dimensions are too large.");
                }
            }

            Directory.CreateDirectory(ImageDirectory);
            CleanUpOldFiles();
            var isGif = bytes.Length > 6 && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F';
            if (isGif)
            {
                var gifName = Guid.NewGuid().ToString("N") + ".gif";
                System.IO.File.WriteAllBytes(Path.Combine(ImageDirectory, gifName), bytes);
                return (gifName, null);
            }

            using var image = SixLabors.ImageSharp.Image.Load<SixLabors.ImageSharp.PixelFormats.Rgba32>(bytes);
            if (image.Width > MaxImageDimension || image.Height > MaxImageDimension)
            {
                image.Mutate(x => x.Resize(new ResizeOptions
                {
                    Mode = ResizeMode.Max,
                    Size = new Size(MaxImageDimension, MaxImageDimension),
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

            var name = Guid.NewGuid().ToString("N") + (transparent ? ".png" : ".jpg");
            var path = Path.Combine(ImageDirectory, name);
            if (transparent)
            {
                image.Save(path, new SixLabors.ImageSharp.Formats.Png.PngEncoder());
            }
            else
            {
                image.Save(path, new SixLabors.ImageSharp.Formats.Jpeg.JpegEncoder { Quality = 88 });
            }

            return (name, null);
        }
        catch (SixLabors.ImageSharp.ImageFormatException)
        {
            return (null, "That file isn't an image Jellio can read (JPEG, PNG, GIF or WebP).");
        }
    }

    private void CleanUpOldFiles()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(ImageDirectory))
            {
                if (DateTime.UtcNow - System.IO.File.GetLastWriteTimeUtc(file) > FileLifetime)
                {
                    System.IO.File.Delete(file);
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
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

    [System.Text.RegularExpressions.GeneratedRegex("^[a-f0-9]{32}\\.(jpg|png|gif)$")]
    private static partial System.Text.RegularExpressions.Regex ImageName();
}
