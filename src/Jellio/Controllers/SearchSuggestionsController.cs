using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Jellio.Extensions;
using Jellio.Services;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/search/suggestions")]
[Authorize]
public class SearchSuggestionsController(
    IHttpClientFactory httpClientFactory,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IDtoService dtoService,
    ILogger<SearchSuggestionsController> logger) : ControllerBase
{
    private const int RowSize = 16;
    private static readonly TimeSpan IndexTtl = TimeSpan.FromMinutes(15);
    private static readonly SemaphoreSlim IndexLock = new(1, 1);
    private static (DateTime BuiltAt, Dictionary<string, Guid> ByTmdb)? _tmdbIndex;
    private static readonly ConcurrentDictionary<string, (DateTime At, SuggestionsResponse Response)> ResponseCache = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public record SuggestionRow(string Kind, string? Name, IReadOnlyList<BaseItemDto> Items);

    public record SuggestionsResponse(string? MatchedTitle, IReadOnlyList<SuggestionRow> Rows);

    [HttpGet]
    public async Task<ActionResult<SuggestionsResponse>> Get(
        [FromQuery] string? query = null,
        [FromQuery] int? tmdbId = null,
        [FromQuery] string? mediaType = null,
        [FromQuery] Guid? userId = null,
        [FromQuery] bool enableVirtual = true,
        [FromQuery] string? excludeIds = null,
        CancellationToken cancellationToken = default)
    {
        var targetUserId = userId.HasValue && userId.Value != Guid.Empty
            ? userId.Value
            : (User.TryGetJellyfinUserId(out var id) ? id : Guid.Empty);

        var user = targetUserId != Guid.Empty ? userManager.GetUserById(targetUserId) : null;
        user ??= userManager.GetUsers().FirstOrDefault();
        if (user == null)
        {
            return new SuggestionsResponse(null, []);
        }

        var trimmedQuery = query?.Trim();
        if (string.IsNullOrWhiteSpace(trimmedQuery) && (!tmdbId.HasValue || string.IsNullOrWhiteSpace(mediaType)))
        {
            return new SuggestionsResponse(null, []);
        }

        var cacheKey = $"{trimmedQuery?.ToLowerInvariant()}|{tmdbId}|{mediaType}|{enableVirtual}|{excludeIds}";
        if (ResponseCache.TryGetValue(cacheKey, out var cached) && DateTime.UtcNow - cached.At < TimeSpan.FromHours(6))
        {
            return cached.Response;
        }

        var excluded = ParseExcludedIds(excludeIds);
        var dtoOptions = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres, ItemFields.Overview],
            EnableUserData = true,
            EnableImages = true,
        };

        var usedIds = new HashSet<Guid>();
        var rows = new List<SuggestionRow>();
        string? matchedTitle = null;

        using var client = GenreCache.CreateTmdbClient(httpClientFactory, null, out var queryKeyParam);
        var index = await GetTmdbIndexAsync(cancellationToken).ConfigureAwait(false);

        // Case 1: tmdbId and mediaType provided
        int? targetTmdbId = tmdbId;
        var targetMediaType = mediaType?.ToLowerInvariant();

        TmdbItemResult? topSearchHit = null;

        // If tmdbId or mediaType not provided, resolve via TMDB search/multi
        if (!targetTmdbId.HasValue || string.IsNullOrWhiteSpace(targetMediaType))
        {
            if (!string.IsNullOrWhiteSpace(trimmedQuery))
            {
                var searchHit = await SearchMultiAsync(client, queryKeyParam, trimmedQuery, cancellationToken).ConfigureAwait(false);
                if (searchHit != null)
                {
                    targetTmdbId = searchHit.Id;
                    targetMediaType = searchHit.MediaType?.ToLowerInvariant();
                    topSearchHit = searchHit;
                    matchedTitle = searchHit.Title ?? searchHit.Name;
                }
            }
        }

        if (targetTmdbId.HasValue && !string.IsNullOrWhiteSpace(targetMediaType))
        {
            if (targetMediaType is "movie" or "tv")
            {
                var isMovie = targetMediaType == "movie";
                var details = await FetchDetailsAsync(client, queryKeyParam, targetMediaType, targetTmdbId.Value, cancellationToken).ConfigureAwait(false);
                if (details != null)
                {
                    matchedTitle ??= details.Title ?? details.Name;

                    var candidateItems = new List<TmdbItemResult>();

                    // Include the top search/multi match itself if not excluded
                    if (topSearchHit != null && !IsExcluded(topSearchHit.Id, targetMediaType, excluded))
                    {
                        candidateItems.Add(topSearchHit);
                    }

                    if (details.Recommendations?.Results != null)
                    {
                        foreach (var r in details.Recommendations.Results)
                        {
                            r.MediaType ??= targetMediaType;
                            candidateItems.Add(r);
                        }
                    }

                    if (details.Similar?.Results != null)
                    {
                        foreach (var s in details.Similar.Results)
                        {
                            s.MediaType ??= targetMediaType;
                            candidateItems.Add(s);
                        }
                    }

                    var similarRow = ResolveTmdbCandidates(
                        candidateItems,
                        index,
                        user,
                        enableVirtual,
                        excluded,
                        usedIds,
                        dtoOptions);

                    if (similarRow.Count > 0)
                    {
                        rows.Add(new SuggestionRow("similar", null, similarRow));
                    }

                    // Person rows (directors / creators / top cast)
                    var people = new List<string>();
                    if (details.Credits?.Crew != null)
                    {
                        people.AddRange(details.Credits.Crew
                            .Where(c => c.Job is "Director")
                            .Select(c => c.Name!)
                            .Where(n => !string.IsNullOrWhiteSpace(n)));
                    }

                    if (details.CreatedBy != null)
                    {
                        people.AddRange(details.CreatedBy
                            .Select(c => c.Name!)
                            .Where(n => !string.IsNullOrWhiteSpace(n)));
                    }

                    if (details.Credits?.Cast != null)
                    {
                        people.AddRange(details.Credits.Cast
                            .Take(2)
                            .Select(c => c.Name!)
                            .Where(n => !string.IsNullOrWhiteSpace(n)));
                    }

                    foreach (var person in people.Distinct(StringComparer.OrdinalIgnoreCase).Take(3))
                    {
                        var personItem = libraryManager.GetPerson(person);
                        if (personItem == null)
                        {
                            continue;
                        }

                        var personMatches = libraryManager.GetItemList(new InternalItemsQuery(user)
                        {
                            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                            Recursive = true,
                            PersonIds = [personItem.Id],
                            OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                            Limit = RowSize * 2,
                        });

                        var pickedPerson = personMatches
                            .Where(item => item != null && item.IsVisible(user) && !IsItemExcluded(item, excluded) && usedIds.Add(item.Id))
                            .Take(RowSize)
                            .ToList();

                        if (pickedPerson.Count > 0)
                        {
                            rows.Add(new SuggestionRow("person", person, dtoService.GetBaseItemDtosCompat(pickedPerson, dtoOptions, user, logger)));
                        }
                    }

                    // Genre row
                    var genreNames = (details.Genres ?? []).Select(g => g.Name!).Where(n => !string.IsNullOrWhiteSpace(n)).ToList();
                    if (genreNames.Count > 0)
                    {
                        var primaryGenre = genreNames[0];
                        var genreMatches = libraryManager.GetItemList(new InternalItemsQuery(user)
                        {
                            IncludeItemTypes = [isMovie ? BaseItemKind.Movie : BaseItemKind.Series],
                            Recursive = true,
                            Genres = [primaryGenre],
                            OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                            Limit = RowSize * 2,
                        });

                        var pickedGenre = genreMatches
                            .Where(item => item != null && item.IsVisible(user) && !IsItemExcluded(item, excluded) && usedIds.Add(item.Id))
                            .Take(RowSize)
                            .ToList();

                        if (pickedGenre.Count > 0)
                        {
                            rows.Add(new SuggestionRow("genre", primaryGenre, dtoService.GetBaseItemDtosCompat(pickedGenre, dtoOptions, user, logger)));
                        }
                    }
                }
            }
            else if (targetMediaType == "person")
            {
                var credits = await FetchPersonCreditsAsync(client, queryKeyParam, targetTmdbId.Value, cancellationToken).ConfigureAwait(false);
                if (credits != null)
                {
                    var allWorks = (credits.Cast ?? [])
                        .Concat(credits.Crew ?? [])
                        .Where(w => w.MediaType is "movie" or "tv")
                        .ToList();

                    var similarRow = ResolveTmdbCandidates(
                        allWorks,
                        index,
                        user,
                        enableVirtual,
                        excluded,
                        usedIds,
                        dtoOptions);

                    if (similarRow.Count > 0)
                    {
                        rows.Add(new SuggestionRow("similar", null, similarRow));
                    }
                }
            }
        }

        // Local library fallback when TMDB returns no sections
        if (rows.Count == 0 && !string.IsNullOrWhiteSpace(trimmedQuery))
        {
            ApplyLocalFallback(trimmedQuery, user, excluded, usedIds, dtoOptions, rows, ref matchedTitle);
        }

        var response = new SuggestionsResponse(matchedTitle, rows);
        if (ResponseCache.Count > 500)
        {
            ResponseCache.Clear();
        }

        ResponseCache[cacheKey] = (DateTime.UtcNow, response);
        return response;
    }

    private IReadOnlyList<BaseItemDto> ResolveTmdbCandidates(
        IEnumerable<TmdbItemResult> candidates,
        Dictionary<string, Guid> index,
        User user,
        bool enableVirtual,
        HashSet<string> excluded,
        HashSet<Guid> usedIds,
        DtoOptions dtoOptions)
    {
        var localItems = new List<BaseItem>();
        var virtualItems = new List<BaseItemDto>();
        var seenTmdb = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var c in candidates)
        {
            if (c.Id <= 0)
            {
                continue;
            }

            var isMovie = c.MediaType != "tv";
            var kind = isMovie ? "movie" : "tv";
            var tmdbKey = $"{kind}:{c.Id}";
            if (!seenTmdb.Add(tmdbKey))
            {
                continue;
            }

            if (IsExcluded(c.Id, kind, excluded))
            {
                continue;
            }

            if (index.TryGetValue(tmdbKey, out var localId))
            {
                var local = libraryManager.GetItemById(localId);
                if (local != null && local.IsVisible(user) && !IsItemExcluded(local, excluded) && usedIds.Add(local.Id))
                {
                    localItems.Add(local);
                    if (localItems.Count + virtualItems.Count >= RowSize)
                    {
                        break;
                    }
                }
            }
            else if (enableVirtual)
            {
                var title = c.Title ?? c.Name;
                var dateStr = isMovie ? c.ReleaseDate : c.FirstAirDate;
                var genres = GenreCache.ResolveGenreNamesByIds(c.GenreIds, isMovie);
                var vDto = GenreCache.BuildVirtualItemDto(
                    c.Id,
                    title,
                    dateStr,
                    isMovie,
                    c.VoteAverage,
                    c.Overview,
                    c.PosterPath,
                    c.BackdropPath,
                    genres,
                    skipUnreleased: true);

                if (vDto != null && !excluded.Contains(vDto.Id.ToString("N")) && usedIds.Add(vDto.Id))
                {
                    virtualItems.Add(vDto);
                    if (localItems.Count + virtualItems.Count >= RowSize)
                    {
                        break;
                    }
                }
            }
        }

        var result = new List<BaseItemDto>();
        if (localItems.Count > 0)
        {
            result.AddRange(dtoService.GetBaseItemDtosCompat(localItems, dtoOptions, user, logger));
        }

        result.AddRange(virtualItems);
        return result.Take(RowSize).ToList();
    }

    private void ApplyLocalFallback(
        string query,
        User user,
        HashSet<string> excluded,
        HashSet<Guid> usedIds,
        DtoOptions dtoOptions,
        List<SuggestionRow> rows,
        ref string? matchedTitle)
    {
        var localMatches = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            SearchTerm = query,
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            Recursive = true,
            Limit = 5,
        });

        if (localMatches == null || localMatches.Count == 0)
        {
            return;
        }

        var bestMatch = localMatches[0];
        matchedTitle ??= bestMatch.Name;

        // Similar by shared genres
        if (bestMatch.Genres != null && bestMatch.Genres.Length > 0)
        {
            var similar = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [bestMatch is Movie ? BaseItemKind.Movie : BaseItemKind.Series],
                Genres = bestMatch.Genres.Take(2).ToArray(),
                OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                Recursive = true,
                Limit = RowSize * 2,
            })
            .Where(item => item != null && item.Id != bestMatch.Id && item.IsVisible(user) && !IsItemExcluded(item, excluded) && usedIds.Add(item.Id))
            .Take(RowSize)
            .ToList();

            if (similar.Count > 0)
            {
                rows.Add(new SuggestionRow("similar", null, dtoService.GetBaseItemDtosCompat(similar, dtoOptions, user, logger)));
            }
        }

        // People
        var people = libraryManager.GetPeople(bestMatch).Take(2).ToList();
        foreach (var person in people)
        {
            if (string.IsNullOrWhiteSpace(person.Name))
            {
                continue;
            }

            var personItem = libraryManager.GetPerson(person.Name);
            if (personItem == null)
            {
                continue;
            }

            var personMatches = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                PersonIds = [personItem.Id],
                OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                Recursive = true,
                Limit = RowSize * 2,
            })
            .Where(item => item != null && item.Id != bestMatch.Id && item.IsVisible(user) && !IsItemExcluded(item, excluded) && usedIds.Add(item.Id))
            .Take(RowSize)
            .ToList();

            if (personMatches.Count > 0)
            {
                rows.Add(new SuggestionRow("person", person.Name, dtoService.GetBaseItemDtosCompat(personMatches, dtoOptions, user, logger)));
            }
        }

        // Primary genre
        if (bestMatch.Genres != null && bestMatch.Genres.Length > 0 && rows.All(r => r.Kind != "genre"))
        {
            var primaryGenre = bestMatch.Genres[0];
            var genreMatches = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [bestMatch is Movie ? BaseItemKind.Movie : BaseItemKind.Series],
                Genres = [primaryGenre],
                OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                Recursive = true,
                Limit = RowSize * 2,
            })
            .Where(item => item != null && item.IsVisible(user) && !IsItemExcluded(item, excluded) && usedIds.Add(item.Id))
            .Take(RowSize)
            .ToList();

            if (genreMatches.Count > 0)
            {
                rows.Add(new SuggestionRow("genre", primaryGenre, dtoService.GetBaseItemDtosCompat(genreMatches, dtoOptions, user, logger)));
            }
        }
    }

    private static HashSet<string> ParseExcludedIds(string? excludeIds)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(excludeIds))
        {
            return set;
        }

        foreach (var part in excludeIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            set.Add(part);
            if (Guid.TryParse(part, out var g))
            {
                set.Add(g.ToString("N"));
                set.Add(g.ToString("D"));
            }
        }

        return set;
    }

    private static bool IsExcluded(int tmdbId, string? kind, HashSet<string> excluded)
    {
        var idStr = tmdbId.ToString(CultureInfo.InvariantCulture);
        if (excluded.Contains(idStr))
        {
            return true;
        }

        if (!string.IsNullOrEmpty(kind))
        {
            if (excluded.Contains($"{kind}:{idStr}"))
            {
                return true;
            }

            var virtualGuid = GenreCache.GenerateDeterministicId(kind, idStr);
            if (excluded.Contains(virtualGuid.ToString("N")) || excluded.Contains(virtualGuid.ToString("D")))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsItemExcluded(BaseItem item, HashSet<string> excluded)
    {
        if (excluded.Contains(item.Id.ToString("N")) || excluded.Contains(item.Id.ToString("D")))
        {
            return true;
        }

        var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
        if (!string.IsNullOrEmpty(tmdb) && excluded.Contains(tmdb))
        {
            return true;
        }

        return false;
    }

    private static string AppendTmdbAuth(string path, string queryKeyParam)
    {
        if (string.IsNullOrEmpty(queryKeyParam))
        {
            return path;
        }

        var separator = path.Contains('?') ? "&" : "?";
        return path + separator + queryKeyParam.TrimStart('&');
    }

    private async Task<TmdbItemResult?> SearchMultiAsync(
        HttpClient client,
        string queryKeyParam,
        string query,
        CancellationToken ct)
    {
        try
        {
            var path = AppendTmdbAuth($"search/multi?include_adult=false&query={Uri.EscapeDataString(query)}", queryKeyParam);
            var search = await GetJsonAsync<TmdbMultiSearchResponse>(client, path, ct).ConfigureAwait(false);
            return search?.Results?.FirstOrDefault(r => r.MediaType is "movie" or "tv" or "person");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogDebug(ex, "Search suggestions: TMDB search/multi failed for {Query}", query);
            return null;
        }
    }

    private async Task<TmdbDetailsResponse?> FetchDetailsAsync(
        HttpClient client,
        string queryKeyParam,
        string kind,
        int id,
        CancellationToken ct)
    {
        try
        {
            var path = AppendTmdbAuth($"{kind}/{id}?append_to_response=recommendations,similar,credits", queryKeyParam);
            return await GetJsonAsync<TmdbDetailsResponse>(client, path, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogDebug(ex, "Search suggestions: TMDB details failed for {Kind}/{Id}", kind, id);
            return null;
        }
    }

    private async Task<TmdbCombinedCreditsResponse?> FetchPersonCreditsAsync(
        HttpClient client,
        string queryKeyParam,
        int personId,
        CancellationToken ct)
    {
        try
        {
            var path = AppendTmdbAuth($"person/{personId}/combined_credits", queryKeyParam);
            return await GetJsonAsync<TmdbCombinedCreditsResponse>(client, path, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogDebug(ex, "Search suggestions: TMDB combined credits failed for person {Id}", personId);
            return null;
        }
    }

    private static async Task<T?> GetJsonAsync<T>(HttpClient client, string path, CancellationToken ct)
    {
        using var response = await client.GetAsync(path, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return default;
        }

        var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, cancellationToken: ct).ConfigureAwait(false);
    }

    private async Task<Dictionary<string, Guid>> GetTmdbIndexAsync(CancellationToken cancellationToken)
    {
        var current = _tmdbIndex;
        if (current.HasValue && DateTime.UtcNow - current.Value.BuiltAt < IndexTtl)
        {
            return current.Value.ByTmdb;
        }

        await IndexLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            current = _tmdbIndex;
            if (current.HasValue && DateTime.UtcNow - current.Value.BuiltAt < IndexTtl)
            {
                return current.Value.ByTmdb;
            }

            var byTmdb = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
            }))
            {
                var tmdb = item.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb);
                if (!string.IsNullOrEmpty(tmdb))
                {
                    byTmdb.TryAdd((item is Movie ? "movie:" : "tv:") + tmdb, item.Id);
                }
            }

            _tmdbIndex = (DateTime.UtcNow, byTmdb);
            return byTmdb;
        }
        finally
        {
            IndexLock.Release();
        }
    }

    private sealed class TmdbMultiSearchResponse
    {
        [JsonPropertyName("results")]
        public List<TmdbItemResult>? Results { get; set; }
    }

    private sealed class TmdbItemResult
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("media_type")]
        public string? MediaType { get; set; }

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

        [JsonPropertyName("backdrop_path")]
        public string? BackdropPath { get; set; }

        [JsonPropertyName("genre_ids")]
        public List<int>? GenreIds { get; set; }
    }

    private sealed class TmdbDetailsResponse
    {
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("genres")]
        public List<TmdbNamedItem>? Genres { get; set; }

        [JsonPropertyName("created_by")]
        public List<TmdbNamedItem>? CreatedBy { get; set; }

        [JsonPropertyName("recommendations")]
        public TmdbResultContainer? Recommendations { get; set; }

        [JsonPropertyName("similar")]
        public TmdbResultContainer? Similar { get; set; }

        [JsonPropertyName("credits")]
        public TmdbCredits? Credits { get; set; }
    }

    private sealed class TmdbResultContainer
    {
        [JsonPropertyName("results")]
        public List<TmdbItemResult>? Results { get; set; }
    }

    private sealed class TmdbCredits
    {
        [JsonPropertyName("cast")]
        public List<TmdbNamedItem>? Cast { get; set; }

        [JsonPropertyName("crew")]
        public List<TmdbCrewMember>? Crew { get; set; }
    }

    private class TmdbNamedItem
    {
        [JsonPropertyName("name")]
        public string? Name { get; set; }
    }

    private sealed class TmdbCrewMember : TmdbNamedItem
    {
        [JsonPropertyName("job")]
        public string? Job { get; set; }
    }

    private sealed class TmdbCombinedCreditsResponse
    {
        [JsonPropertyName("cast")]
        public List<TmdbItemResult>? Cast { get; set; }

        [JsonPropertyName("crew")]
        public List<TmdbItemResult>? Crew { get; set; }
    }
}
