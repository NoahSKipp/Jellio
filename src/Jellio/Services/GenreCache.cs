using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging;
using Jellio.Extensions;

namespace Jellio.Services;

public record GenreCount(string Name, int Count);

public class GenreCache(
    ILibraryManager libraryManager,
    IDtoService dtoService,
    ILogger<GenreCache> logger,
    IHttpClientFactory? httpClientFactory = null)
{
    private static readonly TimeSpan CountsTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan CountsRefreshAfter = TimeSpan.FromHours(1);
    private static readonly TimeSpan RowTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan VirtualTtl = TimeSpan.FromHours(1);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private static readonly Dictionary<string, int> MovieGenreMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Action"] = 28,
        ["Adventure"] = 12,
        ["Animation"] = 16,
        ["Anime"] = 16,
        ["Comedy"] = 35,
        ["Crime"] = 80,
        ["Documentary"] = 99,
        ["Drama"] = 18,
        ["Family"] = 10751,
        ["Fantasy"] = 14,
        ["History"] = 36,
        ["Horror"] = 27,
        ["Music"] = 10402,
        ["Mystery"] = 9648,
        ["Romance"] = 10749,
        ["Science Fiction"] = 878,
        ["Sci-Fi"] = 878,
        ["TV Movie"] = 10770,
        ["Thriller"] = 53,
        ["War"] = 10752,
        ["Western"] = 37,
    };

    private static readonly Dictionary<string, int> TvGenreMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Action & Adventure"] = 10759,
        ["Action"] = 10759,
        ["Adventure"] = 10759,
        ["Animation"] = 16,
        ["Anime"] = 16,
        ["Comedy"] = 35,
        ["Crime"] = 80,
        ["Documentary"] = 99,
        ["Drama"] = 18,
        ["Family"] = 10751,
        ["Kids"] = 10762,
        ["Mystery"] = 9648,
        ["News"] = 10763,
        ["Reality"] = 10764,
        ["Sci-Fi & Fantasy"] = 10765,
        ["Science Fiction"] = 10765,
        ["Sci-Fi"] = 10765,
        ["Fantasy"] = 10765,
        ["Soap"] = 10766,
        ["Talk"] = 10767,
        ["War & Politics"] = 10768,
        ["War"] = 10768,
        ["Western"] = 37,
    };

    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<GenreCount> Counts)> _counts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<IReadOnlyList<GenreCount>>> _countsBuilding = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<BaseItemDto> Items)> _rows = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<BaseItemDto> Items)> _virtualGenreCache = new(StringComparer.OrdinalIgnoreCase);

    public static Guid GenerateDeterministicId(string kind, string tmdbId)
    {
        var hash = MD5.HashData(Encoding.UTF8.GetBytes($"jellio:virtual:{kind}:{tmdbId}"));
        return new Guid(hash);
    }

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

    private IReadOnlyList<BaseItemDto> GetLocalItems(User user, string genre, BaseItemKind[] types, Guid parentId)
    {
        var key = string.Join('|', user.Id.ToString("N"), genre.ToLowerInvariant(), string.Join(',', types), parentId.ToString("N"));
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
            // Headroom: several versions of one title can come back as separate
            // items and are folded into one below.
            Limit = 500,
        });
        var distinct = DistinctTitles(items).ToList();
        var options = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres, ItemFields.Overview],
            EnableUserData = true,
            EnableImages = true,
        };
        IReadOnlyList<BaseItemDto> dtos = dtoService.GetBaseItemDtosCompat(distinct, options, user, logger);
        if (_rows.Count > 500)
        {
            _rows.Clear();
        }

        _rows[key] = (DateTime.UtcNow, dtos);
        return dtos;
    }

    // A genre row: its best-rated items, as the browser used to ask for.
    public IReadOnlyList<BaseItemDto> GetRow(User user, string genre, BaseItemKind[] types, Guid parentId, int limit)
    {
        var local = GetLocalItems(user, genre, types, parentId);
        return local.Take(limit).ToList();
    }

    // Paged genre items with optional virtual expansion from TMDB discovery when requested.
    public async Task<(IReadOnlyList<BaseItemDto> Items, int TotalCount)> GetRowAsync(
        User user,
        string genre,
        BaseItemKind[] types,
        Guid parentId,
        int startIndex,
        int limit,
        bool enableVirtual,
        string? tokenOverride = null,
        CancellationToken cancellationToken = default)
    {
        var localDtos = GetLocalItems(user, genre, types, parentId);
        if (!enableVirtual)
        {
            var pagedLocal = localDtos.Skip(startIndex).Take(limit).ToList();
            return (pagedLocal, localDtos.Count);
        }

        var virtualDtos = await GetVirtualItemsAsync(genre, types, tokenOverride, cancellationToken).ConfigureAwait(false);
        if (virtualDtos.Count == 0)
        {
            var pagedLocal = localDtos.Skip(startIndex).Take(limit).ToList();
            return (pagedLocal, localDtos.Count);
        }

        var localTmdbIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var localTitleKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var local in localDtos)
        {
            if (local.ProviderIds != null && local.ProviderIds.TryGetValue("Tmdb", out var tid) && !string.IsNullOrWhiteSpace(tid))
            {
                localTmdbIds.Add(tid);
            }

            if (!string.IsNullOrWhiteSpace(local.Name))
            {
                localTitleKeys.Add(local.Name.Trim().ToLowerInvariant() + "|" + (local.ProductionYear ?? 0));
            }
        }

        var nonDuplicateVirtual = virtualDtos.Where(v =>
        {
            if (v.ProviderIds != null && v.ProviderIds.TryGetValue("Tmdb", out var tid) && localTmdbIds.Contains(tid))
            {
                return false;
            }

            var key = (v.Name ?? string.Empty).Trim().ToLowerInvariant() + "|" + (v.ProductionYear ?? 0);
            return !localTitleKeys.Contains(key);
        }).ToList();

        var combined = localDtos.Concat(nonDuplicateVirtual).ToList();
        var paged = combined.Skip(startIndex).Take(limit).ToList();
        return (paged, combined.Count);
    }

    public async Task<IReadOnlyList<BaseItemDto>> GetVirtualItemsAsync(
        string genre,
        BaseItemKind[] types,
        string? tokenOverride = null,
        CancellationToken cancellationToken = default)
    {
        var token = tokenOverride ?? JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        if (string.IsNullOrWhiteSpace(token) || httpClientFactory == null)
        {
            return Array.Empty<BaseItemDto>();
        }

        var cacheKey = genre + "|" + string.Join(',', types.OrderBy(t => t));
        if (_virtualGenreCache.TryGetValue(cacheKey, out var hit) && DateTime.UtcNow - hit.At < VirtualTtl)
        {
            return hit.Items;
        }

        var virtualItems = new List<BaseItemDto>();
        var seenTmdb = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var client = httpClientFactory.CreateClient();
            client.BaseAddress = new Uri("https://api.themoviedb.org/3/");
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
            client.Timeout = TimeSpan.FromSeconds(8);

            var tasks = new List<Task<IReadOnlyList<BaseItemDto>>>();

            if (types.Contains(BaseItemKind.Movie) && MovieGenreMap.TryGetValue(genre, out var movieGenreId))
            {
                tasks.Add(FetchTmdbDiscoverAsync(client, "movie", movieGenreId, genre, cancellationToken));
            }

            if (types.Contains(BaseItemKind.Series) && TvGenreMap.TryGetValue(genre, out var tvGenreId))
            {
                tasks.Add(FetchTmdbDiscoverAsync(client, "tv", tvGenreId, genre, cancellationToken));
            }

            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            foreach (var list in results)
            {
                foreach (var item in list)
                {
                    if (item.ProviderIds != null && item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) && seenTmdb.Add(tmdbId))
                    {
                        virtualItems.Add(item);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(ex, "Jellio: TMDB virtual genre discovery failed for {Genre}", genre);
        }

        if (_virtualGenreCache.Count > 200)
        {
            _virtualGenreCache.Clear();
        }

        _virtualGenreCache[cacheKey] = (DateTime.UtcNow, virtualItems);
        return virtualItems;
    }

    private static async Task<IReadOnlyList<BaseItemDto>> FetchTmdbDiscoverAsync(
        HttpClient client,
        string kind,
        int genreId,
        string genreName,
        CancellationToken cancellationToken)
    {
        var isMovie = kind == "movie";
        var path = isMovie
            ? $"discover/movie?include_adult=false&sort_by=vote_average.desc&vote_count.gte=100&with_genres={genreId}"
            : $"discover/tv?include_adult=false&sort_by=vote_average.desc&vote_count.gte=50&with_genres={genreId}";

        using var response = await client.GetAsync(path, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return Array.Empty<BaseItemDto>();
        }

        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var payload = await JsonSerializer.DeserializeAsync<TmdbDiscoverResponse>(stream, JsonOptions, cancellationToken).ConfigureAwait(false);
        if (payload?.Results == null || payload.Results.Count == 0)
        {
            return Array.Empty<BaseItemDto>();
        }

        var list = new List<BaseItemDto>();
        foreach (var result in payload.Results)
        {
            var title = isMovie ? result.Title : result.Name;
            if (string.IsNullOrWhiteSpace(title))
            {
                continue;
            }

            int? year = null;
            var dateStr = isMovie ? result.ReleaseDate : result.FirstAirDate;
            if (!string.IsNullOrWhiteSpace(dateStr))
            {
                if (dateStr.Length >= 4 && int.TryParse(dateStr.Substring(0, 4), out var y))
                {
                    year = y;
                }
                else if (DateTime.TryParse(dateStr, out var d))
                {
                    year = d.Year;
                }
            }

            var tmdbIdStr = result.Id.ToString();
            list.Add(new BaseItemDto
            {
                Id = GenerateDeterministicId(isMovie ? "movie" : "tv", tmdbIdStr),
                Name = title,
                ProductionYear = year,
                CommunityRating = result.VoteAverage.HasValue ? (float)result.VoteAverage.Value : null,
                ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Tmdb"] = tmdbIdStr,
                },
                Type = isMovie ? BaseItemKind.Movie : BaseItemKind.Series,
                LocationType = LocationType.Virtual,
                Overview = result.Overview,
                Genres = [genreName],
                PrimaryImageAspectRatio = 2.0 / 3.0,
            });
        }

        return list;
    }

    // One entry per title: the same film in several versions (or imported
    // twice) shares a presentation key, or at least an id or a name and year.
    public static IEnumerable<BaseItem> DistinctTitles(IEnumerable<BaseItem> items)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            var keys = new List<string> { "i:" + item.Id.ToString("N"), "t:" + (item.Name ?? string.Empty).Trim() + "|" + item.ProductionYear };
            if (!string.IsNullOrEmpty(item.PresentationUniqueKey))
            {
                keys.Add("p:" + item.PresentationUniqueKey);
            }

            if (keys.Any(seen.Contains))
            {
                continue;
            }

            keys.ForEach(key => seen.Add(key));
            yield return item;
        }
    }

    private sealed class TmdbDiscoverResponse
    {
        [JsonPropertyName("results")]
        public List<TmdbDiscoverItem>? Results { get; set; }
    }

    private sealed class TmdbDiscoverItem
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("release_date")]
        public string? ReleaseDate { get; set; }

        [JsonPropertyName("first_air_date")]
        public string? FirstAirDate { get; set; }

        [JsonPropertyName("vote_average")]
        public double? VoteAverage { get; set; }

        [JsonPropertyName("overview")]
        public string? Overview { get; set; }

        [JsonPropertyName("poster_path")]
        public string? PosterPath { get; set; }
    }
}
