using System;
using System.IO;
using System.Linq;
using System.Security.Claims;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Real gap in stock Jellyfin: GET /Shows/NextUp has no matching endpoint
/// that hides one series from it permanently, only ever the side effect
/// of marking an episode played (which just advances that same series to
/// its own next episode, real bug reported live, components/
/// cardOptionsMenu.js's own "Remove from Up Next" button). This stores a
/// per user set of series ids to exclude from that row, one plain JSON
/// array per user id, same real file-per-thing storage AvatarsController
/// already uses under PluginConfigurationsPath rather than a database
/// this plugin has no other reason to carry. User id read from the same
/// real "Jellyfin-UserId" claim SleepTimerController already reads it
/// from, not guessed.
/// </summary>
[ApiController]
[Route("Jellio/next-up-hidden")]
[Authorize]
public class NextUpHiddenController(IApplicationPaths applicationPaths) : ControllerBase
{
    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "next-up-hidden");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    [HttpGet]
    public ActionResult<string[]> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(Load(userId));
    }

    [HttpPost("{seriesId}")]
    public IActionResult Hide(string seriesId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var hidden = Load(userId);
        if (!hidden.Contains(seriesId, StringComparer.OrdinalIgnoreCase))
        {
            Save(userId, hidden.Append(seriesId).ToArray());
        }

        return Ok();
    }

    private string[] Load(Guid userId)
    {
        var path = StorePath(userId);
        if (!System.IO.File.Exists(path))
        {
            return Array.Empty<string>();
        }

        try
        {
            return JsonSerializer.Deserialize<string[]>(System.IO.File.ReadAllText(path)) ?? Array.Empty<string>();
        }
        catch (JsonException)
        {
            return Array.Empty<string>();
        }
    }

    private void Save(Guid userId, string[] hidden)
    {
        Directory.CreateDirectory(StoreDirectory);
        System.IO.File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(hidden));
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
