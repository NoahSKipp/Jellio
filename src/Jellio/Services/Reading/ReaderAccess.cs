using System.Collections.Generic;
using System.Linq;
using Jellio.Configuration;
using MediaBrowser.Controller.Entities;
using Jellyfin.Data.Enums;

namespace Jellio.Services.Reading;

// Whether a reader feature is available at all: switched on by the admin,
// and the user has a Books library to read in (the same rules the web nav
// uses to show Books, Audiobooks and Manga).
public static class ReaderAccess
{
    public static bool FeatureEnabled(PluginConfiguration? config, string kind) => kind switch
    {
        ReadingKinds.Audiobook => config?.AudiobooksEnabled != false,
        ReadingKinds.Manga => config?.MangaEnabled != false,
        _ => config?.BooksEnabled != false,
    };

    // `views` are the libraries the user can see.
    public static bool HasReaderLibrary(IEnumerable<BaseItem> views, PluginConfiguration? config)
    {
        var disabled = (config?.DisabledLibraryIds ?? [])
            .Select(Normalize)
            .ToHashSet();
        return views.OfType<CollectionFolder>().Any(view =>
            view.CollectionType == CollectionType.books && !disabled.Contains(Normalize(view.Id.ToString())));
    }

    private static string Normalize(string id) => id.Replace("-", string.Empty).ToLowerInvariant();
}
