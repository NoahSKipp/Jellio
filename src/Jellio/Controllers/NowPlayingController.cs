using System.Linq;
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
/// design, not admin only.
/// </summary>
[ApiController]
[Route("Jellio/now-playing")]
[Authorize]
public class NowPlayingController(ISessionManager sessionManager) : ControllerBase
{
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
                IsPaused = s.PlayState?.IsPaused ?? false,
                PositionTicks = s.PlayState?.PositionTicks,
                Item = new
                {
                    s.NowPlayingItem.Id,
                    s.NowPlayingItem.Name,
                    s.NowPlayingItem.Type,
                    s.NowPlayingItem.SeriesId,
                    s.NowPlayingItem.SeriesName,
                    s.NowPlayingItem.ParentIndexNumber,
                    s.NowPlayingItem.IndexNumber,
                    s.NowPlayingItem.ProductionYear,
                    s.NowPlayingItem.RunTimeTicks,
                },
            });

        return Ok(sessions);
    }
}
