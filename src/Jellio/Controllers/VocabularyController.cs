using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Security.Claims;
using System.Text;
using Jellio.Services.Reading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Each reader's vocabulary deck (VocabularyStore): words saved from the
/// reader, flashcard reviews, and CSV/Anki export.
/// </summary>
[ApiController]
[Route("Jellio/vocab")]
[Authorize]
public class VocabularyController(VocabularyStore store) : ControllerBase
{
    private const int MaxWordLength = 200;
    private const int MaxFieldLength = 4000;

    public record VocabBody(
        string Word,
        string? Sentence,
        string? Definition,
        string? Translation,
        string? SourceLang,
        string? TargetLang,
        string? ItemId,
        string? ItemName,
        string? Locator);

    public record VocabUpdate(string? Translation, string? Definition, string? Sentence);

    public record ReviewBody(int Grade);

    [HttpGet]
    public IActionResult GetAll()
    {
        var userId = GetUserId();
        return userId == Guid.Empty ? BadRequest("Invalid user session") : Ok(store.GetAll(userId));
    }

    [HttpGet("due")]
    public IActionResult GetDue([FromQuery] int limit)
    {
        var userId = GetUserId();
        return userId == Guid.Empty ? BadRequest("Invalid user session") : Ok(store.GetDue(userId, limit <= 0 ? 50 : Math.Min(limit, 500)));
    }

    [HttpPost]
    public IActionResult Add([FromBody] VocabBody body)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var word = Clip(body?.Word, MaxWordLength);
        if (word is null)
        {
            return BadRequest("Word is required");
        }

        var entry = store.Add(userId, new VocabEntry
        {
            Word = word,
            Sentence = Clip(body!.Sentence, MaxFieldLength),
            Definition = Clip(body.Definition, MaxFieldLength),
            Translation = Clip(body.Translation, MaxFieldLength),
            SourceLang = Clip(body.SourceLang, 12)?.ToLowerInvariant(),
            TargetLang = Clip(body.TargetLang, 12)?.ToLowerInvariant(),
            ItemId = Clip(body.ItemId, 64),
            ItemName = Clip(body.ItemName, 300),
            Locator = Clip(body.Locator, 2000),
        });
        return entry is null ? StatusCode(409, "Your vocabulary deck is full") : Ok(entry);
    }

    [HttpPut("{id}")]
    public IActionResult Update([FromRoute] string id, [FromBody] VocabUpdate body)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var entry = store.Update(userId, id, Clip(body?.Translation, MaxFieldLength), Clip(body?.Definition, MaxFieldLength), Clip(body?.Sentence, MaxFieldLength));
        return entry is null ? NotFound() : Ok(entry);
    }

    [HttpPost("{id}/review")]
    public IActionResult Review([FromRoute] string id, [FromBody] ReviewBody body)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        if (body is null || body.Grade is < 0 or > 3)
        {
            return BadRequest("Grade must be 0 (again) to 3 (easy)");
        }

        var entry = store.Review(userId, id, body.Grade);
        return entry is null ? NotFound() : Ok(entry);
    }

    [HttpDelete("{id}")]
    public IActionResult Remove([FromRoute] string id)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        return store.Remove(userId, id) ? NoContent() : NotFound();
    }

    // csv: one row per word for spreadsheets. anki: a tab-separated text
    // file Anki imports directly (File > Import), with its header lines
    // naming the separator, HTML fields and a tags column.
    [HttpGet("export")]
    public IActionResult Export([FromQuery] string? format)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var entries = store.GetAll(userId);
        var stamp = DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (string.Equals(format, "anki", StringComparison.OrdinalIgnoreCase))
        {
            var anki = new StringBuilder();
            anki.Append("#separator:tab\n#html:true\n#tags column:3\n");
            foreach (var entry in entries)
            {
                anki.Append(AnkiField(AnkiFront(entry))).Append('\t')
                    .Append(AnkiField(AnkiBack(entry))).Append('\t')
                    .Append(AnkiTags(entry)).Append('\n');
            }

            return File(Encoding.UTF8.GetBytes(anki.ToString()), "text/plain; charset=utf-8", "jellio-vocabulary-" + stamp + ".txt");
        }

        var csv = new StringBuilder();
        csv.Append("Word,Translation,Definition,Sentence,Book,Language,Added\r\n");
        foreach (var entry in entries)
        {
            csv.Append(CsvField(entry.Word)).Append(',')
                .Append(CsvField(entry.Translation)).Append(',')
                .Append(CsvField(entry.Definition)).Append(',')
                .Append(CsvField(entry.Sentence)).Append(',')
                .Append(CsvField(entry.ItemName)).Append(',')
                .Append(CsvField(entry.SourceLang)).Append(',')
                .Append(CsvField(entry.CreatedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))).Append("\r\n");
        }

        // A BOM so Excel opens accented words correctly.
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();
        return File(bytes, "text/csv; charset=utf-8", "jellio-vocabulary-" + stamp + ".csv");
    }

    private static string AnkiFront(VocabEntry entry)
    {
        var front = "<b>" + WebUtility.HtmlEncode(entry.Word) + "</b>";
        if (!string.IsNullOrWhiteSpace(entry.Sentence))
        {
            front += "<br><br><i>" + WebUtility.HtmlEncode(entry.Sentence) + "</i>";
        }

        return front;
    }

    private static string AnkiBack(VocabEntry entry)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(entry.Translation))
        {
            parts.Add("<b>" + WebUtility.HtmlEncode(entry.Translation) + "</b>");
        }

        if (!string.IsNullOrWhiteSpace(entry.Definition))
        {
            parts.Add(WebUtility.HtmlEncode(entry.Definition));
        }

        if (!string.IsNullOrWhiteSpace(entry.ItemName))
        {
            parts.Add("<small>" + WebUtility.HtmlEncode(entry.ItemName) + "</small>");
        }

        return string.Join("<br><br>", parts);
    }

    private static string AnkiTags(VocabEntry entry)
    {
        var tags = new List<string> { "jellio" };
        if (!string.IsNullOrWhiteSpace(entry.SourceLang))
        {
            tags.Add(entry.SourceLang);
        }

        if (!string.IsNullOrWhiteSpace(entry.ItemName))
        {
            tags.Add(new string(entry.ItemName.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray()).Trim('_'));
        }

        return string.Join(' ', tags.Where(t => t.Length > 0));
    }

    // Tabs and newlines would break Anki's line/column format.
    private static string AnkiField(string text) =>
        text.Replace('\t', ' ').Replace("\r", string.Empty, StringComparison.Ordinal).Replace("\n", "<br>", StringComparison.Ordinal);

    private static string CsvField(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        // Spreadsheet formula injection: a cell starting with = + - @ is
        // run as a formula when opened, so it is prefixed to stay text.
        var safe = text.Length > 0 && "=+-@".Contains(text[0], StringComparison.Ordinal) ? "'" + text : text;
        return "\"" + safe.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }

    private static string? Clip(string? text, int max)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.Trim();
        return trimmed.Length > max ? trimmed[..max] : trimmed;
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
