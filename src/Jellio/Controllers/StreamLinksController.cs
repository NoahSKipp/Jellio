using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Claims;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.StreamLinks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

public sealed record StreamLinkRequest(string? Url, string? Name);

public sealed record StreamLinkRenameRequest(string? Name);

public sealed record StreamLinkPlayReport(bool Ok);

/// <summary>
/// Streams a user adds by link: a playlist, a channel list or a page with
/// a player on it. Saved per user and shown in Live TV.
/// </summary>
[ApiController]
[Route("Jellio/StreamLinks")]
[Authorize]
public class StreamLinksController(
    StreamLinkStore store,
    StreamLinkResolver resolver,
    StreamProxySigner signer,
    StreamPairingService pairing,
    StreamLinkHealthService health,
    ILogger<StreamLinksController> logger) : ControllerBase
{
    private const int MaxPlaylistBytes = 4 * 1024 * 1024;
    private static readonly SemaphoreSlim ResolveSlots = new(8);

    [HttpGet]
    public IActionResult List()
    {
        var userId = GetUserId();
        return userId == Guid.Empty ? Unauthorized() : Ok(store.List(userId));
    }

    [HttpPost]
    public async Task<IActionResult> Add([FromBody] StreamLinkRequest body, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        return await AddForUser(userId, body, cancellationToken).ConfigureAwait(false);
    }

    [HttpPost("{id}/refresh")]
    public async Task<IActionResult> Refresh(string id, CancellationToken cancellationToken)
    {
        var userId = GetUserId();
        var link = store.Get(userId, id);
        if (link == null || !Uri.TryCreate(link.SourceUrl, UriKind.Absolute, out var source))
        {
            return NotFound();
        }

        try
        {
            var resolved = await Resolve(source, cancellationToken, useCache: false).ConfigureAwait(false);
            return Ok(store.Refresh(userId, id, resolved));
        }
        catch (StreamLinkException err)
        {
            // Checked by hand: shows as not working straight away.
            store.RecordCheck(userId, id, err.Code, failuresBeforeFailing: 1);
            return Failure(err);
        }
    }

    // A play that worked or failed in a client counts like a check.
    [HttpPost("{id}/report")]
    public IActionResult Report(string id, [FromBody] StreamLinkPlayReport body)
    {
        var userId = GetUserId();
        if (store.Get(userId, id) == null)
        {
            return NotFound();
        }

        health.RecordPlay(userId, id, body.Ok);
        return Ok();
    }

    [HttpDelete("{id}/entries/{index:int}")]
    public IActionResult RemoveEntry(string id, int index) => store.RemoveEntry(GetUserId(), id, index) ? Ok() : NotFound();

    [HttpPost("{id}/rename")]
    public IActionResult Rename(string id, [FromBody] StreamLinkRenameRequest body)
    {
        var name = CleanName(body.Name);
        if (name == null)
        {
            return BadRequest();
        }

        return store.Rename(GetUserId(), id, name) ? Ok() : NotFound();
    }

    [HttpDelete("{id}")]
    public IActionResult Remove(string id) => store.Remove(GetUserId(), id) ? Ok() : NotFound();

    // Resolved fresh each time: stream addresses often carry a token that
    // expires.
    [HttpPost("{id}/play")]
    public async Task<IActionResult> Play(string id, [FromQuery] int? entry, CancellationToken cancellationToken)
    {
        var link = store.Get(GetUserId(), id);
        if (link == null)
        {
            return NotFound();
        }

        string target;
        string name;
        if (link.Kind == StreamLinkKinds.Playlist)
        {
            if (entry is not { } index || index < 0 || index >= link.Entries.Count)
            {
                return NotFound();
            }

            target = link.Entries[index].Url;
            name = link.Entries[index].Name;
        }
        else
        {
            target = link.SourceUrl;
            name = link.Name;
        }

        if (!PublicAddressGuard.TryParseLink(target, out var targetUri))
        {
            return Failure(new StreamLinkException(StreamLinkErrors.InvalidUrl));
        }

        try
        {
            var resolved = await Resolve(targetUri, cancellationToken).ConfigureAwait(false);
            if (resolved.Stream == null && resolved.Entries is { Count: > 0 } nested
                && PublicAddressGuard.TryParseLink(nested[0].Url, out var first))
            {
                resolved = await Resolve(first, cancellationToken).ConfigureAwait(false);
            }

            var stream = resolved.Stream ?? throw new StreamLinkException(StreamLinkErrors.NoStream);
            var expires = DateTimeOffset.UtcNow.Add(StreamProxySigner.Lifetime).ToUnixTimeSeconds();
            return Ok(new
            {
                Name = name,
                Format = stream.Format,
                Mime = stream.Format switch
                {
                    StreamFormats.Hls => "application/x-mpegURL",
                    StreamFormats.Ts => "video/mp2t",
                    StreamFormats.Mp4 => "video/mp4",
                    _ => null,
                },
                DirectUrl = stream.Url.AbsoluteUri,
                Referer = stream.Referer?.AbsoluteUri,
                UserAgent = StreamLinkResolver.BrowserUserAgent,
                ProxyPath = "Jellio/StreamLinks/" + signer.ProxyQuery(stream.Url, stream.Referer, expires),
            });
        }
        catch (StreamLinkException err)
        {
            return Failure(err);
        }
    }

    // Streams a link through the server, for players that can't reach it
    // themselves (another origin, a missing Referer, http on an https page).
    [HttpGet("proxy")]
    [AllowAnonymous]
    public async Task Proxy([FromQuery] string? u, [FromQuery] string? r, [FromQuery] long e, [FromQuery] string? s)
    {
        var ct = HttpContext.RequestAborted;
        u ??= string.Empty;
        r ??= string.Empty;
        if (!signer.Verify(u, r, e, s, DateTimeOffset.UtcNow) || !Uri.TryCreate(u, UriKind.Absolute, out var target))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        Uri? referer = r.Length > 0 && Uri.TryCreate(r, UriKind.Absolute, out var parsedReferer) ? parsedReferer : null;
        using var request = StreamLinkResolver.BuildRequest(target, referer);
        if (Request.Headers.Range.Count > 0)
        {
            request.Headers.TryAddWithoutValidation("Range", Request.Headers.Range.ToString());
        }

        HttpResponseMessage upstream;
        try
        {
            upstream = await resolver.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        }
        catch (Exception err) when (err is HttpRequestException or OperationCanceledException)
        {
            if (!ct.IsCancellationRequested)
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
            }

            return;
        }

        using (upstream)
        {
            Response.StatusCode = (int)upstream.StatusCode;
            Response.Headers.CacheControl = "no-store";
            if (!upstream.IsSuccessStatusCode)
            {
                return;
            }

            var finalUri = upstream.RequestMessage?.RequestUri ?? target;
            var contentType = upstream.Content.Headers.ContentType?.MediaType ?? string.Empty;
            var maybePlaylist = contentType.Contains("mpegurl", StringComparison.OrdinalIgnoreCase)
                || StreamLinkParser.FormatFromPath(finalUri) == StreamFormats.Hls;
            await using var body = await upstream.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            try
            {
                if (maybePlaylist)
                {
                    var bytes = await ReadLimited(body, MaxPlaylistBytes, ct).ConfigureAwait(false);
                    var text = Encoding.UTF8.GetString(bytes);
                    if (StreamLinkParser.IsHlsPlaylist(text))
                    {
                        var rewritten = StreamLinkParser.RewritePlaylist(text, finalUri, child => signer.ProxyQuery(child, referer, e));
                        Response.ContentType = "application/vnd.apple.mpegurl";
                        await Response.WriteAsync(rewritten, ct).ConfigureAwait(false);
                        return;
                    }

                    Response.ContentType = string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType;
                    await Response.Body.WriteAsync(bytes, ct).ConfigureAwait(false);
                    return;
                }

                Response.ContentType = string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType;
                if (upstream.Content.Headers.ContentLength is { } length)
                {
                    Response.ContentLength = length;
                }

                if (upstream.Content.Headers.ContentRange != null)
                {
                    Response.Headers.ContentRange = upstream.Content.Headers.ContentRange.ToString();
                }

                if (upstream.Headers.AcceptRanges.Count > 0)
                {
                    Response.Headers.AcceptRanges = string.Join(",", upstream.Headers.AcceptRanges);
                }

                await body.CopyToAsync(Response.Body, 64 * 1024, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (IOException)
            {
                // The player went away or the source dropped mid-stream.
            }
        }
    }

    [HttpPost("pair")]
    public IActionResult CreatePairing()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var created = pairing.Create(userId);
        return Ok(new { created.Code, created.ExpiresAt, Path = "Jellio/add?c=" + created.Code });
    }

    [HttpGet("pair/{code}")]
    public IActionResult PairingStatus(string code)
    {
        var found = pairing.Status(GetUserId(), code);
        if (found == null)
        {
            return NotFound();
        }

        return Ok(new { Status = found.LinkId == null ? "waiting" : "added", found.LinkId, found.LinkName });
    }

    [HttpGet("pair/{code}/check")]
    [AllowAnonymous]
    public IActionResult CheckPairing(string code)
    {
        if (pairing.IsThrottled(ClientKey()))
        {
            return StatusCode(StatusCodes.Status429TooManyRequests);
        }

        return pairing.TryOpen(code, ClientKey(), out _) ? Ok() : NotFound();
    }

    // The phone side: no Jellyfin sign-in, the code stands in for it.
    [HttpPost("pair/{code}/submit")]
    [AllowAnonymous]
    public async Task<IActionResult> SubmitPairing(string code, [FromBody] StreamLinkRequest body, CancellationToken cancellationToken)
    {
        if (pairing.IsThrottled(ClientKey()))
        {
            return StatusCode(StatusCodes.Status429TooManyRequests);
        }

        if (!pairing.TryOpen(code, ClientKey(), out var found))
        {
            return NotFound(new { Error = "invalid_code" });
        }

        var result = await AddForUser(found.OwnerId, body, cancellationToken).ConfigureAwait(false);
        if (result is OkObjectResult { Value: StreamLink link })
        {
            pairing.Complete(found, link);
            return Ok(new { link.Id, link.Name, link.Kind, Channels = link.Entries.Count });
        }

        return result;
    }

    private async Task<IActionResult> AddForUser(Guid userId, StreamLinkRequest body, CancellationToken cancellationToken)
    {
        if (!PublicAddressGuard.TryParseLink(body.Url, out var source))
        {
            return Failure(new StreamLinkException(StreamLinkErrors.InvalidUrl));
        }

        try
        {
            var resolved = await Resolve(source, cancellationToken, useCache: false).ConfigureAwait(false);
            var name = CleanName(body.Name) ?? CleanName(resolved.Title) ?? source.Host;
            return Ok(store.Add(userId, source.AbsoluteUri, name, resolved));
        }
        catch (StreamLinkException err)
        {
            return Failure(err);
        }
    }

    private async Task<ResolveResult> Resolve(Uri url, CancellationToken cancellationToken, bool useCache = true)
    {
        if (!await ResolveSlots.WaitAsync(TimeSpan.FromSeconds(20), cancellationToken).ConfigureAwait(false))
        {
            throw new StreamLinkException(StreamLinkErrors.Timeout);
        }

        try
        {
            return await resolver.ResolveAsync(url, cancellationToken, useCache).ConfigureAwait(false);
        }
        finally
        {
            ResolveSlots.Release();
        }
    }

    private IActionResult Failure(StreamLinkException err)
    {
        logger.LogInformation("Jellio stream link failed: {Code}", err.Code);
        return UnprocessableEntity(new { Error = err.Code });
    }

    private static string? CleanName(string? name)
    {
        var trimmed = (name ?? string.Empty).Trim();
        return trimmed.Length == 0 ? null : trimmed.Length > 80 ? trimmed[..80] : trimmed;
    }

    private static async Task<byte[]> ReadLimited(Stream stream, int limit, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        while (buffer.Length < limit)
        {
            var read = await stream.ReadAsync(chunk, ct).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }

    private string ClientKey() => HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

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

/// <summary>
/// The page a TV's QR code opens on a phone: paste a link and it shows up
/// on the TV.
/// </summary>
[ApiController]
[Route("Jellio/add")]
[AllowAnonymous]
public class StreamLinkAddPageController : ControllerBase
{
    private static readonly Lazy<string> Page = new(() =>
    {
        using var stream = typeof(StreamLinkAddPageController).Assembly.GetManifestResourceStream("Jellio.Frontend.streams.add.html");
        using var reader = new StreamReader(stream!);
        return reader.ReadToEnd();
    });

    [HttpGet]
    public IActionResult Get()
    {
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        return Content(Page.Value, "text/html; charset=utf-8");
    }
}
