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
///
/// Real feedback asked for grouping: an admin can drop images straight
/// into the avatars folder (Category null, same flat shape this always
/// had) or into one real subfolder per group ("Kids", "Adults", ...),
/// exactly one level deep, that subfolder's own name becoming Category.
/// Id is the file's own path relative to the avatars folder (so
/// "Kids/panda.png" for a grouped one, "panda.png" for a loose one),
/// carried whole through GetImage below via a catch-all route segment
/// the same way FrontendController's own {**path} already does, since a
/// plain {id} route parameter cannot carry a literal "/" through.
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

        var loose = Directory
            .EnumerateFiles(dir)
            .Where(f => AllowedExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .Select(f => new { Id = Path.GetFileName(f), Category = (string?)null });

        // Exactly one level deep: a subfolder's own files become one real
        // group, a subfolder inside that subfolder is not walked into.
        // Same real reasoning the picker itself only ever renders one flat
        // row of collapsible sections, not a tree.
        var grouped = Directory
            .EnumerateDirectories(dir)
            .SelectMany(sub =>
            {
                var category = Path.GetFileName(sub);
                return Directory
                    .EnumerateFiles(sub)
                    .Where(f => AllowedExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
                    .Select(f => new { Id = category + "/" + Path.GetFileName(f), Category = (string?)category });
            });

        var all = loose
            .Concat(grouped)
            .OrderBy(a => a.Category ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ThenBy(a => a.Id, StringComparer.OrdinalIgnoreCase);

        return Ok(all);
    }

    [HttpGet("{**id}")]
    public IActionResult GetImage(string id)
    {
        var extension = Path.GetExtension(id).ToLowerInvariant();
        if (!AllowedExtensions.Contains(extension))
        {
            return NotFound();
        }

        var root = Path.GetFullPath(AvatarDirectory);
        var path = Path.GetFullPath(Path.Combine(root, id));

        // id travels the whole way from the client, so this real check is
        // what actually stops a "../" segment from ever escaping the
        // avatars folder, not just the missing-file check below on its
        // own.
        if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            return NotFound();
        }

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
