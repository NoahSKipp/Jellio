using System.Linq;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Every user id with a real active session on the server right now,
/// the same ISessionManager.Sessions NowPlayingController.cs already
/// reads, just every session rather than only ones with NowPlayingItem
/// set: a reader signed in and sitting on Home counts as online too,
/// not only one actually playing something. Same real trust model
/// that controller's own header already states: any authenticated
/// user, shared by design, not admin only.
/// </summary>
[ApiController]
[Route("Jellio/online-users")]
[Authorize]
public class OnlineUsersController(ISessionManager sessionManager) : ControllerBase
{
    [HttpGet]
    public IActionResult Get()
    {
        var userIds = sessionManager.Sessions.Select(s => s.UserId).Distinct();
        return Ok(userIds);
    }
}
