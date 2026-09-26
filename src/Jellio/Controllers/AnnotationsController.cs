using System;
using System.Collections.Generic;
using System.Security.Claims;
using Jellio.Services.Reading;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Backs the reader's highlights, notes and bookmarks (AnnotationStore).
/// Every call is scoped to the signed-in reader and a book they can see.
/// </summary>
[ApiController]
[Route("Jellio/reading/annotations")]
[Authorize]
public class AnnotationsController(AnnotationStore store, ILibraryManager libraryManager, IUserManager userManager) : ControllerBase
{
    private const int MaxLocatorLength = 2000;
    private const int MaxTextLength = 4000;
    private const int MaxNoteLength = 8000;

    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal) { "highlight", "bookmark" };

    private static readonly HashSet<string> Colors = new(StringComparer.Ordinal) { "yellow", "green", "blue", "pink", "purple" };

    public record AnnotationBody(string Kind, string Locator, double Position, string? Text, string? Note, string? Color, string? Chapter);

    public record AnnotationUpdate(string? Note, string? Color);

    [HttpGet("{itemId}")]
    public IActionResult Get([FromRoute] Guid itemId)
    {
        var userId = GetVisibleBookUser(itemId);
        return userId is null ? NotFound() : Ok(store.Get(userId.Value, itemId));
    }

    [HttpPost("{itemId}")]
    public IActionResult Add([FromRoute] Guid itemId, [FromBody] AnnotationBody body)
    {
        var userId = GetVisibleBookUser(itemId);
        if (userId is null)
        {
            return NotFound();
        }

        if (body is null || !Kinds.Contains(body.Kind ?? string.Empty))
        {
            return BadRequest("Kind must be highlight or bookmark");
        }

        if (string.IsNullOrWhiteSpace(body.Locator) || body.Locator.Length > MaxLocatorLength)
        {
            return BadRequest("Locator is required");
        }

        if (body.Color is not null && !Colors.Contains(body.Color))
        {
            return BadRequest("Unknown color");
        }

        var annotation = store.Add(userId.Value, itemId, new Annotation
        {
            Kind = body.Kind!,
            Locator = body.Locator,
            Position = double.IsFinite(body.Position) ? Math.Clamp(body.Position, 0, 1) : 0,
            Text = Trim(body.Text, MaxTextLength),
            Note = Trim(body.Note, MaxNoteLength),
            Color = body.Kind == "highlight" ? body.Color ?? "yellow" : null,
            Chapter = Trim(body.Chapter, 300),
        });
        return annotation is null ? StatusCode(409, "This book has too many annotations") : Ok(annotation);
    }

    [HttpPut("{itemId}/{id}")]
    public IActionResult Update([FromRoute] Guid itemId, [FromRoute] string id, [FromBody] AnnotationUpdate body)
    {
        var userId = GetVisibleBookUser(itemId);
        if (userId is null)
        {
            return NotFound();
        }

        if (body?.Color is not null && !Colors.Contains(body.Color))
        {
            return BadRequest("Unknown color");
        }

        var annotation = store.Update(userId.Value, itemId, id, Trim(body?.Note, MaxNoteLength), body?.Color);
        return annotation is null ? NotFound() : Ok(annotation);
    }

    [HttpDelete("{itemId}/{id}")]
    public IActionResult Remove([FromRoute] Guid itemId, [FromRoute] string id)
    {
        var userId = GetVisibleBookUser(itemId);
        if (userId is null)
        {
            return NotFound();
        }

        return store.Remove(userId.Value, itemId, id) ? NoContent() : NotFound();
    }

    private static string? Trim(string? text, int max)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.Trim();
        return trimmed.Length > max ? trimmed[..max] : trimmed;
    }

    private Guid? GetVisibleBookUser(Guid itemId)
    {
        if (HttpContext.User.Identity is not ClaimsIdentity identity
            || !Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId))
        {
            return null;
        }

        var user = userManager.GetUserById(userId);
        var item = libraryManager.GetItemById(itemId);
        return user is not null && item is not null && item.IsVisible(user) ? userId : null;
    }
}
