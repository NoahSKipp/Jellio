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
    };

    // The whole assembly is one deployable unit, every embedded file in
    // it changes together whenever a real release changes any of them,
    // so the assembly's own version is already a real, correct ETag
    // basis: identical across every request against the same install,
    // and different the moment a new one is deployed, without hashing
    // file content on every single request to get the same guarantee.
    private static readonly string ETagValue =
        "\"" + (Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0") + "\"";

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
        var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            return NotFound();
        }

        // Fonts and the service logos are the exception: the same bytes
        // every release, and the logos are fetched once per tile on
        // every home screen, so re-validating each one buys nothing.
        var cacheable =
            extension.Equals(".woff2", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".svg", StringComparison.OrdinalIgnoreCase);

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

        return File(stream, contentType);
    }
}
