using System;
using System.Collections.Generic;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/next-up-hidden")]
[Authorize]
public class NextUpHiddenController(NextUpHiddenStore store) : ControllerBase
{
    [HttpGet]
    public ActionResult<List<string>> Get()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return Ok(store.Load(userId));
    }

    [HttpPost("{seriesId}")]
    public IActionResult Hide(string seriesId)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        store.Hide(userId, seriesId);
        return Ok();
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
