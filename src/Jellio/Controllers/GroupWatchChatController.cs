using System;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Chat for a real Jellyfin SyncPlay group, backed by GroupWatchChatService's
/// own in memory room list. Same real trust model NowPlayingController's own
/// header already states: any authenticated user, not scoped to real group
/// membership server side, since this whole feature is a small friends-only
/// room in practice and every real GroupId a client ever has came from its
/// own GET /SyncPlay/List first, same as that endpoint's own real access.
/// </summary>
[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchChatController(GroupWatchChatService chatService, IUserManager userManager) : ControllerBase
{
    public record SendRequest(string Text, Guid? ItemId = null);

    [HttpGet("{groupId}/messages")]
    public IActionResult GetMessages([FromRoute] Guid groupId, [FromQuery] long after = 0)
    {
        var messages = chatService.Since(groupId, after).Select(m => new
        {
            m.Id,
            m.UserId,
            m.UserName,
            m.Text,
            m.Timestamp,
            m.ItemId,
        });

        return Ok(messages);
    }

    [HttpPost("{groupId}/messages")]
    public IActionResult SendMessage([FromRoute] Guid groupId, [FromBody] SendRequest request)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var text = (request.Text ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return BadRequest("Message text is required");
        }

        if (text.Length > 500)
        {
            text = text[..500];
        }

        var userName = userManager.GetUserById(userId)?.Username ?? "Someone";
        var message = chatService.Add(groupId, userId, userName, text, request.ItemId);
        return Ok(message);
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
