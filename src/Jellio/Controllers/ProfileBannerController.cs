using System;
using System.IO;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Jellio.Controllers;

/// <summary>
/// A user's own banner has no real native Jellyfin image slot the way
/// the profile picture does (UserDto carries exactly one, Primary,
/// already spoken for), so this is its own plugin-owned file, one per
/// user id under PluginConfigurationsPath, same shape everything else
/// here already uses. Upload mirrors real Jellyfin's own POST
/// /Users/{id}/Images/Primary body convention exactly (confirmed
/// against Jellyfin.Api's own ImageController.PostUserImage before
/// writing this: base64 text as the literal request body, Content-Type
/// naming the real image mime type) so runtime/api.js's own existing
/// uploadUserAvatarBlob helper works unchanged against this endpoint
/// too, just pointed at a different path.
/// </summary>
[ApiController]
[Route("Jellio/profile/banner")]
[Authorize]
public class ProfileBannerController(IApplicationPaths applicationPaths) : ControllerBase
{
    private static readonly (string ContentType, string Extension)[] AllowedTypes =
    [
        ("image/jpeg", ".jpg"),
        ("image/png", ".png"),
        ("image/webp", ".webp"),
    ];

    // Real feedback, live, twice over: an unresized banner (this
    // endpoint never downsized anything server side, unlike every
    // other real image path in this app, which all ask for a specific
    // max width) meant a reader's own full resolution photo shipped
    // straight back out on every profile visit, real "scrolling is
    // painfully slow" the actual symptom of a multi megapixel bitmap
    // sitting in this page's own render tree. A byte size cap alone
    // (this file's own earlier real fix) does not actually catch this:
    // a real phone photo can sit well under MaxUploadBytes while still
    // carrying four or more real megapixels, exactly the live report
    // that came back after a same-file re-upload passed the cap and
    // still lagged just as bad. MaxDimension below is the real fix,
    // Jellio.csproj's own header explains why SixLabors.ImageSharp is
    // safe to reach for here now.
    private const long MaxUploadBytes = 8 * 1024 * 1024;

    // 16:4.2 is this banner's own real aspect ratio (css/app.css), so
    // the short edge is already well under this regardless of which
    // edge trips it; a real ultra wide 4K viewport is the one
    // legitimate case that actually renders anywhere near this many
    // real CSS pixels wide, everything smaller downscales for free.
    // Never upscales a smaller original: the check below only ever
    // resizes down.
    private const int MaxDimension = 2400;

    private string BannerDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "banners");

    // Public: a banner is meant to be visible on a profile the same way
    // the profile picture is, Privacy toggle or not, real Steam-style
    // behaviour requested. No 404 special-casing needed beyond the
    // plain 404 below, screens/profile.js's own real fallback (a plain
    // gradient) is a client side concern, not this endpoint's.
    [HttpGet("{userId:guid}")]
    public IActionResult Get(Guid userId)
    {
        var match = AllowedTypes
            .Select(t => Path.Combine(BannerDirectory, userId + t.Extension))
            .FirstOrDefault(System.IO.File.Exists);
        if (match is null)
        {
            return NotFound();
        }

        var contentType = AllowedTypes.First(t => t.Extension == Path.GetExtension(match)).ContentType;
        return PhysicalFile(match, contentType);
    }

    [HttpPost]
    public async Task<IActionResult> Upload()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var contentType = Request.ContentType?.Split(';').FirstOrDefault();
        var match = AllowedTypes.FirstOrDefault(t => t.ContentType == contentType);
        if (match.Extension is null)
        {
            return BadRequest("Unsupported image type");
        }

        byte[] bytes;
        try
        {
            using var reader = new StreamReader(Request.Body);
            bytes = Convert.FromBase64String(await reader.ReadToEndAsync());
        }
        catch (FormatException)
        {
            return BadRequest("Malformed image data");
        }

        if (bytes.Length > MaxUploadBytes)
        {
            return BadRequest("Image too large. Please use a banner under 8 MB.");
        }

        byte[] encoded;
        try
        {
            using var image = Image.Load(bytes);
            if (image.Width > MaxDimension || image.Height > MaxDimension)
            {
                image.Mutate(x => x.Resize(new ResizeOptions
                {
                    Mode = ResizeMode.Max,
                    Size = new Size(MaxDimension, MaxDimension),
                }));
            }

            using var output = new MemoryStream();
            switch (match.ContentType)
            {
                case "image/png":
                    image.Save(output, new PngEncoder());
                    break;
                case "image/webp":
                    image.Save(output, new WebpEncoder());
                    break;
                default:
                    image.Save(output, new JpegEncoder { Quality = 85 });
                    break;
            }

            encoded = output.ToArray();
        }
        catch (ImageFormatException)
        {
            // Real base class, confirmed against ImageSharp's own source
            // before writing this: UnknownImageFormatException (an
            // unrecognized format) is one of its own real subclasses, so
            // this one catch already covers that case too, not just a
            // real but corrupt file of a genuinely supported format.
            return BadRequest("Malformed image data");
        }

        Directory.CreateDirectory(BannerDirectory);
        foreach (var type in AllowedTypes)
        {
            var existing = Path.Combine(BannerDirectory, userId + type.Extension);
            if (System.IO.File.Exists(existing))
            {
                System.IO.File.Delete(existing);
            }
        }

        await System.IO.File.WriteAllBytesAsync(Path.Combine(BannerDirectory, userId + match.Extension), encoded);
        return NoContent();
    }

    [HttpDelete]
    public IActionResult Delete()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        foreach (var type in AllowedTypes)
        {
            var path = Path.Combine(BannerDirectory, userId + type.Extension);
            if (System.IO.File.Exists(path))
            {
                System.IO.File.Delete(path);
            }
        }

        return NoContent();
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
