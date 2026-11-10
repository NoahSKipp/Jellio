using System;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

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

    public record FailoverBody(
        Guid ItemId,
        string? FailedSourceId,
        string? Reason,
        int Total,
        int Tried,
        int BadHard,
        int BadSoft,
        int AfterLanguage,
        int AfterTranscode,
        string? ListOrigin,
        string? ListError,
        long? ListMs,
        string? Outcome,
        string? NextSourceId,
        string? Client = null);

    // One line per switch to another stream after one failed: why, how many
    // sources there were and what ruled each out, and how the list loaded.
    [HttpPost("failover")]
    public IActionResult Failover([FromBody] FailoverBody body)
    {
        var userId = HttpContext.User.Identity is ClaimsIdentity identity ? identity.FindFirst("Jellyfin-UserId")?.Value : null;
        logger.LogInformation(
            "Jellio failover: item {ItemId} source {FailedSourceId} failed ({Reason}); {Total} sources, {Tried} tried, bad {BadHard} hard / {BadSoft} soft, {AfterLanguage} after language, {AfterTranscode} after transcode rule; list {ListOrigin}{ListError}; {Outcome} {NextSourceId}, client {Client}, user {UserId}",
            body.ItemId,
            Clean(body.FailedSourceId),
            Clean(body.Reason),
            body.Total,
            body.Tried,
            body.BadHard,
            body.BadSoft,
            body.AfterLanguage,
            body.AfterTranscode,
            Clean(body.ListOrigin),
            string.IsNullOrEmpty(body.ListError) ? string.Empty : " (" + Clean(body.ListError) + " after " + (body.ListMs ?? 0) + " ms)",
            Clean(body.Outcome),
            Clean(body.NextSourceId),
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

    public record PlayStartStages(int? DetailsMs, int? PlaybackInfoMs, int? PlayerReadyMs, int? FirstByteMs, int? FirstFrameMs);

    public record PlayStartBody(
        string? ItemId,
        string? MediaSourceId,
        string? Client,
        string? Trigger,
        string? From,
        bool? WarmAtPlay,
        bool? DirectPlay,
        PlayStartStages? Stages,
        int TotalMs);

    private static readonly string[] PlayClients = ["web", "tv", "macos"];
    private static readonly string[] PlayTriggers = ["detail", "resume", "next-episode", "failover", "other"];
    private static readonly string[] PlayFroms = ["prewarmed", "prefetched", "early", "fresh"];
    private const int MaxStageMs = 10 * 60 * 1000;

    private static readonly PlayStartStats PlayStarts = new(1000);

    // One line per play: how long it took from Play to the first frame, by stage.
    [HttpPost("start")]
    public IActionResult Start([FromBody] PlayStartBody body)
    {
        var userId = HttpContext.User.Identity is ClaimsIdentity identity ? identity.FindFirst("Jellyfin-UserId")?.Value : null;
        var client = OneOf(body.Client, PlayClients, "web");
        var from = OneOf(body.From, PlayFroms, "fresh");
        var stages = body.Stages ?? new PlayStartStages(null, null, null, null, null);
        var total = ClampMs(body.TotalMs) ?? 0;
        var firstFrame = ClampMs(stages.FirstFrameMs);
        PlayStarts.Add(new PlayStartEntry(client, from, body.WarmAtPlay, total, firstFrame));
        logger.LogInformation(
            "Jellio play start: item {ItemId} source {MediaSourceId}, client {Client}, trigger {Trigger}, from {From}, warm {Warm}, direct {Direct}; details {DetailsMs} ms, playback info {PlaybackInfoMs} ms, player ready {PlayerReadyMs} ms, first byte {FirstByteMs} ms, first frame {FirstFrameMs} ms, total {TotalMs} ms, user {UserId}",
            SafeId(body.ItemId),
            SafeId(body.MediaSourceId),
            client,
            OneOf(body.Trigger, PlayTriggers, "other"),
            from,
            body.WarmAtPlay?.ToString() ?? "-",
            body.DirectPlay?.ToString() ?? "-",
            Ms(stages.DetailsMs),
            Ms(stages.PlaybackInfoMs),
            Ms(stages.PlayerReadyMs),
            Ms(stages.FirstByteMs),
            Ms(firstFrame),
            total,
            userId);
        return NoContent();
    }

    [HttpGet("start/stats")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult<PlayStartSummary> StartStats() => PlayStarts.Summarize();

    private static string OneOf(string? value, string[] allowed, string fallback)
    {
        var lower = value?.Trim().ToLowerInvariant();
        return lower is not null && allowed.Contains(lower) ? lower : fallback;
    }

    // Ids only: anything that is not a short token (a URL, say) is dropped.
    private static string SafeId(string? value)
    {
        if (Guid.TryParse(value, out var id))
        {
            return id.ToString("N");
        }

        return !string.IsNullOrEmpty(value) && value.Length <= 64 && value.All(c => char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_') ? value : "-";
    }

    private static int? ClampMs(int? value) => value is null ? null : Math.Clamp(value.Value, 0, MaxStageMs);

    private static string Ms(int? value) => ClampMs(value)?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-";

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
