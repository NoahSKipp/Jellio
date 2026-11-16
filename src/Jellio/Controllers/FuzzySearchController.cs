using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Extensions;
using Jellio.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/search/fuzzy")]
[Authorize]
public class FuzzySearchController(
    FuzzySearchService fuzzySearchService,
    IUserManager userManager) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Search(
        [FromQuery] string? query,
        [FromQuery] Guid? userId = null,
        [FromQuery] int limit = 24,
        [FromQuery] string[]? includeItemTypes = null,
        CancellationToken ct = default)
    {
        var targetUserId = userId.HasValue && userId.Value != Guid.Empty
            ? userId.Value
            : (User.TryGetJellyfinUserId(out var id) ? id : Guid.Empty);

        var user = targetUserId != Guid.Empty ? userManager.GetUserById(targetUserId) : null;
        user ??= userManager.GetUsers().FirstOrDefault();
        if (user == null)
        {
            return Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(query))
        {
            return Ok(new
            {
                Items = Array.Empty<object>(),
                CorrectedQuery = (string?)null,
                Confidence = 0.0,
            });
        }

        var result = await fuzzySearchService.SearchWithExternalFallbackAsync(
            query,
            user.Id,
            Math.Clamp(limit, 1, 100),
            includeItemTypes,
            ct).ConfigureAwait(false);

        return Ok(new
        {
            Items = result.Items,
            CorrectedQuery = result.CorrectedQuery,
            Confidence = result.TopScore,
        });
    }
}
