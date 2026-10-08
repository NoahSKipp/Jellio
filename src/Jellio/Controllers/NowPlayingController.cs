using System;
using System.Linq;
using System.Security.Claims;
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
public class NowPlayingController(ISessionManager sessionManager, NowReadingService nowReading, IUserManager userManager) : ControllerBase
{
    private const int MaxTitleLength = 300;

    public record ReadingBody(string? ItemId, string? Kind, string? Title, string? SeriesTitle, int? MangaId, int? Page, int? PageCount);

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

        return Ok(sessions.Select(session => (object)session).Concat(reading.Select(entry => (object)entry)));
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
