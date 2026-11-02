using System.Linq;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

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
