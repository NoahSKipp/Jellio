using System;
using System.Linq;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// One line in the Jellyfin log per Jellio playback: how it plays
/// (DirectPlay, Remux, Transcode), why the video would need a re-encode,
/// Jellyfin's own TranscodeReasons and the Video transcode policy in force.
/// For measuring how often a server without hardware acceleration is asked
/// to re-encode video. Sent by the web player after PlaybackInfo.
/// </summary>
[ApiController]
[Route("Jellio/playback")]
[Authorize]
public class PlaybackLogController(ILogger<PlaybackLogController> logger) : ControllerBase
{
    public record DecisionBody(Guid ItemId, string? MediaSourceId, string? PlayMethod, string[]? Reasons, JsonElement? ServerTranscodeReasons, string? Policy);

    [HttpPost("decision")]
    public IActionResult Decision([FromBody] DecisionBody body)
    {
        var userId = HttpContext.User.Identity is ClaimsIdentity identity ? identity.FindFirst("Jellyfin-UserId")?.Value : null;
        var reasons = body.Reasons is { Length: > 0 } ? string.Join(",", body.Reasons.Take(10)) : "none";
        var serverReasons = body.ServerTranscodeReasons is { } element && element.ValueKind != JsonValueKind.Null
            ? element.ToString()
            : "none";
        logger.LogInformation(
            "Jellio playback: {PlayMethod} for item {ItemId} source {MediaSourceId}, video re-encode reasons {Reasons}, Jellyfin TranscodeReasons {ServerReasons}, policy {Policy}, user {UserId}",
            Clean(body.PlayMethod),
            body.ItemId,
            Clean(body.MediaSourceId),
            Clean(reasons),
            Clean(serverReasons),
            Clean(body.Policy),
            userId);
        return NoContent();
    }

    // Keeps a client-sent value to one short line in the log.
    private static string Clean(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "-";
        }

        var oneLine = new string(value.Where(c => !char.IsControl(c)).ToArray());
        return oneLine.Length > 200 ? oneLine[..200] : oneLine;
    }
}
