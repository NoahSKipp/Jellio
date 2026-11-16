using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Extensions;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/recommendations/top-picks")]
[Authorize]
public class RecommendationsController(
    RecommendationsService recommendationsService,
    IUserManager userManager) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetTopPicks(
        [FromQuery] Guid? userId = null,
        [FromQuery] int limit = 20,
        [FromQuery] bool enableVirtual = true,
        CancellationToken ct = default)
    {
        var targetUserId = userId.HasValue && userId.Value != Guid.Empty
            ? userId.Value
            : (User.TryGetJellyfinUserId(out var id) ? id : Guid.Empty);

        var user = targetUserId != Guid.Empty ? userManager.GetUserById(targetUserId) : null;
        user ??= userManager.GetUsers().FirstOrDefault();
        if (user == null)
        {
            return Unauthorized();
        }

        var clampedLimit = Math.Clamp(limit, 1, 100);
        var items = await recommendationsService.GetTopPicksAsync(
            user,
            clampedLimit,
            enableVirtual,
            ct).ConfigureAwait(false);

        return Ok(new
        {
            Title = "Top Picks for You",
            Items = items,
        });
    }
}
