using System;
using System.Linq;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// One line in the Jellyfin log per Jellio playback: how it plays
/// (DirectPlay, Remux, Transcode), why the video would need a re-encode,
/// Jellyfin's own TranscodeReasons and the Video transcode policy in force.
/// For measuring how often a server without hardware acceleration is asked
/// to re-encode video. Sent by the web player and Jellio TV after
/// PlaybackInfo. Also the web frontend's home load report.
/// </summary>
[ApiController]
[Route("Jellio/playback")]
[Authorize]
public class PlaybackLogController(ILogger<PlaybackLogController> logger) : ControllerBase
{
    public record DecisionBody(Guid ItemId, string? MediaSourceId, string? PlayMethod, string[]? Reasons, string? ServerTranscodeReasons, string? Policy, bool Guessed = false, string? Client = null);

    [HttpPost("decision")]
    public IActionResult Decision([FromBody] DecisionBody body)
    {
        var userId = HttpContext.User.Identity is ClaimsIdentity identity ? identity.FindFirst("Jellyfin-UserId")?.Value : null;
        var reasons = body.Reasons is { Length: > 0 } ? string.Join(",", body.Reasons.Take(10)) : "none";
        var serverReasons = string.IsNullOrWhiteSpace(body.ServerTranscodeReasons) ? "none" : body.ServerTranscodeReasons;
        logger.LogInformation(
            "Jellio playback: {PlayMethod} for item {ItemId} source {MediaSourceId}, video re-encode reasons {Reasons}, Jellyfin TranscodeReasons {ServerReasons}, policy {Policy}, details {Source}, client {Client}, user {UserId}",
            Clean(body.PlayMethod),
            body.ItemId,
            Clean(body.MediaSourceId),
            Clean(reasons),
            Clean(serverReasons),
            Clean(body.Policy),
            body.Guessed ? "from stream name" : "probed",
            Clean(body.Client ?? "web"),
            userId);
        return NoContent();
    }

    public record HomeLoadBody(
        int Hits,
        int Stale,
        int Misses,
        int Fetches,
        int FromOtherTabs,
        int RequestsFirst5s,
        int MaxConcurrentFirst5s,
        int? FirstRowPaintMs,
        bool StreamPlayingElsewhere,
        string? Storage,
        string? Route);

    // One line per page load from the web frontend's home row cache: how
    // much came from the cache and how many requests the start sent.
    [HttpPost("homeload")]
    public IActionResult HomeLoad([FromBody] HomeLoadBody body)
    {
        var userId = HttpContext.User.Identity is ClaimsIdentity identity ? identity.FindFirst("Jellyfin-UserId")?.Value : null;
        logger.LogInformation(
            "Jellio home load: {Hits} cached, {Stale} stale, {Misses} missed, {Fetches} fetched, {FromOtherTabs} from other tabs; {Requests} requests in the first 5 s, at most {MaxConcurrent} at once; first row after {FirstRowMs} ms; stream playing elsewhere {Playing}; storage {Storage}, route {Route}, user {UserId}",
            body.Hits,
            body.Stale,
            body.Misses,
            body.Fetches,
            body.FromOtherTabs,
            body.RequestsFirst5s,
            body.MaxConcurrentFirst5s,
            body.FirstRowPaintMs?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-",
            body.StreamPlayingElsewhere,
            Clean(body.Storage),
            Clean(body.Route),
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
