using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
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

public record GenreSearchResult
{
    public bool Found { get; init; } = true;
    public string? Name { get; init; }
    public string? Category { get; init; }
    public bool IsStandard { get; init; }
    public int? TmdbGenreId { get; init; }
    public int? KeywordId { get; init; }
    public string? OriginalLanguage { get; init; }
    public int? MatchCount { get; init; }
}

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

    private const string DefaultTmdbApiKey = "4219e299c89411838049ab0dab19ebd5";

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
        ["Sci Fi"] = 878,
        ["SciFi"] = 878,
        ["TV Movie"] = 10770,
        ["Thriller"] = 53,
        ["War"] = 10752,
        ["Western"] = 37,
        ["Action & Adventure"] = 28,
        ["Action and Adventure"] = 28,
        ["Sci-Fi & Fantasy"] = 878,
        ["Sci Fi & Fantasy"] = 878,
        ["War & Politics"] = 10752,
        // Common German localized genre names
        ["Abenteuer"] = 12,
        ["Komödie"] = 35,
        ["Krimi"] = 80,
        ["Dokumentation"] = 99,
        ["Familie"] = 10751,
        ["Liebesfilm"] = 10749,
        ["Krieg"] = 10752,
        ["Kriegsfilm"] = 10752,
        ["Musik"] = 10402,
        ["Historie"] = 36,
        ["Zeichentrick"] = 16,
        // Common French localized genre names
        ["Aventure"] = 12,
        ["Comédie"] = 35,
        ["Documentaire"] = 99,
        ["Drame"] = 18,
        ["Familial"] = 10751,
        ["Fantastique"] = 14,
        ["Histoire"] = 36,
        ["Horreur"] = 27,
        ["Musique"] = 10402,
        ["Mystère"] = 9648,
        ["Guerre"] = 10752,
        // Common Spanish localized genre names
        ["Acción"] = 28,
        ["Aventura"] = 12,
        ["Animación"] = 16,
        ["Comedia"] = 35,
        ["Crimen"] = 80,
        ["Documental"] = 99,
        ["Familia"] = 10751,
        ["Fantasía"] = 14,
        ["Historia"] = 36,
        ["Misterio"] = 9648,
        ["Película de TV"] = 10770,
        ["Suspense"] = 53,
        ["Bélica"] = 10752,
        ["Bélico"] = 10752,
        // Common Italian localized genre names
        ["Animazione"] = 16,
        ["Avventura"] = 12,
        ["Azione"] = 28,
        ["Commedia"] = 35,
        ["Documentario"] = 99,
        ["Dramma"] = 18,
        ["Drammatico"] = 18,
        ["Famiglia"] = 10751,
        ["Fantascienza"] = 878,
        ["Film TV"] = 10770,
        ["Guerra"] = 10752,
        ["Musica"] = 10402,
        ["Mistero"] = 9648,
        ["Orrore"] = 27,
        ["Romantico"] = 10749,
        ["Sentimentale"] = 10749,
        ["Storia"] = 36,
        ["televisione film"] = 10770,
        // Common Polish localized genre names
        ["Akcja"] = 28,
        ["Przygodowy"] = 12,
        ["Animacja"] = 16,
        ["Komedia"] = 35,
        ["Kryminał"] = 80,
        ["Dokumentalny"] = 99,
        ["Dramat"] = 18,
        ["Familijny"] = 10751,
        ["Historyczny"] = 36,
        ["Muzyczny"] = 10402,
        ["Tajemnica"] = 9648,
        ["Romans"] = 10749,
        ["Wojenny"] = 10752,
        // Common Portuguese localized genre names
        ["Ação"] = 28,
        ["Animação"] = 16,
        ["Comédia"] = 35,
        ["Documentário"] = 99,
        ["Família"] = 10751,
        ["Fantasia"] = 14,
        ["História"] = 36,
        ["Terror"] = 27,
        ["Música"] = 10402,
        ["Mistério"] = 9648,
        ["Ficção científica"] = 878,
        ["Cinema TV"] = 10770,
        ["Guerra"] = 10752,
        ["Faroeste"] = 37,
    };

    private static readonly Dictionary<string, int> TvGenreMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Action & Adventure"] = 10759,
        ["Action and Adventure"] = 10759,
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
        ["Sci-Fi and Fantasy"] = 10765,
        ["Science Fiction"] = 10765,
        ["Sci-Fi"] = 10765,
        ["Sci Fi"] = 10765,
        ["SciFi"] = 10765,
        ["Fantasy"] = 10765,
        ["Soap"] = 10766,
        ["Talk"] = 10767,
        ["War & Politics"] = 10768,
        ["War and Politics"] = 10768,
        ["War"] = 10768,
        ["Western"] = 37,
        // Common German localized genre names
        ["Abenteuer"] = 10759,
        ["Action & Abenteuer"] = 10759,
        ["Komödie"] = 35,
        ["Krimi"] = 80,
        ["Dokumentation"] = 99,
        ["Familie"] = 10751,
        ["Krieg"] = 10768,
        ["Kriegsfilm"] = 10768,
        ["Musik"] = 10402,
        ["Zeichentrick"] = 16,
        // Common French localized genre names
        ["Action et aventure"] = 10759,
        ["Aventure"] = 10759,
        ["Comédie"] = 35,
        ["Documentaire"] = 99,
        ["Drame"] = 18,
        ["Familial"] = 10751,
        ["Fantastique"] = 10765,
        ["Mystère"] = 9648,
        ["Guerre"] = 10768,
        // Common Spanish localized genre names
        ["Acción"] = 10759,
        ["Acción y aventura"] = 10759,
        ["Aventura"] = 10759,
        ["Animación"] = 16,
        ["Comedia"] = 35,
        ["Crimen"] = 80,
        ["Documental"] = 99,
        ["Familia"] = 10751,
        ["Fantasía"] = 10765,
        ["Misterio"] = 9648,
        ["Bélica"] = 10768,
        ["Bélico"] = 10768,
        // Common Italian localized genre names
        ["Azione e avventura"] = 10759,
        ["Azione"] = 10759,
        ["Avventura"] = 10759,
        ["Animazione"] = 16,
        ["Commedia"] = 35,
        ["Documentario"] = 99,
        ["Dramma"] = 18,
        ["Drammatico"] = 18,
        ["Famiglia"] = 10751,
        ["Bambini"] = 10762,
        ["Mistero"] = 9648,
        ["Fantascienza"] = 10765,
        ["Guerra e politica"] = 10768,
        ["Guerra"] = 10768,
        // Common Polish localized genre names
        ["Akcja i przygoda"] = 10759,
        ["Akcja"] = 10759,
        ["Przygodowy"] = 10759,
        ["Animacja"] = 16,
        ["Komedia"] = 35,
        ["Kryminał"] = 80,
        ["Dokumentalny"] = 99,
        ["Dramat"] = 18,
        ["Familijny"] = 10751,
        ["Dla dzieci"] = 10762,
        ["Tajemnica"] = 9648,
        ["Wiadomości"] = 10763,
        ["Sci-Fi i Fantasy"] = 10765,
        ["Opera mydlana"] = 10766,
        ["Talk-show"] = 10767,
        ["Wojna i polityka"] = 10768,
        ["Wojenny"] = 10768,
        // Common Portuguese localized genre names
        ["Ação e Aventura"] = 10759,
        ["Ação"] = 10759,
        ["Animação"] = 16,
        ["Comédia"] = 35,
        ["Documentário"] = 99,
        ["Família"] = 10751,
        ["Infantil"] = 10762,
        ["Mistério"] = 9648,
        ["Notícias"] = 10763,
        ["Ficção científica e Fantasia"] = 10765,
        ["Ficção científica"] = 10765,
        ["Fantasia"] = 10765,
        ["Novela"] = 10766,
        ["Guerra e Política"] = 10768,
        ["Faroeste"] = 37,
    };

    private static readonly Dictionary<string, (string Name, string Lang, int GenreId)> RegionalKeywordMap =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["c-drama"] = ("C-Drama", "zh", 18),
            ["cdrama"] = ("C-Drama", "zh", 18),
            ["c drama"] = ("C-Drama", "zh", 18),
            ["chinese drama"] = ("C-Drama", "zh", 18),
            ["c-dramas"] = ("C-Drama", "zh", 18),
            ["cdramas"] = ("C-Drama", "zh", 18),
            ["c dramas"] = ("C-Drama", "zh", 18),
            ["chinese dramas"] = ("C-Drama", "zh", 18),

            ["k-drama"] = ("K-Drama", "ko", 18),
            ["kdrama"] = ("K-Drama", "ko", 18),
            ["k drama"] = ("K-Drama", "ko", 18),
            ["korean drama"] = ("K-Drama", "ko", 18),
            ["k-dramas"] = ("K-Drama", "ko", 18),
            ["kdramas"] = ("K-Drama", "ko", 18),
            ["k dramas"] = ("K-Drama", "ko", 18),
            ["korean dramas"] = ("K-Drama", "ko", 18),

            ["j-drama"] = ("J-Drama", "ja", 18),
            ["jdrama"] = ("J-Drama", "ja", 18),
            ["j drama"] = ("J-Drama", "ja", 18),
            ["japanese drama"] = ("J-Drama", "ja", 18),
            ["j-dramas"] = ("J-Drama", "ja", 18),
            ["jdramas"] = ("J-Drama", "ja", 18),
            ["j dramas"] = ("J-Drama", "ja", 18),
            ["japanese dramas"] = ("J-Drama", "ja", 18),
        };

    private static readonly ConcurrentDictionary<string, int> KeywordMap = new(StringComparer.OrdinalIgnoreCase);

    private static readonly Lazy<MethodInfo?> GelatoDiscoverMethod = new(() =>
        Type.GetType("Gelato.GelatoPlugin, Gelato")?.GetMethod("DiscoverAsync", BindingFlags.Public | BindingFlags.Static));

    private static readonly Lazy<MethodInfo?> GelatoRegisterVirtualMethod = new(() =>
    {
        var type = Type.GetType("Gelato.GelatoPlugin, Gelato");
        if (type == null)
        {
            return null;
        }

        return type.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "RegisterVirtualTitle")
            .OrderByDescending(m => m.GetParameters().Length)
            .FirstOrDefault();
    });

    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<GenreCount> Counts)> _counts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<IReadOnlyList<GenreCount>>> _countsBuilding = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<BaseItemDto> Items)> _rows = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, List<BaseItemDto> Items, int LastMoviePage, int LastTvPage, bool MovieExhausted, bool TvExhausted)> _virtualGenreCache = new(StringComparer.OrdinalIgnoreCase);

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

        var targetCount = startIndex + limit;
        var virtualDtos = await GetVirtualItemsAsync(genre, types, targetCount, tokenOverride, cancellationToken).ConfigureAwait(false);
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

        var cacheKey = genre + "|" + string.Join(',', types.OrderBy(t => t));
        var isExhausted = _virtualGenreCache.TryGetValue(cacheKey, out var cacheHit) && cacheHit.MovieExhausted && cacheHit.TvExhausted;
        var totalCount = isExhausted ? combined.Count : Math.Max(combined.Count, combined.Count + 100);

        return (paged, totalCount);
    }

    public async Task<GenreSearchResult> SearchGenreOrCategoryAsync(string query, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return new GenreSearchResult { Found = false };
        }

        var trimmed = query.Trim();

        // 1. Special-case popular Asian drama / regional keywords
        if (RegionalKeywordMap.TryGetValue(trimmed, out var regional))
        {
            return new GenreSearchResult
            {
                Found = true,
                Name = regional.Name,
                Category = "country_genre",
                IsStandard = false,
                TmdbGenreId = regional.GenreId,
                OriginalLanguage = regional.Lang,
                MatchCount = GetLocalGenreCount(regional.Name),
            };
        }

        // 2. Check local library genres and standard TMDB MovieGenreMap / TvGenreMap
        string? standardName = null;
        int? standardGenreId = null;

        var movieKey = MovieGenreMap.Keys.FirstOrDefault(k => string.Equals(k, trimmed, StringComparison.OrdinalIgnoreCase));
        if (movieKey != null)
        {
            standardName = movieKey;
            standardGenreId = MovieGenreMap[movieKey];
        }
        else
        {
            var tvKey = TvGenreMap.Keys.FirstOrDefault(k => string.Equals(k, trimmed, StringComparison.OrdinalIgnoreCase));
            if (tvKey != null)
            {
                standardName = tvKey;
                standardGenreId = TvGenreMap[tvKey];
            }
        }

        var localName = GetLocalGenreName(trimmed);
        var localCount = GetLocalGenreCount(trimmed);

        if (standardName != null || localName != null)
        {
            var matchedName = standardName ?? localName!;
            return new GenreSearchResult
            {
                Found = true,
                Name = matchedName,
                Category = "genre",
                IsStandard = true,
                TmdbGenreId = standardGenreId,
                MatchCount = localCount ?? GetLocalGenreCount(matchedName),
            };
        }

        // 3. Query TMDB API /search/keyword
        if (httpClientFactory == null)
        {
            return new GenreSearchResult { Found = false };
        }

        try
        {
            var token = JellioPlugin.Instance?.Configuration.TmdbAccessToken;
            var useDefaultKey = string.IsNullOrWhiteSpace(token);
            var activeToken = useDefaultKey ? DefaultTmdbApiKey : token!.Trim();

            var client = httpClientFactory.CreateClient("tmdb");
            client.BaseAddress = new Uri("https://api.themoviedb.org/3/");
            if (!useDefaultKey && (activeToken.Length > 40 || activeToken.StartsWith("ey", StringComparison.OrdinalIgnoreCase)))
            {
                client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", activeToken);
            }
            client.Timeout = TimeSpan.FromSeconds(8);

            var queryKey = (useDefaultKey || activeToken.Length <= 40)
                ? $"&api_key={Uri.EscapeDataString(activeToken)}"
                : string.Empty;

            var path = $"search/keyword?query={Uri.EscapeDataString(trimmed)}{queryKey}";
            using var response = await client.GetAsync(path, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return new GenreSearchResult { Found = false };
            }

            var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var payload = await JsonSerializer.DeserializeAsync<TmdbKeywordSearchResponse>(stream, JsonOptions, ct).ConfigureAwait(false);
            if (payload?.Results == null || payload.Results.Count == 0)
            {
                return new GenreSearchResult { Found = false };
            }

            var exactMatch = payload.Results.FirstOrDefault(r => string.Equals(r.Name?.Trim(), trimmed, StringComparison.OrdinalIgnoreCase));
            var match = exactMatch ?? payload.Results.FirstOrDefault(r => !string.IsNullOrWhiteSpace(r.Name));
            if (match == null || string.IsNullOrWhiteSpace(match.Name))
            {
                return new GenreSearchResult { Found = false };
            }

            var cleanName = CultureInfo.CurrentCulture.TextInfo.ToTitleCase(match.Name.Trim().ToLowerInvariant());
            KeywordMap[cleanName] = match.Id;
            KeywordMap[match.Name.Trim()] = match.Id;
            KeywordMap[trimmed] = match.Id;

            return new GenreSearchResult
            {
                Found = true,
                Name = cleanName,
                Category = "keyword",
                IsStandard = false,
                KeywordId = match.Id,
                MatchCount = payload.TotalResults > 0 ? payload.TotalResults : null,
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(ex, "Jellio: TMDB keyword search failed for {Query}", trimmed);
            return new GenreSearchResult { Found = false };
        }
    }

    private string? GetLocalGenreName(string query)
    {
        foreach (var entry in _counts.Values)
        {
            var hit = entry.Counts.FirstOrDefault(c => string.Equals(c.Name, query, StringComparison.OrdinalIgnoreCase));
            if (hit != null)
            {
                return hit.Name;
            }
        }

        try
        {
            var queryResult = libraryManager.GetGenres(new InternalItemsQuery { Recursive = true });
            if (queryResult?.Items != null)
            {
                var hit = queryResult.Items.FirstOrDefault(g => string.Equals(g.Item?.Name, query, StringComparison.OrdinalIgnoreCase));
                if (hit.Item?.Name != null)
                {
                    return hit.Item.Name;
                }
            }
        }
        catch
        {
            // Ignored if libraryManager is mocked or does not implement GetGenres
        }

        return null;
    }

    private int? GetLocalGenreCount(string query)
    {
        foreach (var entry in _counts.Values)
        {
            var hit = entry.Counts.FirstOrDefault(c => string.Equals(c.Name, query, StringComparison.OrdinalIgnoreCase));
            if (hit != null)
            {
                return hit.Count;
            }
        }

        try
        {
            var queryResult = libraryManager.GetGenres(new InternalItemsQuery { Recursive = true });
            if (queryResult?.Items != null)
            {
                var hit = queryResult.Items.FirstOrDefault(g => string.Equals(g.Item?.Name, query, StringComparison.OrdinalIgnoreCase));
                if (hit.ItemCounts != null)
                {
                    return hit.ItemCounts.ItemCount;
                }
            }
        }
        catch
        {
            // Ignored if libraryManager is mocked or does not implement GetGenres
        }

        return null;
    }

    private async Task<(int? MovieGenreId, int? TvGenreId, string? OriginalLanguage, int? KeywordId, string CanonicalName, bool IsStandard)> ResolveGenreSpecAsync(
        string genre,
        CancellationToken cancellationToken)
    {
        var trimmed = genre.Trim();

        // 1. Regional Asian dramas
        if (RegionalKeywordMap.TryGetValue(trimmed, out var regional))
        {
            return (regional.GenreId, regional.GenreId, regional.Lang, null, regional.Name, false);
        }

        // 2. Standard movie/tv genre maps
        int? movieGenreId = null;
        int? tvGenreId = null;
        string? canonicalName = null;

        var movieMatch = MovieGenreMap.Keys.FirstOrDefault(k => string.Equals(k, trimmed, StringComparison.OrdinalIgnoreCase));
        if (movieMatch != null)
        {
            movieGenreId = MovieGenreMap[movieMatch];
            canonicalName = movieMatch;
        }

        var tvMatch = TvGenreMap.Keys.FirstOrDefault(k => string.Equals(k, trimmed, StringComparison.OrdinalIgnoreCase));
        if (tvMatch != null)
        {
            tvGenreId = TvGenreMap[tvMatch];
            canonicalName ??= tvMatch;
        }

        if (movieGenreId.HasValue || tvGenreId.HasValue)
        {
            return (movieGenreId, tvGenreId, null, null, canonicalName ?? trimmed, true);
        }

        // 3. Keyword map
        if (KeywordMap.TryGetValue(trimmed, out var kwId))
        {
            return (null, null, null, kwId, CultureInfo.CurrentCulture.TextInfo.ToTitleCase(trimmed.ToLowerInvariant()), false);
        }

        // Check if prefixed with keyword:
        if (trimmed.StartsWith("keyword:", StringComparison.OrdinalIgnoreCase))
        {
            var parts = trimmed.Split(':');
            if (parts.Length >= 2 && int.TryParse(parts[1], out var parsedId))
            {
                var kwName = parts.Length >= 3 ? parts[2] : trimmed;
                return (null, null, null, parsedId, CultureInfo.CurrentCulture.TextInfo.ToTitleCase(kwName.ToLowerInvariant()), false);
            }
        }

        // Try searching TMDB keyword
        var searchResult = await SearchGenreOrCategoryAsync(trimmed, cancellationToken).ConfigureAwait(false);
        if (searchResult.Found)
        {
            if (searchResult.KeywordId.HasValue)
            {
                return (null, null, null, searchResult.KeywordId.Value, searchResult.Name ?? trimmed, false);
            }

            if (searchResult.OriginalLanguage != null)
            {
                return (searchResult.TmdbGenreId, searchResult.TmdbGenreId, searchResult.OriginalLanguage, null, searchResult.Name ?? trimmed, false);
            }

            if (searchResult.TmdbGenreId.HasValue)
            {
                return (searchResult.TmdbGenreId, searchResult.TmdbGenreId, null, null, searchResult.Name ?? trimmed, searchResult.IsStandard);
            }
        }

        return (null, null, null, null, trimmed, false);
    }

    public async Task<IReadOnlyList<BaseItemDto>> GetVirtualItemsAsync(
        string genre,
        BaseItemKind[] types,
        int targetCount = 60,
        string? tokenOverride = null,
        CancellationToken cancellationToken = default)
    {
        if (httpClientFactory == null)
        {
            return Array.Empty<BaseItemDto>();
        }

        var token = !string.IsNullOrWhiteSpace(tokenOverride)
            ? tokenOverride
            : JellioPlugin.Instance?.Configuration.TmdbAccessToken;

        var useDefaultKey = string.IsNullOrWhiteSpace(token);
        var activeToken = useDefaultKey ? DefaultTmdbApiKey : token!.Trim();

        var (movieGenreId, tvGenreId, originalLanguage, keywordId, canonicalName, isStandard) =
            await ResolveGenreSpecAsync(genre, cancellationToken).ConfigureAwait(false);

        var cacheKey = canonicalName + "|" + string.Join(',', types.OrderBy(t => t));
        List<BaseItemDto> virtualItems;
        int lastMoviePage = 0;
        int lastTvPage = 0;
        bool movieExhausted = !types.Contains(BaseItemKind.Movie) || (!movieGenreId.HasValue && !keywordId.HasValue);
        bool tvExhausted = !types.Contains(BaseItemKind.Series) || (!tvGenreId.HasValue && !keywordId.HasValue);

        if (_virtualGenreCache.TryGetValue(cacheKey, out var hit) && DateTime.UtcNow - hit.At < VirtualTtl)
        {
            if (hit.Items.Count >= targetCount || (hit.MovieExhausted && hit.TvExhausted))
            {
                return hit.Items;
            }

            virtualItems = new List<BaseItemDto>(hit.Items);
            lastMoviePage = hit.LastMoviePage;
            lastTvPage = hit.LastTvPage;
            movieExhausted = hit.MovieExhausted;
            tvExhausted = hit.TvExhausted;
        }
        else
        {
            virtualItems = new List<BaseItemDto>();
        }

        // Try delegating discovery to Gelato if Gelato is available in the AppDomain
        // Only standard built-in genres are supported by Gelato's static genre dictionaries
        if (isStandard && !keywordId.HasValue && string.IsNullOrEmpty(originalLanguage))
        {
            try
            {
                var discoverMethod = GelatoDiscoverMethod.Value;
                if (discoverMethod != null)
                {
                    var paramCount = discoverMethod.GetParameters().Length;
                    var typesParam = string.Join(',', types.Select(t => t == BaseItemKind.Movie ? "movie" : "tv"));
                    var seen = new HashSet<Guid>(virtualItems.Select(v => v.Id));
                    var nextPage = lastMoviePage + 1;

                    while (virtualItems.Count < targetCount && !movieExhausted && nextPage <= 25)
                    {
                        object?[] args = paramCount == 4
                            ? [canonicalName, nextPage, null, cancellationToken]
                            : [canonicalName, typesParam, nextPage, null, cancellationToken];
                        var task = (Task<List<BaseItemDto>>)discoverMethod.Invoke(null, args)!;
                        var gelatoItems = await task.ConfigureAwait(false);
                        if (gelatoItems == null || gelatoItems.Count == 0)
                        {
                            movieExhausted = true;
                            tvExhausted = true;
                            break;
                        }

                        lastMoviePage = nextPage;
                        nextPage++;
                        foreach (var dto in gelatoItems)
                        {
                            if (seen.Add(dto.Id))
                            {
                                virtualItems.Add(dto);
                            }
                        }
                    }

                    if (virtualItems.Count > 0 || lastMoviePage > 0)
                    {
                        _virtualGenreCache[cacheKey] = (DateTime.UtcNow, virtualItems, lastMoviePage, lastTvPage, movieExhausted, tvExhausted);
                        return virtualItems;
                    }

                    movieExhausted = !types.Contains(BaseItemKind.Movie) || !movieGenreId.HasValue;
                    tvExhausted = !types.Contains(BaseItemKind.Series) || !tvGenreId.HasValue;
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Jellio: Gelato discovery delegation unavailable, falling back to direct TMDB");
            }
        }

        static async Task<(string MediaType, int Page, IReadOnlyList<BaseItemDto> Items, int TotalPages)> FetchPageAsync(
            Func<Task<(IReadOnlyList<BaseItemDto> Items, int TotalPages)>> fetcher,
            string mediaType,
            int page)
        {
            var res = await fetcher().ConfigureAwait(false);
            return (mediaType, page, res.Items, res.TotalPages);
        }

        try
        {
            var client = httpClientFactory.CreateClient("tmdb");
            client.BaseAddress = new Uri("https://api.themoviedb.org/3/");
            if (!useDefaultKey && (activeToken.Length > 40 || activeToken.StartsWith("ey", StringComparison.OrdinalIgnoreCase)))
            {
                client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", activeToken);
            }
            client.Timeout = TimeSpan.FromSeconds(8);

            var queryKey = (useDefaultKey || activeToken.Length <= 40)
                ? $"&api_key={Uri.EscapeDataString(activeToken)}"
                : string.Empty;

            var seenTmdb = new HashSet<string>(virtualItems
                .Where(it => it.ProviderIds != null && it.ProviderIds.ContainsKey("Tmdb"))
                .Select(it => it.ProviderIds!["Tmdb"]),
                StringComparer.OrdinalIgnoreCase);

            var iterations = 0;
            while (virtualItems.Count < targetCount && (!movieExhausted || !tvExhausted) && iterations < 5)
            {
                iterations++;
                var tasks = new List<Task<(string MediaType, int Page, IReadOnlyList<BaseItemDto> Items, int TotalPages)>>();

                if (!movieExhausted && (movieGenreId.HasValue || keywordId.HasValue))
                {
                    var nextMoviePage = lastMoviePage + 1;
                    tasks.Add(FetchPageAsync(
                        () => FetchTmdbDiscoverAsync(client, "movie", movieGenreId, keywordId, originalLanguage, canonicalName, nextMoviePage, queryKey, cancellationToken),
                        "movie",
                        nextMoviePage));
                }

                if (!tvExhausted && (tvGenreId.HasValue || keywordId.HasValue))
                {
                    var nextTvPage = lastTvPage + 1;
                    tasks.Add(FetchPageAsync(
                        () => FetchTmdbDiscoverAsync(client, "tv", tvGenreId, keywordId, originalLanguage, canonicalName, nextTvPage, queryKey, cancellationToken),
                        "tv",
                        nextTvPage));
                }

                if (tasks.Count == 0)
                {
                    break;
                }

                var results = await Task.WhenAll(tasks).ConfigureAwait(false);
                var addedAny = false;

                foreach (var res in results)
                {
                    if (res.MediaType == "movie")
                    {
                        lastMoviePage = res.Page;
                        if (res.Items.Count < 20 || res.TotalPages <= 1 || res.Page >= res.TotalPages)
                        {
                            movieExhausted = true;
                        }
                    }
                    else
                    {
                        lastTvPage = res.Page;
                        if (res.Items.Count < 20 || res.TotalPages <= 1 || res.Page >= res.TotalPages)
                        {
                            tvExhausted = true;
                        }
                    }

                    foreach (var item in res.Items)
                    {
                        if (item.ProviderIds != null && item.ProviderIds.TryGetValue("Tmdb", out var tmdbId) && seenTmdb.Add(tmdbId))
                        {
                            virtualItems.Add(item);
                            addedAny = true;
                        }
                    }
                }

                if (!addedAny && (movieExhausted || !types.Contains(BaseItemKind.Movie)) && (tvExhausted || !types.Contains(BaseItemKind.Series)))
                {
                    break;
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

        _virtualGenreCache[cacheKey] = (DateTime.UtcNow, virtualItems, lastMoviePage, lastTvPage, movieExhausted, tvExhausted);
        return virtualItems;
    }

    private static async Task<(IReadOnlyList<BaseItemDto> Items, int TotalPages)> FetchTmdbDiscoverAsync(
        HttpClient client,
        string kind,
        int? genreId,
        int? keywordId,
        string? originalLanguage,
        string genreName,
        int page,
        string queryKey,
        CancellationToken cancellationToken)
    {
        var isMovie = kind == "movie";
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var dateFilter = isMovie ? $"&primary_release_date.lte={today}" : $"&first_air_date.lte={today}";
        var genreFilter = genreId.HasValue ? $"&with_genres={genreId.Value}" : string.Empty;
        var langFilter = !string.IsNullOrWhiteSpace(originalLanguage) ? $"&with_original_language={Uri.EscapeDataString(originalLanguage)}" : string.Empty;
        var keywordFilter = keywordId.HasValue ? $"&with_keywords={keywordId.Value}" : string.Empty;

        var path = $"discover/{kind}?include_adult=false&sort_by=popularity.desc&page={page}{genreFilter}{langFilter}{keywordFilter}{dateFilter}{queryKey}";

        using var response = await client.GetAsync(path, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return (Array.Empty<BaseItemDto>(), 0);
        }

        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var payload = await JsonSerializer.DeserializeAsync<TmdbDiscoverResponse>(stream, JsonOptions, cancellationToken).ConfigureAwait(false);
        if (payload?.Results == null || payload.Results.Count == 0)
        {
            return (Array.Empty<BaseItemDto>(), payload?.TotalPages ?? 0);
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

                if (DateTime.TryParse(dateStr, out var releaseDate) && releaseDate > DateTime.UtcNow.AddDays(7))
                {
                    continue;
                }
            }

            var tmdbIdStr = result.Id.ToString();
            var posterUrl = !string.IsNullOrWhiteSpace(result.PosterPath)
                ? $"https://image.tmdb.org/t/p/w500{result.PosterPath}"
                : null;
            var backdropUrl = !string.IsNullOrWhiteSpace(result.BackdropPath)
                ? $"https://image.tmdb.org/t/p/w1280{result.BackdropPath}"
                : null;

            var imageTags = new Dictionary<ImageType, string>();
            if (posterUrl != null)
            {
                imageTags[ImageType.Primary] = posterUrl;
            }

            var backdropTags = backdropUrl != null ? new[] { backdropUrl } : Array.Empty<string>();

            var providerIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Tmdb"] = tmdbIdStr,
            };
            if (posterUrl != null)
            {
                providerIds["TmdbPoster"] = posterUrl;
            }

            var rating = result.VoteAverage.HasValue ? (float)result.VoteAverage.Value : (float?)null;
            var itemId = GenerateDeterministicId(isMovie ? "movie" : "tv", tmdbIdStr);
            RegisterVirtualWithGelato(itemId, title, year, isMovie ? "movie" : "tv", tmdbIdStr, null, posterUrl, backdropUrl, rating, result.Overview, [genreName]);

            list.Add(new BaseItemDto
            {
                Id = itemId,
                Name = title,
                ProductionYear = year,
                CommunityRating = rating,
                ProviderIds = providerIds,
                Type = isMovie ? BaseItemKind.Movie : BaseItemKind.Series,
                LocationType = LocationType.Virtual,
                Overview = result.Overview,
                Genres = [genreName],
                PrimaryImageAspectRatio = 2.0 / 3.0,
                ImageTags = imageTags,
                BackdropImageTags = backdropTags,
            });
        }

        return (list, payload.TotalPages);
    }

    private static void RegisterVirtualWithGelato(
        Guid guid,
        string name,
        int? year,
        string mediaType,
        string tmdbId,
        string? imdbId,
        string? posterUrl,
        string? backdropUrl,
        float? rating,
        string? overview,
        IReadOnlyList<string>? genres = null)
    {
        try
        {
            var regMethod = GelatoRegisterVirtualMethod.Value;
            if (regMethod != null)
            {
                var paramCount = regMethod.GetParameters().Length;
                if (paramCount == 8)
                {
                    regMethod.Invoke(null, [guid, mediaType, tmdbId, name, year, imdbId, posterUrl, genres]);
                }
                else if (paramCount == 11)
                {
                    regMethod.Invoke(null, [guid, name, year, mediaType, tmdbId, imdbId, posterUrl, backdropUrl, rating, overview, genres]);
                }
                else if (paramCount == 10)
                {
                    regMethod.Invoke(null, [guid, name, year, mediaType, tmdbId, imdbId, posterUrl, backdropUrl, rating, overview]);
                }
                else if (paramCount == 7)
                {
                    regMethod.Invoke(null, [guid, mediaType, tmdbId, name, year, imdbId, posterUrl]);
                }
            }
        }
        catch
        {
            // Best effort registration with Gelato
        }
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
        [JsonPropertyName("page")]
        public int Page { get; set; }

        [JsonPropertyName("total_pages")]
        public int TotalPages { get; set; }

        [JsonPropertyName("total_results")]
        public int TotalResults { get; set; }

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

        [JsonPropertyName("backdrop_path")]
        public string? BackdropPath { get; set; }
    }

    private sealed class TmdbKeywordSearchResponse
    {
        [JsonPropertyName("page")]
        public int Page { get; set; }

        [JsonPropertyName("total_pages")]
        public int TotalPages { get; set; }

        [JsonPropertyName("total_results")]
        public int TotalResults { get; set; }

        [JsonPropertyName("results")]
        public List<TmdbKeywordItem>? Results { get; set; }
    }

    private sealed class TmdbKeywordItem
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }
    }
}
