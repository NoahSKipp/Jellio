using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public record GenreCount(string Name, int Count);

/// <summary>
/// Genres for the home and library rows without the browser downloading
/// thousands of items to find them: the genre list with item counts is
/// worked out here, kept for six hours and refreshed in the background
/// after one; a genre row's items are kept for five minutes.
/// </summary>
public class GenreCache(ILibraryManager libraryManager, IDtoService dtoService, ILogger<GenreCache> logger)
{
    private static readonly TimeSpan CountsTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan CountsRefreshAfter = TimeSpan.FromHours(1);
    private static readonly TimeSpan RowTtl = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<GenreCount> Counts)> _counts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<IReadOnlyList<GenreCount>>> _countsBuilding = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<BaseItemDto> Items)> _rows = new(StringComparer.Ordinal);

    public static BaseItemKind[] ParseTypes(string? types) =>
        (types ?? "Movie,Series")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(name => Enum.TryParse<BaseItemKind>(name, true, out var kind) ? kind : (BaseItemKind?)null)
            .OfType<BaseItemKind>()
            .Distinct()
            .ToArray();

    // Every genre the reader's items carry, with how many items carry it.
    public async Task<IReadOnlyList<GenreCount>> GetCountsAsync(User user, BaseItemKind[] types, Guid parentId)
    {
        var key = user.Id.ToString("N") + "|" + string.Join(',', types) + "|" + parentId.ToString("N");
        if (_counts.TryGetValue(key, out var hit))
        {
            var age = DateTime.UtcNow - hit.At;
            if (age < CountsRefreshAfter)
            {
                return hit.Counts;
            }

            if (age < CountsTtl)
            {
                // Older than an hour: answer now, refresh behind it.
                _ = BuildCountsAsync(key, user, types, parentId);
                return hit.Counts;
            }
        }

        return await BuildCountsAsync(key, user, types, parentId).ConfigureAwait(false);
    }

    private Task<IReadOnlyList<GenreCount>> BuildCountsAsync(string key, User user, BaseItemKind[] types, Guid parentId) =>
        _countsBuilding.GetOrAdd(key, building => Task.Run(() =>
        {
            try
            {
                var started = DateTime.UtcNow;
                var items = libraryManager.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = types,
                    Recursive = true,
                    ParentId = parentId,
                    DtoOptions = new DtoOptions(false),
                });
                var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (var item in items)
                {
                    foreach (var genre in item.Genres ?? Array.Empty<string>())
                    {
                        if (!string.IsNullOrWhiteSpace(genre))
                        {
                            counts[genre] = counts.GetValueOrDefault(genre) + 1;
                        }
                    }
                }

                IReadOnlyList<GenreCount> result = counts
                    .Select(pair => new GenreCount(pair.Key, pair.Value))
                    .OrderByDescending(entry => entry.Count)
                    .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                _counts[key] = (DateTime.UtcNow, result);
                logger.LogInformation(
                    "Jellio: genre list built in {Ms} ms from {Items} items, {Genres} genres",
                    (int)(DateTime.UtcNow - started).TotalMilliseconds,
                    items.Count,
                    result.Count);
                return result;
            }
            finally
            {
                _countsBuilding.TryRemove(key, out _);
            }
        }));

    // A genre row: its best-rated items, as the browser used to ask for.
    public IReadOnlyList<BaseItemDto> GetRow(User user, string genre, BaseItemKind[] types, Guid parentId, int limit)
    {
        var key = string.Join('|', user.Id.ToString("N"), genre.ToLowerInvariant(), string.Join(',', types), parentId.ToString("N"), limit);
        if (_rows.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < RowTtl)
        {
            return hit.Items;
        }

        var items = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = types,
            Recursive = true,
            ParentId = parentId,
            Genres = [genre],
            OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
            Limit = limit,
        });
        var options = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres],
            EnableUserData = true,
        };
        IReadOnlyList<BaseItemDto> dtos = dtoService.GetBaseItemDtos(items, options, user);
        if (_rows.Count > 500)
        {
            _rows.Clear();
        }

        _rows[key] = (DateTime.UtcNow, dtos);
        return dtos;
    }
}
