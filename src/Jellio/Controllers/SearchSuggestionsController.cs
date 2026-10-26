using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// "You might like" for a search that found nothing, the way Netflix answers
/// a title it doesn't carry: the query is looked up on TMDB, and the library
/// is searched for that title's TMDB recommendations and similar titles, its
/// lead actors and director, and the best rated titles of its genres.
/// </summary>
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
    private static readonly ConcurrentDictionary<string, (DateTime At, TmdbTitle? Title)> TitleCache = new();

    public record SuggestionRow(string Kind, string? Name, IReadOnlyList<BaseItemDto> Items);

    public record SuggestionsResponse(string? MatchedTitle, IReadOnlyList<SuggestionRow> Rows);

    [HttpGet]
    public async Task<ActionResult<SuggestionsResponse>> Get([FromQuery] string query, CancellationToken cancellationToken)
    {
        var token = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
        var userId = HttpContext.User.Identity is ClaimsIdentity identity && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var id) ? id : Guid.Empty;
        var user = userManager.GetUserById(userId);
        if (string.IsNullOrWhiteSpace(query) || string.IsNullOrWhiteSpace(token) || user == null)
        {
            return new SuggestionsResponse(null, []);
        }

        var title = await LookUpAsync(query.Trim(), token, cancellationToken).ConfigureAwait(false);
        if (title == null)
        {
            return new SuggestionsResponse(null, []);
        }

        var dtoOptions = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres],
            EnableUserData = true,
            EnableImages = true,
        };
        var used = new HashSet<Guid>();
        var rows = new List<SuggestionRow>();

        void AddRow(string kind, string? name, IEnumerable<BaseItem> items)
        {
            var picked = items.Where(item => used.Add(item.Id)).Take(RowSize).ToList();
            if (picked.Count > 0)
            {
                rows.Add(new SuggestionRow(kind, name, dtoService.GetBaseItemDtos(picked, dtoOptions, user)));
            }
        }

        var index = await GetTmdbIndexAsync(cancellationToken).ConfigureAwait(false);
        var similar = title.RelatedTmdbIds
            .Select(tmdbId => index.TryGetValue(tmdbId, out var itemId) ? libraryManager.GetItemById(itemId) : null)
            .Where(item => item != null && item.IsVisible(user))
            .Select(item => item!);
        AddRow("similar", null, similar);

        foreach (var person in title.People.Take(3))
        {
            var personItem = libraryManager.GetPerson(person);
            if (personItem == null)
            {
                continue;
            }

            AddRow("person", person, libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
                PersonIds = [personItem.Id],
                OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                Limit = RowSize * 2,
            }));
        }

        if (title.Genres.Count > 0)
        {
            AddRow("genre", title.Genres[0], libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [title.IsMovie ? BaseItemKind.Movie : BaseItemKind.Series],
                Recursive = true,
                Genres = title.Genres.Take(2).ToArray(),
                OrderBy = [(ItemSortBy.CommunityRating, SortOrder.Descending)],
                Limit = RowSize * 2,
            }));
        }

        return new SuggestionsResponse(title.Name, rows);
    }

    // Movie and series TMDB ids in the library, rebuilt every IndexTtl.
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

            var byTmdb = new Dictionary<string, Guid>();
            foreach (var item in libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
            }))
            {
                var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
                if (!string.IsNullOrEmpty(tmdb))
                {
                    byTmdb.TryAdd((item is MediaBrowser.Controller.Entities.Movies.Movie ? "movie:" : "tv:") + tmdb, item.Id);
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

    private sealed record TmdbTitle(string Name, bool IsMovie, List<string> RelatedTmdbIds, List<string> People, List<string> Genres);

    private async Task<TmdbTitle?> LookUpAsync(string query, string token, CancellationToken cancellationToken)
    {
        var key = query.ToLowerInvariant();
        if (TitleCache.TryGetValue(key, out var cachedTitle) && DateTime.UtcNow - cachedTitle.At < TimeSpan.FromHours(6))
        {
            return cachedTitle.Title;
        }

        TmdbTitle? result = null;
        try
        {
            using var client = httpClientFactory.CreateClient();
            client.BaseAddress = new Uri("https://api.themoviedb.org/3/");
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            client.Timeout = TimeSpan.FromSeconds(8);

            var search = await GetJsonAsync<SearchResponse>(client, "search/multi?include_adult=false&query=" + Uri.EscapeDataString(query), cancellationToken).ConfigureAwait(false);
            var hit = search?.Results?.FirstOrDefault(r => r.MediaType is "movie" or "tv");
            if (hit != null)
            {
                var isMovie = hit.MediaType == "movie";
                var kind = isMovie ? "movie" : "tv";
                var details = await GetJsonAsync<DetailsResponse>(client, kind + "/" + hit.Id + "?append_to_response=recommendations,similar,credits", cancellationToken).ConfigureAwait(false);
                if (details != null)
                {
                    var related = (details.Recommendations?.Results ?? [])
                        .Concat(details.Similar?.Results ?? [])
                        .Select(r => kind + ":" + r.Id)
                        .Distinct()
                        .ToList();
                    var people = new List<string>();
                    people.AddRange((details.Credits?.Crew ?? []).Where(c => c.Job is "Director").Select(c => c.Name!).Where(n => n != null));
                    people.AddRange((details.CreatedBy ?? []).Select(c => c.Name!).Where(n => n != null));
                    people.AddRange((details.Credits?.Cast ?? []).Take(2).Select(c => c.Name!).Where(n => n != null));
                    var genres = (details.Genres ?? []).Select(g => g.Name!).Where(n => n != null).ToList();
                    result = new TmdbTitle(details.Title ?? details.Name ?? query, isMovie, related, people.Distinct().ToList(), genres);
                }
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogDebug(ex, "Search suggestions: TMDB lookup failed for {Query}", query);
            return null;
        }

        if (TitleCache.Count > 500)
        {
            TitleCache.Clear();
        }

        TitleCache[key] = (DateTime.UtcNow, result);
        return result;
    }

    private static async Task<T?> GetJsonAsync<T>(HttpClient client, string path, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(path, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return default;
        }

        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return await JsonSerializer.DeserializeAsync<T>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private sealed class SearchResponse
    {
        [JsonPropertyName("results")] public List<SearchHit>? Results { get; set; }
    }

    private sealed class SearchHit
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("media_type")] public string? MediaType { get; set; }
    }

    private sealed class DetailsResponse
    {
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("genres")] public List<Named>? Genres { get; set; }
        [JsonPropertyName("created_by")] public List<Named>? CreatedBy { get; set; }
        [JsonPropertyName("recommendations")] public ResultList? Recommendations { get; set; }
        [JsonPropertyName("similar")] public ResultList? Similar { get; set; }
        [JsonPropertyName("credits")] public Credits? Credits { get; set; }
    }

    private sealed class ResultList
    {
        [JsonPropertyName("results")] public List<SearchHit>? Results { get; set; }
    }

    private sealed class Credits
    {
        [JsonPropertyName("cast")] public List<Named>? Cast { get; set; }
        [JsonPropertyName("crew")] public List<CrewMember>? Crew { get; set; }
    }

    private class Named
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
    }

    private sealed class CrewMember : Named
    {
        [JsonPropertyName("job")] public string? Job { get; set; }
    }
}
