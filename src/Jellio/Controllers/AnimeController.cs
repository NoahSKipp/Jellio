using System.Linq;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

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
