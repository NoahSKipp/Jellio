using System;
using System.Linq;
using System.Security.Claims;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Manga;
using Jellio.Services.Reading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Mihon-style tracking on AniList: a reader links their list with a
/// token (kept on the server, never sent back), links a series to an
/// AniList entry, and the chapters they've read are written to it.
/// </summary>
[ApiController]
[Route("Jellio/tracker/anilist")]
[Authorize]
public partial class TrackerController(
    TrackerStore trackerStore,
    AniListTrackerClient anilist,
    AniListClient anilistSearch,
    MangaStreamService stream,
    ReadingProgressStore progressStore) : ControllerBase
{
    private const double Finished = 0.98;

    public record ConnectBody(string? Token);

    public record LinkBody(string? Key, int MediaId, string? Title, string? CoverUrl);

    public record EntryBody(string? Key, string? Status, int? ScoreRaw);

    public record SyncBody(string? Key, int? MangaId, int? Episode);

    [HttpGet]
    public IActionResult Status()
    {
        var clientId = JellioPlugin.Instance!.Configuration.AniListClientId?.Trim() ?? string.Empty;
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var data = trackerStore.Load(userId);
        return Ok(new
        {
            Available = clientId.Length > 0,
            ClientId = clientId,
            Connected = !string.IsNullOrEmpty(data.AniListToken),
            UserName = data.AniListName,
        });
    }

    [HttpPost("connect")]
    public async Task<IActionResult> Connect([FromBody] ConnectBody body, CancellationToken cancellationToken)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        // The pasted text can be the bare token or the whole address AniList
        // sent the browser to, with the token in it.
        var text = (body.Token ?? string.Empty).Trim();
        var match = AccessToken().Match(text);
        var token = match.Success ? match.Groups[1].Value : text;
        if (token.Length < 20 || token.Length > 4000 || token.Any(char.IsWhiteSpace))
        {
            return BadRequest("That doesn't look like an AniList token.");
        }

        var name = await anilist.GetViewerNameAsync(token, cancellationToken).ConfigureAwait(false);
        if (name is null)
        {
            return BadRequest("AniList didn't accept that token.");
        }

        trackerStore.Update(userId, data =>
        {
            data.AniListToken = token;
            data.AniListName = name;
        });
        return Ok(new { Connected = true, UserName = name });
    }

    [HttpDelete]
    public IActionResult Disconnect()
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        trackerStore.Update(userId, data =>
        {
            data.AniListToken = null;
            data.AniListName = null;
        });
        return NoContent();
    }

    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q, [FromQuery] string? type, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(q) || q.Length > 200)
        {
            return Ok(Array.Empty<object>());
        }

        var mediaType = string.Equals(type, "ANIME", StringComparison.OrdinalIgnoreCase) ? "ANIME" : "MANGA";
        var results = await anilistSearch.BrowseAsync("SEARCH_MATCH", null, null, q.Trim(), 0, cancellationToken, mediaType).ConfigureAwait(false);
        return results is null
            ? StatusCode(502, "AniList could not be reached")
            : Ok(results.Take(12).Select(series => new { series.Id, series.Title, series.Year, series.CoverUrl }));
    }

    // Where a series stands: its link and the entry on the reader's list.
    [HttpGet("link")]
    public async Task<IActionResult> GetLink([FromQuery] string key, CancellationToken cancellationToken)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var data = trackerStore.Load(userId);
        if (string.IsNullOrEmpty(key) || !data.Links.TryGetValue(key, out var link))
        {
            return Ok(new { Link = (TrackLink?)null, Entry = (TrackEntry?)null });
        }

        var entry = string.IsNullOrEmpty(data.AniListToken)
            ? null
            : await anilist.GetEntryAsync(data.AniListToken, link.MediaId, cancellationToken).ConfigureAwait(false);
        return Ok(new { Link = link, Entry = entry });
    }

    [HttpPut("link")]
    public IActionResult SetLink([FromBody] LinkBody body)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        if (string.IsNullOrEmpty(body.Key) || !body.Key.StartsWith("s:", StringComparison.Ordinal) || body.Key.Length > 300 || body.MediaId <= 0)
        {
            return BadRequest();
        }

        var title = (body.Title ?? string.Empty).Trim();
        trackerStore.Update(userId, data => data.Links[body.Key] = new TrackLink
        {
            MediaId = body.MediaId,
            Title = title.Length > 200 ? title[..200] : title,
            CoverUrl = body.CoverUrl is { Length: <= 500 } cover && cover.StartsWith("https://", StringComparison.Ordinal) ? cover : null,
        });
        return NoContent();
    }

    [HttpDelete("link")]
    public IActionResult RemoveLink([FromQuery] string key)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        trackerStore.Update(userId, data => data.Links.Remove(key ?? string.Empty));
        return NoContent();
    }

    // Status and score, as the reader picks them.
    [HttpPut("entry")]
    public async Task<IActionResult> SetEntry([FromBody] EntryBody body, CancellationToken cancellationToken)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var data = trackerStore.Load(userId);
        if (string.IsNullOrEmpty(data.AniListToken) || string.IsNullOrEmpty(body.Key) || !data.Links.TryGetValue(body.Key, out var link))
        {
            return BadRequest();
        }

        if (body.Status is not null && !AniListTrackerClient.Statuses.Contains(body.Status))
        {
            return BadRequest();
        }

        if (body.ScoreRaw is < 0 or > 100)
        {
            return BadRequest();
        }

        var saved = await anilist.SaveAsync(data.AniListToken, link.MediaId, body.Status, null, body.ScoreRaw, cancellationToken).ConfigureAwait(false);
        return saved is null ? StatusCode(502, "AniList didn't take that") : Ok(saved);
    }

    // Writes the highest chapter or episode the reader has finished to AniList, never
    // lowering what is already there. Quiet when nothing is linked.
    [HttpPost("sync")]
    public async Task<IActionResult> Sync([FromBody] SyncBody body, CancellationToken cancellationToken)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var data = trackerStore.Load(userId);
        if (string.IsNullOrEmpty(data.AniListToken) || string.IsNullOrEmpty(body.Key) || !data.Links.TryGetValue(body.Key, out var link))
        {
            return Ok(new { Synced = false });
        }

        int furthest = 0;
        if (body.Episode is > 0)
        {
            furthest = body.Episode.Value;
        }
        else if (body.MangaId is > 0)
        {
            var series = await stream.GetSeriesAsync(body.MangaId.Value, cancellationToken).ConfigureAwait(false);
            if (series is null)
            {
                return Ok(new { Synced = false });
            }

            var progress = progressStore.GetAll(userId);
            furthest = series.Chapters
                .Where(chapter => chapter.Number >= 0 && progress.TryGetValue(chapter.Id, out var record) && record.Progress >= Finished)
                .Select(chapter => (int)Math.Floor(chapter.Number))
                .DefaultIfEmpty(0)
                .Max();
        }
        else
        {
            return Ok(new { Synced = false });
        }

        var entry = await anilist.GetEntryAsync(data.AniListToken, link.MediaId, cancellationToken).ConfigureAwait(false);
        if (entry is null)
        {
            return Ok(new { Synced = false });
        }

        if (furthest <= entry.Progress)
        {
            return Ok(new { Synced = false, Entry = entry });
        }

        // Reading or watching something on a plan-to-read or dropped list puts it back
        // on the active list, like Mihon.
        var status = entry.Status is null or "PLANNING" or "DROPPED" or "PAUSED" ? "CURRENT" : null;
        var saved = await anilist.SaveAsync(data.AniListToken, link.MediaId, status, furthest, null, cancellationToken).ConfigureAwait(false);
        return Ok(new { Synced = saved is not null, Entry = saved });
    }

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }

    [GeneratedRegex("access_token=([^&\\s]+)", RegexOptions.CultureInvariant)]
    private static partial Regex AccessToken();
}
