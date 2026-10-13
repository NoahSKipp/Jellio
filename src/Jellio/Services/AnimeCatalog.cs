using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellio.Services;

/// <summary>
/// Which titles are anime: everything in an anime catalog collection
/// (Gelato writes ProviderIds.Stremio as "anime.{catalogId}"; older or
/// hand-made collections are matched by name, as runtime/api.js's
/// isAnimeCollection does). Shared by AnimeController and the calendar,
/// cached for a few minutes.
/// </summary>
public static partial class AnimeCatalog
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private static readonly object CacheLock = new();
    private static (DateTime At, HashSet<Guid> Ids)? _cache;

    public static IReadOnlySet<Guid> GetIds(ILibraryManager libraryManager)
    {
        lock (CacheLock)
        {
            if (_cache is { } cached && DateTime.UtcNow - cached.At < CacheTtl)
            {
                return cached.Ids;
            }
        }

        var collections = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.BoxSet],
            Recursive = true,
        });

        var ids = new HashSet<Guid>();
        foreach (var collection in collections.OfType<Folder>().Where(IsAnimeCollection))
        {
            foreach (var child in collection.GetLinkedChildren())
            {
                ids.Add(child.Id);
            }
        }

        lock (CacheLock)
        {
            _cache = (DateTime.UtcNow, ids);
        }

        return ids;
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
