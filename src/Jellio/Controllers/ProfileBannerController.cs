using System;
using System.IO;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

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

    // Real feedback, live: an unresized banner (this endpoint never
    // downsizes anything server side, unlike every other real image
    // path in this app, which all ask for a specific max width) meant a
    // reader's own full resolution photo shipped straight back out on
    // every profile visit, real "scrolling is painfully slow" the
    // actual symptom of a multi megapixel bitmap sitting in this page's
    // own render tree. No real image library safely reachable from
    // here (SixLabors.ImageSharp would be its own fresh dependency this
    // plugin cannot build or run to actually verify, System.Drawing.Common
    // is Windows only since .NET 6, and this real server runs on Linux),
    // so a byte size cap is the one real, dependency free guard rail
    // available: generous enough for a real, already reasonably
    // compressed photo, small enough to actually stop the pathological
    // case.
    private const long MaxUploadBytes = 8 * 1024 * 1024;

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

        Directory.CreateDirectory(BannerDirectory);
        foreach (var type in AllowedTypes)
        {
            var existing = Path.Combine(BannerDirectory, userId + type.Extension);
            if (System.IO.File.Exists(existing))
            {
                System.IO.File.Delete(existing);
            }
        }

        await System.IO.File.WriteAllBytesAsync(Path.Combine(BannerDirectory, userId + match.Extension), bytes);
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
