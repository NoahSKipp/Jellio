using System;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using Jellio.Services.Reading;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Exposes active playback sessions server side, through the real
/// ISessionManager the server already tracks, rather than the cron plus
/// static JSON file approach community "now playing" scripts use when they
/// have no plugin backend to lean on. Requires an authenticated Jellyfin
/// user, any user, this is a shared "who is watching what" surface by
/// design, not admin only. Reading (books and manga in Jellio's reader)
/// has no Jellyfin session, so the reader checks in here instead
/// (NowReadingService).
/// </summary>
[ApiController]
[Route("Jellio/now-playing")]
[Authorize]
public class NowPlayingController(ISessionManager sessionManager, NowReadingService nowReading, LiveWatchingService liveWatching, IUserManager userManager) : ControllerBase
{
    private const int MaxTitleLength = 300;

    public record ReadingBody(string? ItemId, string? Kind, string? Title, string? SeriesTitle, int? MangaId, int? Page, int? PageCount);

    public record LiveBody(string? ChannelId, string? ChannelName, string? Programme, string? Source, string? LogoUrl, bool IsPaused, string? DeviceName, string? Client);

    [HttpGet]
    public IActionResult Get()
    {
        var sessions = sessionManager.Sessions
            .Where(s => s.NowPlayingItem != null)
            .Select(s => new
            {
                s.Id,
                s.UserName,
                s.DeviceName,
                s.Client,
                Activity = s.NowPlayingItem.Type.ToString() == "AudioBook" ? "listening" : "playing",
                IsPaused = s.PlayState?.IsPaused ?? false,
                PositionTicks = s.PlayState?.PositionTicks,
                Item = new
                {
                    s.NowPlayingItem.Id,
                    s.NowPlayingItem.Name,
                    Type = s.NowPlayingItem.Type.ToString(),
                    s.NowPlayingItem.SeriesId,
                    s.NowPlayingItem.SeriesName,
                    s.NowPlayingItem.Album,
                    s.NowPlayingItem.AlbumId,
                    s.NowPlayingItem.ParentIndexNumber,
                    s.NowPlayingItem.IndexNumber,
                    s.NowPlayingItem.ProductionYear,
                    s.NowPlayingItem.RunTimeTicks,
                    MangaId = (int?)null,
                    Page = (int?)null,
                    PageCount = (int?)null,
                },
            })
            .ToList();

        var reading = nowReading.Current().Select(entry => new
        {
            Id = "reading-" + entry.UserId.ToString("N"),
            entry.UserName,
            DeviceName = (string?)null,
            Client = (string?)null,
            Activity = "reading",
            IsPaused = false,
            PositionTicks = (long?)null,
            Item = new
            {
                Id = entry.ItemId,
                Name = entry.Title,
                Type = entry.Kind == "manga" ? "Manga" : "Book",
                SeriesId = (string?)null,
                SeriesName = entry.SeriesTitle,
                Album = (string?)null,
                AlbumId = (string?)null,
                ParentIndexNumber = (int?)null,
                IndexNumber = (int?)null,
                ProductionYear = (int?)null,
                RunTimeTicks = (long?)null,
                entry.MangaId,
                entry.Page,
                entry.PageCount,
            },
        });

        var live = liveWatching.Current().Select(entry => new
        {
            Id = "live-" + entry.UserId.ToString("N"),
            entry.UserName,
            entry.DeviceName,
            entry.Client,
            Activity = "watching_live",
            entry.IsPaused,
            PositionTicks = (long?)null,
            Item = new
            {
                Id = entry.ChannelId,
                Name = entry.ChannelName,
                Type = "TvChannel",
                SeriesId = (string?)null,
                SeriesName = entry.Programme,
                Album = (string?)null,
                AlbumId = (string?)null,
                ParentIndexNumber = (int?)null,
                IndexNumber = (int?)null,
                ProductionYear = (int?)null,
                RunTimeTicks = (long?)null,
                MangaId = (int?)null,
                Page = (int?)null,
                PageCount = (int?)null,
                entry.Source,
                entry.LogoUrl,
            },
        });

        // Tuner channels a Jellyfin client reports itself already show above.
        return Ok(sessions.Select(session => (object)session)
            .Concat(reading.Select(entry => (object)entry))
            .Concat(live.Select(entry => (object)entry)));
    }

    // The live players, every half minute while a channel plays.
    [HttpPost("live")]
    public async Task<IActionResult> Live([FromBody] LiveBody body)
    {
        if (!TryUser(out var userId) || body is null || string.IsNullOrWhiteSpace(body.ChannelName))
        {
            return BadRequest("Invalid request");
        }

        var user = userManager.GetUserById(userId);
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        var logo = body.LogoUrl is { } url && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? Clip(url) : null;
        await liveWatching.ReportAsync(new LiveWatchingEntry(
            userId,
            user.Username,
            Clip(body.ChannelId),
            Clip(body.ChannelName)!,
            Clip(body.Programme),
            body.Source == "link" ? "link" : "tuner",
            logo,
            body.IsPaused,
            Clip(body.DeviceName),
            Clip(body.Client),
            DateTimeOffset.UtcNow)).ConfigureAwait(false);
        return NoContent();
    }

    [HttpDelete("live")]
    public async Task<IActionResult> StopLive()
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        await liveWatching.StopAsync(userId).ConfigureAwait(false);
        return NoContent();
    }

    // The reader, every so often while a book or chapter is open.
    [HttpPost("reading")]
    public IActionResult Reading([FromBody] ReadingBody body)
    {
        if (!TryUser(out var userId) || body is null || string.IsNullOrWhiteSpace(body.ItemId) || string.IsNullOrWhiteSpace(body.Title))
        {
            return BadRequest("Invalid request");
        }

        var user = userManager.GetUserById(userId);
        if (user is null)
        {
            return BadRequest("Invalid user session");
        }

        nowReading.Report(new NowReadingEntry(
            userId,
            user.Username,
            Clip(body.ItemId)!,
            body.Kind == "manga" ? "manga" : "book",
            Clip(body.Title)!,
            Clip(body.SeriesTitle),
            body.MangaId,
            body.Page is > 0 ? body.Page : null,
            body.PageCount is > 0 ? body.PageCount : null,
            DateTimeOffset.UtcNow));
        return NoContent();
    }

    [HttpDelete("reading/{itemId}")]
    public IActionResult StopReading(string itemId)
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        nowReading.Clear(userId, itemId);
        return NoContent();
    }

    private static string? Clip(string? text) =>
        text is null ? null : text.Length > MaxTitleLength ? text[..MaxTitleLength] : text;

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }
}
