using System;
using Jellio.Services.Chaptarr;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellio.Services.Reading;

// Turns what a client sent into a validated reading target, reading the
// title and author of a Jellyfin book or audiobook from the item itself.
public class ReadingTargets(ILibraryManager libraryManager, BookMetadataService metadata)
{
    // A reading add has a Key or Kind, or an ItemId that is a Book or AudioBook.
    public bool IsReadingRequest(ReadingInput input)
    {
        if (!string.IsNullOrWhiteSpace(input.Key) || !string.IsNullOrWhiteSpace(input.Kind))
        {
            return true;
        }

        return ReadingListLogic.ItemGuidOf(input) is { } id
            && id != Guid.Empty
            && libraryManager.GetItemById(id) is Book or AudioBook;
    }

    // `viewer` is the user who has to be able to see the item (null: nobody is checked).
    public ReadingParse Resolve(ReadingInput input, User? viewer)
    {
        ReadingItemInfo? info = null;
        if (ReadingListLogic.ItemGuidOf(input) is { } id && id != Guid.Empty)
        {
            var item = libraryManager.GetItemById(id);
            if (item is not null and not (Book or AudioBook))
            {
                return ReadingParse.Fail(ReadingListLogic.Errors.InvalidItem);
            }

            if (item is not null && (viewer is null || item.IsVisible(viewer)))
            {
                info = Describe(item);
            }
        }

        return ReadingListLogic.Parse(input, info);
    }

    public ReadingItemInfo Describe(BaseItem item)
    {
        var audio = item is AudioBook;
        return new ReadingItemInfo(
            item.Id,
            audio,
            audio ? BookMetadataService.AudiobookTitle(item) : item.Name ?? string.Empty,
            metadata.KnownAuthor(item),
            ReadingListLogic.IsComicPath(item.Path));
    }
}
