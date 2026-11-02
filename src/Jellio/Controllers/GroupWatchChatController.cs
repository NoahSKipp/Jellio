using System;
using System.Linq;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/groupwatch")]
[Authorize]
public class GroupWatchChatController(GroupWatchChatService chatService, Jellio.Services.Parties.PartyService parties, IUserManager userManager) : ControllerBase
{
    public record SendRequest(string Text, Guid? ItemId = null, long? ReplyToId = null);

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
            m.ReplyToId,
            m.ReplyToName,
            m.ReplyToText,
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
        var message = chatService.Add(groupId, userId, userName, text, request.ItemId, request.ReplyToId);
        if (request.ItemId == null && GroupWatchChatService.IsReaction(text))
        {
            parties.CountReaction(groupId, text);
        }

        return Ok(message);
    }

    private Guid GetUserId()
    {
        if (
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
