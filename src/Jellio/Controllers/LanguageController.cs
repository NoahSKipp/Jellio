using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Language;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Translation and dictionary lookups for the reader's selection popup
/// (Services/Language/LanguageClient.cs).
/// </summary>
[ApiController]
[Route("Jellio/language")]
[Authorize]
public class LanguageController(LanguageClient languageClient) : ControllerBase
{
    private const int MaxTranslateLength = 1500;
    private const int MaxContextLength = 1000;
    private const int MaxWordLength = 80;

    public record TranslateBody(string Text, string TargetLang, string? SourceLang, string? Context);

    [HttpPost("translate")]
    public async Task<IActionResult> Translate([FromBody] TranslateBody body, CancellationToken cancellationToken)
    {
        var text = body?.Text?.Trim();
        if (string.IsNullOrEmpty(text) || text.Length > MaxTranslateLength)
        {
            return BadRequest("Text must be 1 to " + MaxTranslateLength + " characters");
        }

        if (string.IsNullOrWhiteSpace(body!.TargetLang) || body.TargetLang.Length > 8)
        {
            return BadRequest("TargetLang is required");
        }

        var context = body.Context?.Trim();
        if (context is { Length: > MaxContextLength })
        {
            context = context[..MaxContextLength];
        }

        var result = await languageClient.TranslateAsync(text, body.TargetLang, body.SourceLang, context, cancellationToken).ConfigureAwait(false);
        return Ok(result);
    }

    [HttpGet("define")]
    public async Task<IActionResult> Define([FromQuery] string word, [FromQuery] string? lang, CancellationToken cancellationToken)
    {
        var trimmed = word?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > MaxWordLength)
        {
            return BadRequest("word must be 1 to " + MaxWordLength + " characters");
        }

        var senses = await languageClient.DefineAsync(trimmed, lang, cancellationToken).ConfigureAwait(false);
        return senses is null ? StatusCode(502, "The dictionary could not be reached") : Ok(senses);
    }
}
