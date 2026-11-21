using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Extensions;
using Jellio.Services.Friends;
using Jellio.Services.Reading;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

// A user's list of books, audiobooks and manga to read or listen to next.
// Separate from the watchlist: nothing here touches IsFavorite.
[ApiController]
[Route("Jellio/reading-list")]
[Authorize]
public class ReadingListController(
    ReadingListStore store,
    ReadingTargets targets,
    FriendsService friends,
    ILibraryManager libraryManager,
    IUserManager userManager) : ControllerBase
{
    public record AddBody(string? Key, string? Kind, string? ItemId, string? Title, string? Author, string? CoverUrl, int? MangaId);

    [HttpGet]
    public IActionResult List()
    {
        if (!TryUser(out var me))
        {
            return BadRequest(Error("invalid_user"));
        }

        var user = userManager.GetUserById(me);
        var entries = store.Snapshot(me);

        // Library items that are gone are dropped; ones the user can no
        // longer see are only left out of the answer.
        var gone = new List<string>();
        var shown = new List<ReadingEntry>();
        foreach (var entry in entries)
        {
            if (entry.Key.StartsWith("i:", StringComparison.Ordinal) && Guid.TryParse(entry.ItemId, out var itemId))
            {
                var item = libraryManager.GetItemById(itemId);
                if (item is null)
                {
                    gone.Add(entry.Key);
                    continue;
                }

                if (user is not null && !item.IsVisible(user))
                {
                    continue;
                }
            }

            shown.Add(entry);
        }

        store.RemoveMany(me, gone);

        var friendsData = friends.Snapshot();
        var people = new Dictionary<Guid, Person?>();
        var items = shown.Select(entry => ToDto(entry, friends.AddedByPeople(me, entry.AddedBy, friendsData, people))).ToList();
        return Ok(new { Items = items, Count = items.Count, Max = ReadingListLogic.MaxItems });
    }

    [HttpGet("keys")]
    public IActionResult Keys()
    {
        if (!TryUser(out var me))
        {
            return BadRequest(Error("invalid_user"));
        }

        var keys = store.Keys(me);
        return Ok(new { Keys = keys, Count = keys.Count, Max = ReadingListLogic.MaxItems });
    }

    [HttpPost]
    public IActionResult Add([FromBody] AddBody body)
    {
        if (!TryUser(out var me))
        {
            return BadRequest(Error("invalid_user"));
        }

        if (body is null)
        {
            return BadRequest(Error(ReadingListLogic.Errors.InvalidKey));
        }

        var parse = targets.Resolve(
            new ReadingInput(body.Key, body.Kind, body.ItemId, body.Title, body.Author, body.CoverUrl, body.MangaId),
            userManager.GetUserById(me));
        if (parse.Target is null)
        {
            return parse.Error == ReadingListLogic.Errors.NotFound
                ? NotFound(Error(parse.Error))
                : BadRequest(Error(parse.Error ?? ReadingListLogic.Errors.InvalidKey));
        }

        var (outcome, entry) = store.Add(me, parse.Target, null, DateTime.UtcNow);
        if (outcome == ReadingAddOutcome.Full)
        {
            return Conflict(Error(ReadingListLogic.Errors.ListFull));
        }

        return Ok(new { Added = outcome == ReadingAddOutcome.Added, Item = ToDto(entry, []) });
    }

    [HttpDelete]
    public IActionResult Remove([FromQuery] string? key)
    {
        if (!TryUser(out var me))
        {
            return BadRequest(Error("invalid_user"));
        }

        if (!ReadingListLogic.TryNormalizeKey(key, out var normalized))
        {
            return BadRequest(Error(ReadingListLogic.Errors.InvalidKey));
        }

        return Ok(new { Removed = store.Remove(me, normalized) });
    }

    private static object ToDto(ReadingEntry entry, List<object> addedBy) => new
    {
        entry.Key,
        entry.Kind,
        entry.ItemId,
        entry.MangaId,
        entry.Title,
        entry.Author,
        entry.CoverUrl,
        Cover = ReadingListLogic.CoverFor(entry),
        entry.AddedAt,
        AddedBy = addedBy,
    };

    private static object Error(string code) => new { Error = code };

    private bool TryUser(out Guid userId) =>
        User.TryGetJellyfinUserId(out userId) && userId != Guid.Empty;
}
