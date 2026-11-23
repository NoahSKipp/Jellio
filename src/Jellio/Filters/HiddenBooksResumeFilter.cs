using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellio.Extensions;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellio.Filters;

// Jellyfin's resume list (Continue listening for audiobooks) knows nothing
// of the books a reader removed from their own library, so a stale
// position would bring one back. Every client reads the same answer.
public class HiddenBooksResumeFilter(ShelfStore shelfStore, ILibraryManager libraryManager) : IAsyncResultFilter
{
    public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
    {
        if (context.ActionDescriptor is ControllerActionDescriptor { ActionName: "GetResumeItems" or "GetResumeItemsLegacy" }
            && context.HttpContext.User.TryGetJellyfinUserId(out var userId)
            && context.Result is ObjectResult { Value: QueryResult<BaseItemDto> result } objectResult
            && result.Items.Any(IsBook))
        {
            var hidden = HiddenBooks.Ids(shelfStore, userId);
            if (hidden.Count > 0)
            {
                var kept = Visible(result.Items, hidden, GroupsOf(hidden));
                if (kept.Count != result.Items.Count)
                {
                    objectResult.Value = new QueryResult<BaseItemDto>(result.StartIndex, Math.Max(0, result.TotalRecordCount - (result.Items.Count - kept.Count)), kept);
                }
            }
        }

        await next().ConfigureAwait(false);
    }

    // The resume entries that are not hidden books. An audiobook split into
    // tracks is hidden through any of its tracks: same folder and album.
    public static List<BaseItemDto> Visible(IEnumerable<BaseItemDto> items, HashSet<Guid> hidden, HashSet<(Guid Parent, string Album)> hiddenAudiobooks) =>
        items.Where(item => !(IsBook(item) && (hidden.Contains(item.Id) || (item.Type == BaseItemKind.AudioBook && hiddenAudiobooks.Contains((item.ParentId ?? Guid.Empty, item.Album ?? string.Empty)))))).ToList();

    private static bool IsBook(BaseItemDto item) => item.Type is BaseItemKind.Book or BaseItemKind.AudioBook;

    private HashSet<(Guid Parent, string Album)> GroupsOf(HashSet<Guid> hidden)
    {
        var groups = new HashSet<(Guid, string)>();
        foreach (var id in hidden)
        {
            if (libraryManager.GetItemById(id) is MediaBrowser.Controller.Entities.AudioBook book)
            {
                groups.Add((book.ParentId, book.Album ?? string.Empty));
            }
        }

        return groups;
    }
}
