using System;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

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
