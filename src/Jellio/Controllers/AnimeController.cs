using System.Linq;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Which titles are anime (Services/AnimeCatalog.cs). Anime lives in the
/// Movies and Shows libraries too, so Jellio and Jellio TV use this list
/// to keep it to the Anime library and out of everything else.
/// </summary>
[ApiController]
[Route("Jellio/anime")]
[Authorize]
public class AnimeController(ILibraryManager libraryManager) : ControllerBase
{
    [HttpGet("ids")]
    public IActionResult Ids()
    {
        var ids = AnimeCatalog.GetIds(libraryManager).Select(id => id.ToString("N")).ToList();
        return Ok(new { Ids = ids });
    }
}
