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

    private static readonly HashSet<string> CompressibleExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".css",
        ".js",
        ".svg",
    };

    private static readonly string ETagValue =
        "\"" + (Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0") + "\"";

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

        if (path.Equals("sw.js", StringComparison.OrdinalIgnoreCase))
        {
            Response.Headers["Service-Worker-Allowed"] = "/";
        }

        var hasVersionParam = Request.Query.ContainsKey("v");
        var cacheable = hasVersionParam || extension.Equals(".woff2", StringComparison.OrdinalIgnoreCase);

        if (!cacheable)
        {
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
                    path + ":" + encoding,
                    _ => Compress(path, encoding));
                if (compressed is not null)
                {
                    Response.Headers.ContentEncoding = encoding;
                    return File(compressed, contentType);
                }
            }
        }

        var content = Jellio.Services.FrontendAssets.Read(path);
        return content is null ? NotFound() : File(content, contentType);
    }

    private static byte[]? Compress(string path, string encoding)
    {
        var content = Jellio.Services.FrontendAssets.Read(path);
        if (content is null)
        {
            return null;
        }

        using var output = new MemoryStream();
        using (Stream compressor = encoding == "br"
            ? new BrotliStream(output, CompressionLevel.Optimal, leaveOpen: true)
            : new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            compressor.Write(content);
        }

        return output.ToArray();
    }
}
