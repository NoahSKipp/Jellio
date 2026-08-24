using System.Reflection;
using Microsoft.AspNetCore.Authorization;
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

        // Only jellio.css and jellio.js themselves carry a version query
        // string (IndexHtmlPatchService/BrandingCssInjectionService append
        // it), every file they pull in from here, every @import in
        // jellio.css, every dynamic import() in jellio.js, is requested at
        // a fixed URL with no version suffix at all. A year-long immutable
        // cache on those meant a browser that had ever loaded Jellio once
        // would keep serving that exact original snapshot of every CSS and
        // JS partial forever, silently ignoring every subsequent release,
        // real bug, not a guess, confirmed by a live install still showing
        // fixes that were genuinely present in the served files. Fonts are
        // the one real exception, the same file across every release, safe
        // to keep caching hard.
        // Fonts and the service logos are the exception: the same bytes
        // every release, and the logos are fetched once per tile on every
        // home screen, so re-validating each one buys nothing.
        var cacheable =
            extension.Equals(".woff2", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".svg", StringComparison.OrdinalIgnoreCase);
        Response.Headers.CacheControl = cacheable
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        return File(stream, contentType);
    }
}
