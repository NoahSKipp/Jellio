using System.Collections.Concurrent;
using System.IO.Compression;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/frontend")]
[AllowAnonymous]
public class FrontendController : ControllerBase
{
    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".css"] = "text/css",
        [".js"] = "application/javascript",
        [".woff2"] = "font/woff2",
        [".svg"] = "image/svg+xml",
        [".jpg"] = "image/jpeg",
    };

    // Fonts already ship pre-compressed (woff2's own real container
    // format already is one), a second real compression pass on top of
    // that buys nothing and only costs real CPU for it; every other
    // real content type served here is plain text and compresses well.
    private static readonly HashSet<string> CompressibleExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".css",
        ".js",
        ".svg",
    };

    // The whole assembly is one deployable unit, every embedded file in
    // it changes together whenever a real release changes any of them,
    // so the assembly's own version is already a real, correct ETag
    // basis: identical across every request against the same install,
    // and different the moment a new one is deployed, without hashing
    // file content on every single request to get the same guarantee.
    private static readonly string ETagValue =
        "\"" + (Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0") + "\"";

    // Compressed once per real (resource, encoding) pair rather than
    // on every request: the embedded assembly this reads from is
    // immutable for this whole process's own real lifetime (same real
    // reasoning ETagValue above already relies on), so gzip/brotli
    // compressing jellio.js's own bytes over again on the next request
    // would be real CPU spent recomputing an answer already sitting
    // here from the one before it.
    private static readonly ConcurrentDictionary<string, byte[]?> CompressedCache = new();

    [HttpGet("{**path}")]
    public IActionResult Get(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return NotFound();
        }

        var extension = Path.GetExtension(path);
        if (!ContentTypes.TryGetValue(extension, out var contentType))
        {
            return NotFound();
        }

        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = "Jellio.Frontend." + path.Replace('/', '.');

        // Fonts alone are the real exception: genuinely the same bytes
        // every release. The service logos used to sit here too on the
        // same "same bytes every release" premise, disproven live: one
        // of them got its own real content fixed twice over in a single
        // session, and every reader whose real browser had ever loaded
        // the old one kept it, immutable and un-revalidated, for up to
        // a real year regardless of how many times the file itself
        // changed server side, since these URLs carry no real version
        // suffix at all. Routed through the same real ETag/no-cache
        // path everything else below already uses instead: a cheap 304
        // on every repeat load once a reader's own browser has the
        // current real bytes, a real fresh fetch the moment it does not.
        var cacheable = extension.Equals(".woff2", StringComparison.OrdinalIgnoreCase);

        if (!cacheable)
        {
            // Only jellio.css and jellio.js themselves carry a version
            // query string (IndexHtmlPatchService appends it), every
            // file they pull in from here, every dynamic import() in
            // app.js, is requested at a fixed URL with no version
            // suffix at all, so this is the one real place a new
            // release can be told apart from the one before it for
            // these. A plain "no-cache"/"no-store" response carries no
            // ETag, so a real browser has nothing to send back on a
            // later request and has to download the full file again
            // every single time regardless of which of the two it
            // gets, reported live as this project's own "takes ages to
            // load" on a slow connection once every request really was
            // forced to pay that cost. Serving a real ETag here (the
            // plugin's own version, stable within one release, always
            // different from the release before it) is what actually
            // lets a real 304 happen: fast on every repeat request
            // within the same release, and still exactly as correct as
            // no-store the moment a new one ships, since the ETag
            // itself changes then too.
            Response.Headers.ETag = ETagValue;
            Response.Headers.CacheControl = "no-cache";
            if (Request.Headers.IfNoneMatch == ETagValue)
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }
        }
        else
        {
            Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        }

        // No compression middleware anywhere else in this plugin (it
        // only ever registers its own controllers into the server's
        // shared host, never its own app.UseResponseCompression()), so
        // every real JS/CSS byte used to ship uncompressed regardless
        // of what the browser actually offered to accept. Brotli
        // preferred over gzip when a real reader's own browser sends
        // both, same real preference order every modern browser's own
        // Accept-Encoding header already lists them in.
        var acceptEncoding = Request.Headers.AcceptEncoding.ToString();
        if (CompressibleExtensions.Contains(extension))
        {
            var encoding =
                acceptEncoding.Contains("br", StringComparison.OrdinalIgnoreCase) ? "br" :
                acceptEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase) ? "gzip" :
                null;
            if (encoding is not null)
            {
                var compressed = CompressedCache.GetOrAdd(
                    resourceName + ":" + encoding,
                    _ => Compress(assembly, resourceName, encoding));
                if (compressed is not null)
                {
                    Response.Headers.ContentEncoding = encoding;
                    return File(compressed, contentType);
                }
            }
        }

        var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            return NotFound();
        }

        return File(stream, contentType);
    }

    private static byte[]? Compress(Assembly assembly, string resourceName, string encoding)
    {
        using var source = assembly.GetManifestResourceStream(resourceName);
        if (source is null)
        {
            return null;
        }

        using var output = new MemoryStream();
        using (Stream compressor = encoding == "br"
            ? new BrotliStream(output, CompressionLevel.Optimal, leaveOpen: true)
            : new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            source.CopyTo(compressor);
        }

        return output.ToArray();
    }
}
