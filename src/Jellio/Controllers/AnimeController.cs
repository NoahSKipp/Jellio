using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Which titles are anime: everything in an anime catalog collection
/// (Gelato writes ProviderIds.Stremio as "anime.{catalogId}"; older or
/// hand-made collections are matched by name, as runtime/api.js's
/// isAnimeCollection does). Anime lives in the Movies and Shows libraries
/// too, so Jellio and Jellio TV use this list to keep it to the Anime
/// library and out of everything else.
/// </summary>
[ApiController]
[Route("Jellio/anime")]
[Authorize]
public partial class AnimeController(ILibraryManager libraryManager) : ControllerBase
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private static readonly object CacheLock = new();
    private static (DateTime At, List<string> Ids)? _cache;

    [HttpGet("ids")]
    public IActionResult Ids()
    {
        lock (CacheLock)
        {
            if (_cache is { } cached && DateTime.UtcNow - cached.At < CacheTtl)
            {
                return Ok(new { Ids = cached.Ids });
            }
        }

        var collections = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.BoxSet],
            Recursive = true,
        });

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var collection in collections.OfType<Folder>().Where(IsAnimeCollection))
        {
            foreach (var child in collection.GetLinkedChildren())
            {
                ids.Add(child.Id.ToString("N"));
            }
        }

        var list = ids.ToList();
        lock (CacheLock)
        {
            _cache = (DateTime.UtcNow, list);
        }

        return Ok(new { Ids = list });
    }

    private static bool IsAnimeCollection(BaseItem collection)
    {
        var stremio = collection.ProviderIds?
            .FirstOrDefault(pair => string.Equals(pair.Key, "Stremio", StringComparison.OrdinalIgnoreCase))
            .Value;
        if (!string.IsNullOrEmpty(stremio))
        {
            return string.Equals(stremio.Split('.')[0], "anime", StringComparison.OrdinalIgnoreCase);
        }

        return AnimeName().IsMatch(collection.Name ?? string.Empty);
    }

    [GeneratedRegex("anime|anilist|kitsu", RegexOptions.IgnoreCase)]
    private static partial Regex AnimeName();
}
