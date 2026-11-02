using System;
using Jellio.Services.Grouplist;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/grouplist")]
[Authorize]
public class GrouplistController(GrouplistStore store) : ControllerBase
{
    [HttpGet]
    public IActionResult GetMine()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(new { ItemIds = store.Load(userId) });
    }

    [HttpPost("{itemId:guid}")]
    public IActionResult Add(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(new { ItemIds = store.Add(userId, itemId) });
    }

    [HttpDelete("{itemId:guid}")]
    public IActionResult Remove(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(new { ItemIds = store.Remove(userId, itemId) });
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
