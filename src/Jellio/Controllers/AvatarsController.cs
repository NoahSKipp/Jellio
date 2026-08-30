using System;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Lists and serves the preset avatar images an admin drops into Jellio's
/// own plugin data directory. Path derivation confirmed against a real
/// plugin that does the same thing (cedev-1/jellyfin-plugin-GetAvatar's
/// AvatarService.cs), not guessed: IApplicationPaths.PluginConfigurationsPath
/// is the real, environment-adapted (Docker, Windows, Linux) base every
/// Jellyfin plugin with its own persistent files uses, Jellio just adds its
/// own "avatars" subfolder under it. Setting the chosen image as a user's
/// avatar is not this controller's job, the client picker fetches an image
/// from here and hands it to Jellyfin's own native
/// ApiClient.uploadUserImage, the same POST /Users/{id}/Images/Primary
/// flow the stock profile page already uses, confirmed against
/// apps/legacy/routes/user/userprofile.tsx and
/// jellyfin-apiclient-javascript's own uploadUserImage. No second image
/// storage or "set avatar" endpoint needed, Jellyfin already owns that.
/// </summary>
[ApiController]
[Route("Jellio/avatars")]
[Authorize]
public class AvatarsController(IApplicationPaths applicationPaths) : ControllerBase
{
    private static readonly string[] AllowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

    private string AvatarDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "avatars");

    [HttpGet]
    public IActionResult Get()
    {
        var dir = AvatarDirectory;
        if (!Directory.Exists(dir))
        {
            return Ok(Array.Empty<object>());
        }

        var files = Directory
            .EnumerateFiles(dir)
            .Where(f => AllowedExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .Select(f => new { Id = Path.GetFileName(f) });

        return Ok(files);
    }

    [HttpGet("{id}")]
    public IActionResult GetImage(string id)
    {
        var fileName = Path.GetFileName(id);
        var extension = Path.GetExtension(fileName).ToLowerInvariant();
        if (!AllowedExtensions.Contains(extension))
        {
            return NotFound();
        }

        var path = Path.Combine(AvatarDirectory, fileName);
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        var contentType = extension switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            _ => "application/octet-stream",
        };

        return PhysicalFile(path, contentType);
    }
}
