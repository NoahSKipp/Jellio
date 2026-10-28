using System;
using System.Collections.Generic;
using Jellio.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

public sealed record LiveChannelReport(bool Ok, string? Error);

/// <summary>
/// Live TV channels that fail to start, as Jellio clients report them, so
/// every client can mark them and skip them when changing channel.
/// </summary>
[ApiController]
[Route("Jellio/LiveHealth")]
[Authorize]
public class LiveChannelHealthController(LiveChannelHealthStore store) : ControllerBase
{
    [HttpGet]
    public ActionResult<Dictionary<string, LiveChannelStatus>> Get() => Ok(store.Broken());

    [HttpPost("{channelId}")]
    public IActionResult Report(string channelId, [FromBody] LiveChannelReport body)
    {
        if (string.IsNullOrWhiteSpace(channelId) || channelId.Length > 64)
        {
            return BadRequest();
        }

        store.Report(channelId, body.Ok, body.Error);
        return Ok();
    }
}
