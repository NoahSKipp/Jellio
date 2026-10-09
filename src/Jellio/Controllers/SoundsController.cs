using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Claims;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Sounds an admin plays on a reader's device: no toast, the clip just
/// plays, and whatever is already playing there is turned down to
/// DuckVolume until it ends. Pending sounds live in memory only and
/// expire after a short while, a clip from ten minutes ago is no longer
/// funny. Clients poll /pending with the last Seq they saw.
/// </summary>
[ApiController]
[Route("Jellio/sounds")]
[Authorize]
public partial class SoundsController(IUserManager userManager, IApplicationPaths applicationPaths) : ControllerBase
{
    // Direction: where it's heard, "both" (default), "left", "right" or
    // "rear" (the surround speakers behind, where there are any).
    public record SendSoundRequest(string? Sound, Guid? UserId = null, int Volume = 100, int DuckVolume = 30, string? Direction = null);

    public record PendingSound(long Seq, string SoundId, int Volume, int DuckVolume, DateTime SentAt, string Direction = "both");

    private static readonly string[] Directions = ["both", "left", "right", "rear"];

    private const int MaxSoundBytes = 10 * 1024 * 1024;
    private static readonly TimeSpan PendingLifetime = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan FileLifetime = TimeSpan.FromDays(1);

    private static readonly object Lock = new();
    private static readonly Dictionary<Guid, List<PendingSound>> Pending = new();
    private static long _seq;

    private string SoundDirectory => Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "sounds");

    [HttpPost]
    [Authorize(Policy = "RequiresElevation")]
    [RequestSizeLimit(MaxSoundBytes * 4 / 3 + 4096)]
    public IActionResult Send([FromBody] SendSoundRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Sound))
        {
            return BadRequest("Choose a sound first.");
        }

        var data = request.Sound;
        var comma = data.IndexOf(',', StringComparison.Ordinal);
        var base64 = data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma > 0 ? data[(comma + 1)..] : data;
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64.Trim());
        }
        catch (FormatException)
        {
            return BadRequest("The sound couldn't be read.");
        }

        if (bytes.Length > MaxSoundBytes)
        {
            return BadRequest("Sound too large. Please use one under 10 MB.");
        }

        var extension = DetectExtension(bytes);
        if (extension is null)
        {
            return BadRequest("That file isn't a sound Jellio can play (MP3, M4A, OGG or WAV).");
        }

        var recipients = userManager.GetUsers().ToList();
        if (request.UserId is { } targetId && targetId != Guid.Empty)
        {
            recipients = recipients.Where(user => user.Id == targetId).ToList();
            if (recipients.Count == 0)
            {
                return NotFound("That user no longer exists");
            }
        }

        Directory.CreateDirectory(SoundDirectory);
        CleanUpOldFiles();
        var soundId = Guid.NewGuid().ToString("N") + "." + extension;
        System.IO.File.WriteAllBytes(Path.Combine(SoundDirectory, soundId), bytes);

        var volume = Math.Clamp(request.Volume, 0, 100);
        var duck = Math.Clamp(request.DuckVolume, 0, 100);
        var requested = request.Direction?.Trim().ToLowerInvariant() ?? "both";
        var direction = Array.IndexOf(Directions, requested) >= 0 ? requested : "both";
        var now = DateTime.UtcNow;
        lock (Lock)
        {
            foreach (var user in recipients)
            {
                if (!Pending.TryGetValue(user.Id, out var list))
                {
                    list = [];
                    Pending[user.Id] = list;
                }

                list.RemoveAll(sound => now - sound.SentAt > PendingLifetime);
                list.Add(new PendingSound(++_seq, soundId, volume, duck, now, direction));
            }
        }

        return Ok();
    }

    // after < 0 is a client's first poll: it learns the current Seq
    // without playing anything sent before it was open.
    [HttpGet("pending")]
    public IActionResult GetPending([FromQuery] long after = -1)
    {
        var userId = GetUserId();
        if (userId == Guid.Empty)
        {
            return BadRequest("Invalid user session");
        }

        var now = DateTime.UtcNow;
        lock (Lock)
        {
            if (after < 0 || !Pending.TryGetValue(userId, out var list))
            {
                return Ok(new { Latest = _seq, Sounds = Array.Empty<PendingSound>() });
            }

            list.RemoveAll(sound => now - sound.SentAt > PendingLifetime);
            return Ok(new { Latest = _seq, Sounds = list.Where(sound => sound.Seq > after).ToList() });
        }
    }

    [HttpGet("file/{soundId}")]
    public IActionResult GetFile([FromRoute] string soundId)
    {
        var match = SoundName().Match(soundId ?? string.Empty);
        if (!match.Success)
        {
            return NotFound();
        }

        var path = Path.Combine(SoundDirectory, soundId!);
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        var contentType = match.Groups[1].Value switch
        {
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "ogg" => "audio/ogg",
            _ => "audio/wav",
        };
        Response.Headers.CacheControl = "private, max-age=86400";
        return PhysicalFile(path, contentType);
    }

    private static string? DetectExtension(byte[] b)
    {
        if (b.Length < 12)
        {
            return null;
        }

        if ((b[0] == 'I' && b[1] == 'D' && b[2] == '3') || (b[0] == 0xFF && (b[1] & 0xE0) == 0xE0))
        {
            return "mp3";
        }

        if (b[0] == 'O' && b[1] == 'g' && b[2] == 'g' && b[3] == 'S')
        {
            return "ogg";
        }

        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'A' && b[10] == 'V' && b[11] == 'E')
        {
            return "wav";
        }

        if (b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p')
        {
            return "m4a";
        }

        return null;
    }

    private void CleanUpOldFiles()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(SoundDirectory))
            {
                if (DateTime.UtcNow - System.IO.File.GetLastWriteTimeUtc(file) > FileLifetime)
                {
                    System.IO.File.Delete(file);
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
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

    [System.Text.RegularExpressions.GeneratedRegex("^[a-f0-9]{32}\\.(mp3|m4a|ogg|wav)$")]
    private static partial System.Text.RegularExpressions.Regex SoundName();
}
