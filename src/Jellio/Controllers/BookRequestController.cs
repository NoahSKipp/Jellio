using System;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Shelfarr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// Proxies book search and requests through to a self-hosted Shelfarr
/// instance (Services/Shelfarr/ShelfarrClient.cs, real routes confirmed
/// directly against Shelfarr's own Rails source before writing this).
/// A Jellyfin reader never signs into Shelfarr at all: EnsureShelfarrUserAsync
/// below silently provisions one real Shelfarr User per Jellyfin user,
/// the first time they ever request a book, off the same admin-scoped
/// API token every call here already needs configured
/// (PluginConfiguration.cs's own ShelfarrApiToken - only that token's
/// own real Shelfarr login, the admin's, is a login anyone here ever
/// actually uses).
/// </summary>
[ApiController]
[Route("Jellio/books")]
[Authorize]
public class BookRequestController(ShelfarrClient shelfarrClient, ShelfarrUserMapStore userMapStore, IUserManager userManager, ILogger<BookRequestController> logger) : ControllerBase
{
    public record RequestBookBody(string WorkId, string BookType, string? Title, string? Author, string? CoverUrl, string? ContentKind);

    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q, [FromQuery] string? contentKind, [FromQuery] int limit, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return BadRequest("q is required");
        }

        var result = await shelfarrClient.SearchAsync(q, contentKind, limit <= 0 ? 10 : limit, cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            return StatusCode(502, "Shelfarr search failed or is not configured");
        }

        return Ok(result);
    }

    [HttpPost("request")]
    public async Task<IActionResult> RequestBook([FromBody] RequestBookBody body, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (string.IsNullOrWhiteSpace(body.WorkId) || string.IsNullOrWhiteSpace(body.BookType))
        {
            return BadRequest("WorkId and BookType are required");
        }

        var shelfarrUserId = await EnsureShelfarrUserAsync(userId, cancellationToken).ConfigureAwait(false);
        if (shelfarrUserId is null)
        {
            return StatusCode(502, "Could not provision a Shelfarr account for this user");
        }

        var response = await shelfarrClient.CreateRequestAsync(
            shelfarrUserId.Value,
            body.WorkId,
            body.BookType,
            body.Title,
            body.Author,
            body.CoverUrl,
            body.ContentKind,
            userId.ToString("N"),
            cancellationToken).ConfigureAwait(false);

        if (response is null)
        {
            return StatusCode(502, "Shelfarr request failed or is not configured");
        }

        return Ok(response);
    }

    // Provisions a real Shelfarr User exactly once per Jellyfin user
    // (ShelfarrUserMapStore's own cache), off a deterministic username
    // (jellio-{jellyfin user id, no dashes}) so a lost/rebuilt local
    // mapping file never collides with a real pre-existing Shelfarr
    // account by accident. The generated password is thrown away the
    // instant this returns - nothing here, or anywhere else in this
    // plugin, ever needs it again, every future call targets this same
    // user by its own real numeric Shelfarr id instead.
    private async Task<int?> EnsureShelfarrUserAsync(Guid jellyfinUserId, CancellationToken cancellationToken)
    {
        var existing = userMapStore.Get(jellyfinUserId);
        if (existing is not null)
        {
            return existing;
        }

        var jellyfinUser = userManager.GetUserById(jellyfinUserId);
        var displayName = jellyfinUser?.Username ?? "Jellio reader";
        var username = "jellio-" + jellyfinUserId.ToString("N");
        var password = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));

        var created = await shelfarrClient.CreateUserAsync(displayName, username, password, cancellationToken).ConfigureAwait(false);
        if (created is null)
        {
            logger.LogWarning("Jellio: could not provision a Shelfarr user for Jellyfin user {JellyfinUserId}", jellyfinUserId);
            return null;
        }

        userMapStore.Set(jellyfinUserId, created.Id);
        logger.LogInformation("Jellio: provisioned Shelfarr user {ShelfarrUserId} for Jellyfin user {JellyfinUserId}", created.Id, jellyfinUserId);
        return created.Id;
    }

    private Guid GetUserId()
    {
        if (
            HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
