using System;
using System.Linq;
using System.Threading.Tasks;
using Jellio.Services.Subtitles;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// Backs screens/player.js's own automatic subtitle fetch. Same real
/// trust model GroupWatchChatController's own header already states:
/// any authenticated user, not scoped further, this is a small friends
/// only install, not a real per user quota to protect. Real
/// SubDlApiKey/SubtitleLanguages both live on PluginConfiguration.
/// </summary>
[ApiController]
[Route("Jellio/subtitles")]
[Authorize]
public class SubtitlesController(SubtitleFetchService fetchService, SubtitleCacheStore cacheStore, ILogger<SubtitlesController> logger) : ControllerBase
{
    // Fires and forgets, the one real point of this whole endpoint:
    // screens/player.js calls this the moment it mounts, real feedback
    // asked for nothing here to ever add a single millisecond to actual
    // playback start. Wrapped in its own try/catch even though
    // SubtitleFetchService.EnsureAsync already catches every real
    // failure mode it knows about internally: a task nobody awaits that
    // still somehow faults is a real unobserved exception this guards
    // against regardless, not something safe to assume can never happen.
    [HttpPost("{itemId}/ensure")]
    public IActionResult Ensure([FromRoute] Guid itemId)
    {
        var config = JellioPlugin.Instance?.Configuration;
        if (config == null || string.IsNullOrWhiteSpace(config.SubDlApiKey))
        {
            return Ok();
        }

        var languages = (config.SubtitleLanguages ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var apiKey = config.SubDlApiKey;

        _ = Task.Run(async () =>
        {
            try
            {
                await fetchService.EnsureAsync(itemId, apiKey, languages).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: subtitle ensure task for {ItemId} failed unexpectedly", itemId);
            }
        });

        return Ok();
    }

    [HttpGet("{itemId}")]
    public IActionResult Get([FromRoute] Guid itemId)
    {
        var languages = cacheStore.GetAvailableLanguages(itemId).Select(language => new { Language = language });
        return Ok(languages);
    }

    [HttpGet("{itemId}/{language}.vtt")]
    public IActionResult GetVtt([FromRoute] Guid itemId, [FromRoute] string language)
    {
        var path = cacheStore.GetVttFilePath(itemId, language);
        if (path == null)
        {
            return NotFound();
        }

        return PhysicalFile(path, "text/vtt");
    }
}
