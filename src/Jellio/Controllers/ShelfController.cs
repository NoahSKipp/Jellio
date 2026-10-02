using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using Jellio.Services.Reading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// A reader's categories on the Manga, Books and Audiobooks shelves
/// (Mihon style), per-series settings and chapter bookmarks
/// (ShelfStore). Everything here is the caller's own.
/// </summary>
[ApiController]
[Route("Jellio/shelf")]
[Authorize]
public class ShelfController(ShelfStore store) : ControllerBase
{
    private const int MaxKeyLength = 300;
    private const int MaxItemsPerCategory = 10000;

    public record ShelfResponse(IReadOnlyList<ShelfCategory> Categories, Dictionary<string, SeriesPrefs> Series, IReadOnlyList<string> Bookmarks, IReadOnlyCollection<string> Library, IReadOnlyList<string> LibraryRemoved);

    public record CreateBody(string? Name);

    public record UpdateBody(string? Name, string? Sort, bool? Descending);

    public record OrderBody(List<string>? Ids);

    public record MembershipBody(List<string>? Keys, List<string>? CategoryIds, List<string>? AddTo, List<string>? RemoveFrom);

    public record SeriesBody(string? Key, string? Note, bool? ChapterDescending, string? ChapterFilter, string? ComicLayout, string? ComicDirection, List<string>? ExcludedScanlators = null, bool? DuplicatesAsOne = null);

    public record BookmarkBody(bool Bookmarked);

    public record LibraryBody(string? Key, bool InLibrary);

    [HttpGet("{kind}")]
    public IActionResult Get(string kind)
    {
        if (!TryUser(out var userId) || !IsKind(kind))
        {
            return BadRequest("Unknown shelf");
        }

        var data = store.Load(userId);
        return Ok(new ShelfResponse(data.Categories.Where(category => category.Kind == kind).ToList(), data.Series, data.Bookmarks, store.Library(userId), data.LibraryRemoved));
    }

    [HttpPost("{kind}/categories")]
    public IActionResult Create(string kind, [FromBody] CreateBody body)
    {
        var name = ShelfStore.CleanName(body?.Name);
        if (!TryUser(out var userId) || !IsKind(kind) || name.Length == 0)
        {
            return BadRequest("Give the category a name");
        }

        ShelfCategory? created = null;
        string? error = null;
        store.Update(userId, data =>
        {
            var mine = data.Categories.Where(category => category.Kind == kind).ToList();
            if (mine.Count >= ShelfStore.MaxCategories)
            {
                error = "That's as many categories as a shelf can have";
            }
            else if (mine.Any(category => string.Equals(category.Name, name, StringComparison.OrdinalIgnoreCase)))
            {
                error = "There's already a category called " + name;
            }
            else
            {
                created = new ShelfCategory { Id = ShelfStore.NewId(), Kind = kind, Name = name };
                data.Categories.Add(created);
            }
        });
        return created is null ? BadRequest(error) : Ok(created);
    }

    [HttpPatch("categories/{id}")]
    public IActionResult UpdateCategory(string id, [FromBody] UpdateBody body)
    {
        if (!TryUser(out var userId) || body is null)
        {
            return BadRequest("Invalid request");
        }

        var name = body.Name is null ? null : ShelfStore.CleanName(body.Name);
        if (name is { Length: 0 } || (body.Sort is not null && !ShelfStore.Sorts.Contains(body.Sort)))
        {
            return BadRequest("Invalid name or sort");
        }

        ShelfCategory? updated = null;
        string? error = null;
        store.Update(userId, data =>
        {
            var category = data.Categories.FirstOrDefault(entry => entry.Id == id);
            if (category is null)
            {
                return;
            }

            if (name is not null && data.Categories.Any(other => other != category && other.Kind == category.Kind && string.Equals(other.Name, name, StringComparison.OrdinalIgnoreCase)))
            {
                error = "There's already a category called " + name;
                return;
            }

            category.Name = name ?? category.Name;
            category.Sort = body.Sort ?? category.Sort;
            category.Descending = body.Descending ?? category.Descending;
            updated = category;
        });
        if (error is not null)
        {
            return BadRequest(error);
        }

        return updated is null ? NotFound() : Ok(updated);
    }

    [HttpDelete("categories/{id}")]
    public IActionResult Delete(string id)
    {
        if (!TryUser(out var userId))
        {
            return BadRequest("Invalid user session");
        }

        var removed = false;
        store.Update(userId, data => removed = data.Categories.RemoveAll(category => category.Id == id) > 0);
        return removed ? Ok() : NotFound();
    }

    [HttpPut("{kind}/order")]
    public IActionResult Order(string kind, [FromBody] OrderBody body)
    {
        if (!TryUser(out var userId) || !IsKind(kind) || body?.Ids is null)
        {
            return BadRequest("Invalid request");
        }

        store.Update(userId, data =>
        {
            var mine = data.Categories.Where(category => category.Kind == kind).ToList();
            var ordered = body.Ids
                .Select(id => mine.FirstOrDefault(category => category.Id == id))
                .OfType<ShelfCategory>()
                .Distinct()
                .ToList();
            ordered.AddRange(mine.Where(category => !ordered.Contains(category)));
            data.Categories.RemoveAll(category => category.Kind == kind);
            data.Categories.AddRange(ordered);
        });
        return Ok();
    }

    // Keys go into exactly CategoryIds (the categories dialog), or are
    // added to / removed from the listed ones (a batch move).
    [HttpPut("{kind}/membership")]
    public IActionResult Membership(string kind, [FromBody] MembershipBody body)
    {
        var keys = body?.Keys?.Where(ValidKey).Distinct().ToList();
        if (!TryUser(out var userId) || !IsKind(kind) || keys is null || keys.Count == 0)
        {
            return BadRequest("Invalid request");
        }

        store.Update(userId, data =>
        {
            foreach (var category in data.Categories.Where(category => category.Kind == kind))
            {
                var add = body!.CategoryIds is not null ? body.CategoryIds.Contains(category.Id) : body.AddTo?.Contains(category.Id) == true;
                var remove = body.CategoryIds is not null ? !add : body.RemoveFrom?.Contains(category.Id) == true;
                if (add)
                {
                    foreach (var key in keys.Where(key => !category.Items.Contains(key)))
                    {
                        if (category.Items.Count < MaxItemsPerCategory)
                        {
                            category.Items.Add(key);
                        }
                    }
                }
                else if (remove)
                {
                    category.Items.RemoveAll(keys.Contains);
                }
            }
        });
        return Ok();
    }

    [HttpPut("series")]
    public IActionResult Series([FromBody] SeriesBody body)
    {
        if (!TryUser(out var userId) || body is null || !ValidKey(body.Key))
        {
            return BadRequest("Invalid request");
        }

        if ((body.ChapterFilter is not null && body.ChapterFilter is not ("all" or "unread" or "bookmarked"))
            || (body.ComicLayout is not null && body.ComicLayout is not ("" or "single" or "spread" or "paged-vertical" or "vertical" or "vertical-gaps"))
            || (body.ComicDirection is not null && body.ComicDirection is not ("" or "rtl" or "ltr")))
        {
            return BadRequest("Invalid setting");
        }

        SeriesPrefs? prefs = null;
        store.Update(userId, data =>
        {
            prefs = data.Series.GetValueOrDefault(body.Key!) ?? new SeriesPrefs();
            if (body.Note is not null)
            {
                var note = body.Note.Trim();
                prefs.Note = note.Length == 0 ? null : note.Length > ShelfStore.MaxNoteLength ? note[..ShelfStore.MaxNoteLength] : note;
            }

            prefs.ChapterDescending = body.ChapterDescending ?? prefs.ChapterDescending;
            prefs.ChapterFilter = body.ChapterFilter ?? prefs.ChapterFilter;
            prefs.ComicLayout = body.ComicLayout is null ? prefs.ComicLayout : body.ComicLayout.Length == 0 ? null : body.ComicLayout;
            prefs.ComicDirection = body.ComicDirection is null ? prefs.ComicDirection : body.ComicDirection.Length == 0 ? null : body.ComicDirection;
            if (body.ExcludedScanlators is not null)
            {
                var names = body.ExcludedScanlators
                    .Select(name => (name ?? string.Empty).Trim())
                    .Where(name => name.Length > 0)
                    .Select(name => name.Length > ShelfStore.MaxNameLength * 3 ? name[..(ShelfStore.MaxNameLength * 3)] : name)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Take(200)
                    .ToList();
                prefs.ExcludedScanlators = names.Count == 0 ? null : names;
            }

            prefs.DuplicatesAsOne = body.DuplicatesAsOne ?? prefs.DuplicatesAsOne;
            data.Series[body.Key!] = prefs;
        });
        return Ok(prefs);
    }

    // A manga series on or off the reader's shelf.
    [HttpPut("library")]
    public IActionResult Library([FromBody] LibraryBody body)
    {
        if (!TryUser(out var userId) || body is null || !ValidKey(body.Key) || !body.Key!.StartsWith("s:", StringComparison.Ordinal))
        {
            return BadRequest("Invalid request");
        }

        store.SetInLibrary(userId, body.Key, body.InLibrary);
        return Ok();
    }

    [HttpPut("bookmarks/{itemId}")]
    public IActionResult Bookmark(Guid itemId, [FromBody] BookmarkBody body)
    {
        if (!TryUser(out var userId) || body is null)
        {
            return BadRequest("Invalid request");
        }

        var key = itemId.ToString("N");
        store.Update(userId, data =>
        {
            data.Bookmarks.Remove(key);
            if (body.Bookmarked)
            {
                data.Bookmarks.Add(key);
            }
        });
        return Ok();
    }

    private static bool IsKind(string kind) => ShelfStore.Kinds.Contains(kind);

    private static bool ValidKey(string? key) =>
        key is { Length: > 2 and <= MaxKeyLength } && (key.StartsWith("s:", StringComparison.Ordinal) || key.StartsWith("i:", StringComparison.Ordinal));

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }
}
