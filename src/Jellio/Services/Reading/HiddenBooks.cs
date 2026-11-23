using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Reading;

public static class HiddenBooks
{
    // The books this reader took off their own shelf ("i:<id>" keys of the
    // shelf's LibraryRemoved list), as item ids.
    public static HashSet<Guid> Ids(IEnumerable<string> libraryRemoved)
    {
        var ids = new HashSet<Guid>();
        foreach (var key in libraryRemoved)
        {
            if (key.StartsWith("i:", StringComparison.OrdinalIgnoreCase) && Guid.TryParse(key.AsSpan(2), out var id))
            {
                ids.Add(id);
            }
        }

        return ids;
    }

    public static HashSet<Guid> Ids(ShelfStore shelfStore, Guid userId) =>
        Ids(shelfStore.Load(userId).LibraryRemoved);
}
