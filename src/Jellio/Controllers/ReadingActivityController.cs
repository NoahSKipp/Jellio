using System;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Where reading and listening reach the Feed and achievements: the
/// reader and the audiobook player report each session as it ends
/// (AchievementService.CreditReadingSessionAsync). Numbers are clamped
/// here so one bad report can't hand out a shelf of badges.
/// </summary>
[ApiController]
[Route("Jellio/reading/session")]
[Authorize]
public class ReadingActivityController(AchievementService achievementService, ILibraryManager libraryManager, IUserManager userManager) : ControllerBase
{
    private const int MaxPagesPerSession = 2000;
    private const int MaxListenSecondsPerSession = 24 * 60 * 60;

    public record SessionBody(Guid ItemId, string Kind, int PagesRead, int? CurrentPage, int? PageCount, int ListenedSeconds, bool Finished);

    [HttpPost]
    public async Task<IActionResult> Report([FromBody] SessionBody body)
    {
        if (HttpContext.User.Identity is not ClaimsIdentity identity
            || !Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId))
        {
            return BadRequest("Invalid user session");
        }

        var user = userManager.GetUserById(userId);
        var item = body is null ? null : libraryManager.GetItemById(body.ItemId);
        if (user is null || item is null || !item.IsVisible(user))
        {
            return NotFound();
        }

        var kind = body!.Kind?.Trim().ToLowerInvariant();
        var matches = kind switch
        {
            "book" or "manga" => item is Book,
            "audiobook" => item is AudioBook,
            _ => false,
        };
        if (!matches)
        {
            return BadRequest("Kind must be book, manga or audiobook and match the item");
        }

        var pageCount = body.PageCount is > 0 and < 100_000 ? body.PageCount : null;
        var pagesRead = Math.Clamp(body.PagesRead, 0, Math.Min(MaxPagesPerSession, pageCount ?? MaxPagesPerSession));
        var currentPage = body.CurrentPage is > 0 ? Math.Min(body.CurrentPage.Value, pageCount ?? body.CurrentPage.Value) : (int?)null;
        var listenedTicks = TimeSpan.FromSeconds(Math.Clamp(body.ListenedSeconds, 0, MaxListenSecondsPerSession)).Ticks;

        await achievementService.CreditReadingSessionAsync(
            userId,
            item,
            new AchievementService.ReadingSession(kind!, pagesRead, currentPage, pageCount, listenedTicks, body.Finished)).ConfigureAwait(false);
        return NoContent();
    }
}
