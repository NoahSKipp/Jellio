using System;
using System.IO;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellio.Services;
using Jellio.Services.Manga;
using Jellio.Services.Reading;
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
public class ReadingActivityController(AchievementService achievementService, MangaStreamService streamService, ILibraryManager libraryManager, IUserManager userManager, ShelfStore shelfStore) : ControllerBase
{
    private const int MaxPagesPerSession = 2000;
    private const int MaxListenSecondsPerSession = 24 * 60 * 60;

    // ReadSeconds: active time in the reader (books and manga).
    public record SessionBody(Guid ItemId, string Kind, int PagesRead, int? CurrentPage, int? PageCount, int ListenedSeconds, bool Finished, int? MangaId = null, int ReadSeconds = 0, float? ChapterNumber = null);

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
        if (user is not null && item is null && body!.Kind?.Trim().ToLowerInvariant() == "manga"
            && await streamService.FindChapterAsync(body.ItemId.ToString("N"), body.MangaId, HttpContext.RequestAborted).ConfigureAwait(false) is { } streamed)
        {
            // A chapter read straight from its source.
            var streamPageCount = body.PageCount is > 0 and < 100_000 ? body.PageCount : null;
            var streamChapterNumber = streamed.Chapter.Number >= 0 ? streamed.Chapter.Number : body.ChapterNumber;
            var streamSeriesShelfKey = ShelfStore.SeriesShelfKey(streamed.Series.Title);
            var streamShelf = shelfStore.Load(userId);
            var streamPrefs = streamShelf.Series.TryGetValue(streamSeriesShelfKey, out var sp) ? sp : null;
            var streamDuplicatesAsOne = streamPrefs?.DuplicatesAsOne != false;

            var completionKey = streamDuplicatesAsOne && streamChapterNumber.HasValue && streamChapterNumber.Value >= 0
                ? $"manga:{streamSeriesShelfKey}:{streamChapterNumber.Value}"
                : body.ItemId.ToString("N");

            await achievementService.CreditReadingSessionAsync(
                userId,
                body.ItemId,
                streamed.Chapter.Name,
                streamed.Series.Title,
                completionKey,
                new AchievementService.ReadingSession(
                    "manga",
                    Math.Clamp(body.PagesRead, 0, Math.Min(MaxPagesPerSession, streamPageCount ?? MaxPagesPerSession)),
                    body.CurrentPage is > 0 ? Math.Min(body.CurrentPage.Value, streamPageCount ?? body.CurrentPage.Value) : null,
                    streamPageCount,
                    TimeSpan.FromSeconds(Math.Clamp(body.ReadSeconds, 0, MaxListenSecondsPerSession)).Ticks,
                    body.Finished),
                duplicatesAsOne: streamDuplicatesAsOne).ConfigureAwait(false);
            return NoContent();
        }

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

        var seriesName = (item as IHasSeries)?.SeriesName;
        if (string.IsNullOrWhiteSpace(seriesName) && kind == "manga" && !string.IsNullOrEmpty(item.Path))
        {
            seriesName = Path.GetFileName(Path.GetDirectoryName(item.Path));
        }

        var localChapterNumber = body.ChapterNumber;
        var duplicatesAsOne = false;
        if (kind == "manga" && !string.IsNullOrWhiteSpace(seriesName))
        {
            var seriesShelfKey = ShelfStore.SeriesShelfKey(seriesName);
            var shelf = shelfStore.Load(userId);
            var prefs = shelf.Series.TryGetValue(seriesShelfKey, out var p) ? p : null;
            duplicatesAsOne = prefs?.DuplicatesAsOne != false;
        }

        var pageCount = body.PageCount is > 0 and < 100_000 ? body.PageCount : null;
        var pagesRead = Math.Clamp(body.PagesRead, 0, Math.Min(MaxPagesPerSession, pageCount ?? MaxPagesPerSession));
        var currentPage = body.CurrentPage is > 0 ? Math.Min(body.CurrentPage.Value, pageCount ?? body.CurrentPage.Value) : (int?)null;
        var listenedTicks = TimeSpan.FromSeconds(Math.Clamp(kind == "audiobook" ? body.ListenedSeconds : body.ReadSeconds, 0, MaxListenSecondsPerSession)).Ticks;

        await achievementService.CreditReadingSessionAsync(
            userId,
            item,
            new AchievementService.ReadingSession(kind!, pagesRead, currentPage, pageCount, listenedTicks, body.Finished),
            duplicatesAsOne: duplicatesAsOne,
            chapterNumber: localChapterNumber).ConfigureAwait(false);
        return NoContent();
    }
}
