using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;
using Jellio.Extensions;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/profile/banner")]
[Authorize]
public class ProfileBannerController(IApplicationPaths applicationPaths) : ControllerBase
{
    private static readonly (string ContentType, string Extension)[] AllowedTypes =
    [
        ("image/jpeg", ".jpg"),
        ("image/png", ".png"),
        ("image/webp", ".webp"),
    ];

    private const long MaxUploadBytes = 8 * 1024 * 1024;

    private const long MaxRequestBodyBytes = MaxUploadBytes * 4 / 3 + 1024;

    private const int MaxDecodeDimension = 10000;

    private const int MaxDimension = 2400;

    private string BannerDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "banners");

    [HttpGet("{userId:guid}")]
    public IActionResult Get(Guid userId)
    {
        var match = AllowedTypes
            .Select(t => Path.Combine(BannerDirectory, userId + t.Extension))
            .FirstOrDefault(System.IO.File.Exists);
        if (match is null)
        {
            return NotFound();
        }

        var contentType = AllowedTypes.First(t => t.Extension == Path.GetExtension(match)).ContentType;
        return PhysicalFile(match, contentType);
    }

    [HttpPost]
    public async Task<IActionResult> Upload()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var contentType = Request.ContentType?.Split(';').FirstOrDefault();
        var match = AllowedTypes.FirstOrDefault(t => t.ContentType == contentType);
        if (match.Extension is null)
        {
            return BadRequest("Unsupported image type");
        }

        if (Request.ContentLength is { } contentLength && contentLength > MaxRequestBodyBytes)
        {
            return BadRequest("Image too large. Please use a banner under 8 MB.");
        }

        byte[] bytes;
        try
        {
            using var reader = new StreamReader(Request.Body);
            bytes = Convert.FromBase64String(await reader.ReadToEndAsync());
        }
        catch (FormatException)
        {
            return BadRequest("Malformed image data");
        }

        if (bytes.Length > MaxUploadBytes)
        {
            return BadRequest("Image too large. Please use a banner under 8 MB.");
        }

        byte[] encoded;
        try
        {
            using (var identifyStream = new MemoryStream(bytes))
            {
                var info = Image.Identify(identifyStream);
                if (info is null)
                {
                    return BadRequest("Malformed image data");
                }

                if (info.Width > MaxDecodeDimension || info.Height > MaxDecodeDimension)
                {
                    return BadRequest("Image dimensions are too large.");
                }
            }

            using var image = Image.Load(bytes);
            if (image.Width > MaxDimension || image.Height > MaxDimension)
            {
                image.Mutate(x => x.Resize(new ResizeOptions
                {
                    Mode = ResizeMode.Max,
                    Size = new Size(MaxDimension, MaxDimension),
                }));
            }

            using var output = new MemoryStream();
            switch (match.ContentType)
            {
                case "image/png":
                    image.Save(output, new PngEncoder());
                    break;
                case "image/webp":
                    image.Save(output, new WebpEncoder());
                    break;
                default:
                    image.Save(output, new JpegEncoder { Quality = 85 });
                    break;
            }

            encoded = output.ToArray();
        }
        catch (ImageFormatException)
        {
            return BadRequest("Malformed image data");
        }

        Directory.CreateDirectory(BannerDirectory);
        foreach (var type in AllowedTypes)
        {
            var existing = Path.Combine(BannerDirectory, userId + type.Extension);
            if (System.IO.File.Exists(existing))
            {
                System.IO.File.Delete(existing);
            }
        }

        await System.IO.File.WriteAllBytesAsync(Path.Combine(BannerDirectory, userId + match.Extension), encoded);
        return NoContent();
    }

    [HttpDelete]
    public IActionResult Delete()
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        foreach (var type in AllowedTypes)
        {
            var path = Path.Combine(BannerDirectory, userId + type.Extension);
            if (System.IO.File.Exists(path))
            {
                System.IO.File.Delete(path);
            }
        }

        return NoContent();
    }

    private Guid GetUserId()
    {
        if (
            User.TryGetJellyfinUserId(out var userId)
        )
        {
            return userId;
        }

        return Guid.Empty;
    }
}
