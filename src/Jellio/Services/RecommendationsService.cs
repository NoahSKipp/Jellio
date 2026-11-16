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
using Microsoft.Extensions.Logging;
using Jellio.Extensions;
using Jellio.Services.Friends;

namespace Jellio.Services;

public class RecommendationsService(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    IDtoService dtoService,
    IHttpClientFactory httpClientFactory,
    ILogger<RecommendationsService> logger,
    NextUpHiddenStore? nextUpHiddenStore = null,
    FriendsService? friendsService = null)
{
    private const double LikedSeedWeight = 2.5;
    private const double WatchlistSeedWeight = 0.8;
    private const double DefaultSeedWeight = 1.0;
    private const double RecencyHalfLifeDays = 21.0;
    private const double BingeRewatchBonus = 0.5;

    private static readonly TimeSpan IndexTtl = TimeSpan.FromMinutes(15);
    private static readonly SemaphoreSlim IndexLock = new(1, 1);
    private static (DateTime BuiltAt, Dictionary<string, Guid> ByTmdb)? _tmdbIndex;

    private static readonly TimeSpan TmdbCacheTtl = TimeSpan.FromHours(6);
    private static readonly ConcurrentDictionary<string, (DateTime At, List<TmdbItemResult> Results)> TmdbRecCache = new(StringComparer.OrdinalIgnoreCase);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private sealed record SeedCandidate(
        BaseItem Item,
        double Weight,
        int? TmdbId,
        bool IsMovie);

    public async Task<IReadOnlyList<BaseItemDto>> GetTopPicksAsync(
        User user,
        int limit = 20,
        bool enableVirtual = true,
        CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var excludedItemIds = new HashSet<Guid>();
        var excludedTmdbKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hiddenSeriesIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // 1. Next Up hidden series
        if (nextUpHiddenStore != null)
        {
            var hidden = nextUpHiddenStore.Load(user.Id);
            if (hidden != null)
            {
                foreach (var h in hidden)
                {
                    hiddenSeriesIds.Add(h);
                    if (Guid.TryParse(h, out var g))
                    {
                        hiddenSeriesIds.Add(g.ToString("N"));
                        excludedItemIds.Add(g);
                    }
                }
            }
        }

        // 2. Gather positive and negative taste signals
        var allLibraryItems = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            Recursive = true,
        }) ?? [];

        foreach (var item in allLibraryItems)
        {
            var data = userDataManager.GetUserData(user, item);
            if (data == null)
            {
                continue;
            }

            // Exclude disliked items
            if (data.Likes == false)
            {
                excludedItemIds.Add(item.Id);
                var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
                if (!string.IsNullOrEmpty(tmdb))
                {
                    excludedTmdbKeys.Add((item is Movie ? "movie:" : "tv:") + tmdb);
                }
            }
            // Exclude already played movies and series
            else if (data.Played)
            {
                excludedItemIds.Add(item.Id);
            }
        }

        // Parent series tracking for played/paused episodes
        var playedEpisodes = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Episode],
            IsPlayed = true,
            OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
            Recursive = true,
            Limit = 200,
        }) ?? [];

        var episodeCountsBySeries = new Dictionary<Guid, int>();
        var seriesLastPlayedDates = new Dictionary<Guid, DateTime>();

        foreach (var epItem in playedEpisodes)
        {
            if (epItem is not Episode ep || ep.SeriesId == Guid.Empty)
            {
                continue;
            }

            episodeCountsBySeries[ep.SeriesId] = episodeCountsBySeries.GetValueOrDefault(ep.SeriesId) + 1;
            var epData = userDataManager.GetUserData(user, ep);
            if (epData?.LastPlayedDate.HasValue == true)
            {
                var dt = epData.LastPlayedDate.Value;
                if (!seriesLastPlayedDates.TryGetValue(ep.SeriesId, out var existing) || dt > existing)
                {
                    seriesLastPlayedDates[ep.SeriesId] = dt;
                }
            }
        }

        // Build seed candidates
        var seedList = new List<SeedCandidate>();
        var seenSeedIds = new HashSet<Guid>();

        foreach (var item in allLibraryItems)
        {
            var data = userDataManager.GetUserData(user, item);
            if (data?.Likes == false)
            {
                continue;
            }

            var isMovie = item is Movie;
            var isSeries = item is Series;
            if (!isMovie && !isSeries)
            {
                continue;
            }

            var isLiked = data?.Likes == true;
            var isFav = data?.IsFavorite == true;
            var isPlayed = data?.Played == true;
            var hasPlayedEpisodes = isSeries && episodeCountsBySeries.ContainsKey(item.Id);

            if (!isLiked && !isFav && !isPlayed && !hasPlayedEpisodes)
            {
                continue;
            }

            double baseWeight = isLiked
                ? LikedSeedWeight
                : (isFav ? WatchlistSeedWeight : DefaultSeedWeight);

            // Recency decay
            DateTime? playedDate = data?.LastPlayedDate;
            if (isSeries && (!playedDate.HasValue || playedDate == DateTime.MinValue))
            {
                if (seriesLastPlayedDates.TryGetValue(item.Id, out var epDate))
                {
                    playedDate = epDate;
                }
            }

            if (playedDate.HasValue && playedDate.Value > DateTime.MinValue)
            {
                var daysAgo = Math.Max(0, (now - playedDate.Value).TotalDays);
                baseWeight *= Math.Exp(-daysAgo / RecencyHalfLifeDays);
            }
            else if (!isLiked && !isFav)
            {
                baseWeight *= 0.4;
            }

            // Binge / rewatch bonus
            var playCount = data?.PlayCount ?? 0;
            var epCount = isSeries ? episodeCountsBySeries.GetValueOrDefault(item.Id) : 0;
            if (playCount > 1 || epCount >= 3)
            {
                baseWeight += BingeRewatchBonus;
            }

            int? tmdbId = null;
            var tmdbStr = item.GetProviderId(MetadataProvider.Tmdb);
            if (!string.IsNullOrEmpty(tmdbStr) && int.TryParse(tmdbStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                tmdbId = parsed;
            }

            if (seenSeedIds.Add(item.Id))
            {
                seedList.Add(new SeedCandidate(item, baseWeight, tmdbId, isMovie));
            }
        }

        // 3. Take top 6 weighted seeds with TMDB IDs
        var topSeeds = seedList
            .Where(s => s.TmdbId.HasValue && s.TmdbId.Value > 0)
            .OrderByDescending(s => s.Weight)
            .Take(6)
            .ToList();

        // 4. TMDB Recommendations fetching with 6h cache and co-occurrence boost
        using var tmdbClient = GenreCache.CreateTmdbClient(httpClientFactory, null, out var queryKeyParam);
        var tmdbRecHits = new Dictionary<string, (TmdbItemResult Item, double CumulativeWeight, int MatchCount)>(StringComparer.OrdinalIgnoreCase);

        foreach (var seed in topSeeds)
        {
            var kind = seed.IsMovie ? "movie" : "tv";
            var recs = await FetchTmdbRecommendationsAsync(tmdbClient, queryKeyParam, kind, seed.TmdbId!.Value, ct).ConfigureAwait(false);
            foreach (var r in recs)
            {
                r.MediaType ??= kind;
                var itemKind = r.MediaType == "tv" ? "tv" : "movie";
                var key = $"{itemKind}:{r.Id}";

                if (excludedTmdbKeys.Contains(key))
                {
                    continue;
                }

                if (tmdbRecHits.TryGetValue(key, out var existing))
                {
                    tmdbRecHits[key] = (existing.Item, existing.CumulativeWeight + seed.Weight, existing.MatchCount + 1);
                }
                else
                {
                    tmdbRecHits[key] = (r, seed.Weight, 1);
                }
            }
        }

        // 5. Build taste profile from seeds for scoring local library items
        var tasteGenres = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var tasteDirectors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tasteActors = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tasteStudios = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seedYearSum = 0;
        var seedYearCount = 0;

        foreach (var seed in seedList.Take(12))
        {
            if (seed.Item.Genres != null)
            {
                foreach (var g in seed.Item.Genres)
                {
                    tasteGenres[g] = tasteGenres.GetValueOrDefault(g) + seed.Weight;
                }
            }

            if (seed.Item.ProductionYear.HasValue && seed.Item.ProductionYear.Value > 1900)
            {
                seedYearSum += seed.Item.ProductionYear.Value;
                seedYearCount++;
            }

            if (seed.Item.Studios != null)
            {
                foreach (var s in seed.Item.Studios)
                {
                    tasteStudios.Add(s);
                }
            }

            try
            {
                var people = libraryManager.GetPeople(seed.Item);
                foreach (var p in people)
                {
                    if (string.IsNullOrWhiteSpace(p.Name))
                    {
                        continue;
                    }

                    if (p.Type == PersonKind.Director)
                    {
                        tasteDirectors.Add(p.Name);
                    }
                    else if (p.Type == PersonKind.Actor)
                    {
                        tasteActors.Add(p.Name);
                    }
                }
            }
            catch
            {
                // Best effort people resolution
            }
        }

        var avgSeedYear = seedYearCount > 0 ? (double)seedYearSum / seedYearCount : 2018.0;

        // Friends activity lookup
        var friendWatchedOrLikedItemIds = new HashSet<Guid>();
        if (friendsService != null)
        {
            try
            {
                var friendsData = friendsService.Snapshot();
                var friendIds = FriendsGraph.FriendIds(friendsData, user.Id).ToList();
                foreach (var fid in friendIds)
                {
                    var fUser = userManager.GetUserById(fid);
                    if (fUser == null)
                    {
                        continue;
                    }

                    var fPlayed = libraryManager.GetItemList(new InternalItemsQuery(fUser)
                    {
                        IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                        IsPlayed = true,
                        Recursive = true,
                        Limit = 80,
                    });

                    if (fPlayed != null)
                    {
                        foreach (var fItem in fPlayed)
                        {
                            friendWatchedOrLikedItemIds.Add(fItem.Id);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Recommendations: friend activity evaluation failed");
            }
        }

        // 6. Score local unplayed Movie/Series
        var localIndex = await GetTmdbIndexAsync(ct).ConfigureAwait(false);
        var scoredLocalCandidates = new List<(BaseItem Item, double Score)>();

        var candidateLocalItems = allLibraryItems.Where(item =>
        {
            if (excludedItemIds.Contains(item.Id))
            {
                return false;
            }

            if (hiddenSeriesIds.Contains(item.Id.ToString("N")) || hiddenSeriesIds.Contains(item.Id.ToString("D")))
            {
                return false;
            }

            if (!item.IsVisible(user))
            {
                return false;
            }

            var rating = item.CommunityRating ?? 0f;
            return rating >= 6.0f;
        }).ToList();

        foreach (var localItem in candidateLocalItems)
        {
            double localScore = 0.0;

            // Genre TF-IDF affinity
            if (localItem.Genres != null)
            {
                foreach (var g in localItem.Genres)
                {
                    if (tasteGenres.TryGetValue(g, out var gWeight))
                    {
                        localScore += Math.Min(2.5, gWeight * 0.4);
                    }
                }
            }

            // Studio affinity
            if (localItem.Studios != null && localItem.Studios.Any(tasteStudios.Contains))
            {
                localScore += 0.7;
            }

            // Director / Cast affinity
            try
            {
                var people = libraryManager.GetPeople(localItem);
                var matchedActors = 0;
                foreach (var p in people)
                {
                    if (string.IsNullOrWhiteSpace(p.Name))
                    {
                        continue;
                    }

                    if (p.Type == PersonKind.Director && tasteDirectors.Contains(p.Name))
                    {
                        localScore += 1.8;
                    }
                    else if (p.Type == PersonKind.Actor && tasteActors.Contains(p.Name))
                    {
                        matchedActors++;
                    }
                }

                if (matchedActors > 0)
                {
                    localScore += Math.Min(2.0, matchedActors * 0.8);
                }
            }
            catch
            {
                // Best effort
            }

            // Friends activity bonus
            if (friendWatchedOrLikedItemIds.Contains(localItem.Id))
            {
                localScore += 1.2;
            }

            // Rating & Era bonus
            var rating = localItem.CommunityRating ?? 6.0f;
            localScore += (rating / 10.0) * 0.6;

            if (localItem.ProductionYear.HasValue)
            {
                var yearDiff = Math.Abs(localItem.ProductionYear.Value - avgSeedYear);
                localScore += 0.4 * (1.0 - Math.Min(1.0, yearDiff / 20.0));
            }

            if (localScore >= 1.0)
            {
                scoredLocalCandidates.Add((localItem, localScore));
            }
        }

        // 7. Resolve TMDB candidates locally first, fallback to virtual
        var mergedRecommendations = new List<(BaseItemDto Dto, double Score, string FranchiseKey)>();
        var selectedItemIds = new HashSet<Guid>();

        foreach (var (key, (tmdbItem, cumWeight, matchCount)) in tmdbRecHits)
        {
            var isMovie = tmdbItem.MediaType != "tv";
            var vote = tmdbItem.VoteAverage.GetValueOrDefault(6.0) / 10.0;
            var coOccurrenceBoost = 2.0 * (matchCount - 1);
            var recScore = (cumWeight * vote) + coOccurrenceBoost;

            var title = tmdbItem.Title ?? tmdbItem.Name;
            var dateStr = isMovie ? tmdbItem.ReleaseDate : tmdbItem.FirstAirDate;
            var franchiseKey = ExtractFranchiseKey(title);

            // Local resolution check
            if (localIndex.TryGetValue(key, out var localId))
            {
                var localItem = libraryManager.GetItemById(localId);
                if (localItem != null && localItem.IsVisible(user) && !excludedItemIds.Contains(localItem.Id))
                {
                    if (selectedItemIds.Add(localItem.Id))
                    {
                        var dtos = dtoService.GetBaseItemDtosCompat([localItem], CreateDtoOptions(), user, logger);
                        if (dtos.Count > 0)
                        {
                            mergedRecommendations.Add((dtos[0], recScore + 1.0, franchiseKey));
                        }
                    }
                    continue;
                }
            }

            // Virtual resolution fallback
            if (enableVirtual)
            {
                var genres = GenreCache.ResolveGenreNamesByIds(tmdbItem.GenreIds, isMovie);
                var vDto = GenreCache.BuildVirtualItemDto(
                    tmdbItem.Id,
                    title,
                    dateStr,
                    isMovie,
                    tmdbItem.VoteAverage,
                    tmdbItem.Overview,
                    tmdbItem.PosterPath,
                    tmdbItem.BackdropPath,
                    genres,
                    skipUnreleased: true);

                if (vDto != null && !excludedItemIds.Contains(vDto.Id) && selectedItemIds.Add(vDto.Id))
                {
                    mergedRecommendations.Add((vDto, recScore, franchiseKey));
                }
            }
        }

        // Add scored local unplayed items
        var sortedLocal = scoredLocalCandidates
            .OrderByDescending(c => c.Score)
            .Take(limit * 2)
            .ToList();

        var localItemsToConvert = sortedLocal
            .Where(c => !selectedItemIds.Contains(c.Item.Id))
            .Select(c => c.Item)
            .ToList();

        if (localItemsToConvert.Count > 0)
        {
            var convertedDtos = dtoService.GetBaseItemDtosCompat(localItemsToConvert, CreateDtoOptions(), user, logger);
            var dtoMap = convertedDtos.ToDictionary(d => d.Id);
            foreach (var (localItem, score) in sortedLocal)
            {
                if (dtoMap.TryGetValue(localItem.Id, out var dto) && selectedItemIds.Add(dto.Id))
                {
                    var franchiseKey = ExtractFranchiseKey(dto.Name);
                    mergedRecommendations.Add((dto, score, franchiseKey));
                }
            }
        }

        // 8. Enforce franchise/series diversity and take top limit
        mergedRecommendations.Sort((a, b) => b.Score.CompareTo(a.Score));

        var finalPicks = new List<BaseItemDto>();
        var franchiseCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var deferred = new List<BaseItemDto>();

        foreach (var (dto, _, franchiseKey) in mergedRecommendations)
        {
            var count = franchiseCounts.GetValueOrDefault(franchiseKey, 0);
            if (count < 2)
            {
                franchiseCounts[franchiseKey] = count + 1;
                finalPicks.Add(dto);
                if (finalPicks.Count >= limit)
                {
                    break;
                }
            }
            else
            {
                deferred.Add(dto);
            }
        }

        // Backfill with deferred if diverse list did not reach target limit
        if (finalPicks.Count < limit && deferred.Count > 0)
        {
            foreach (var d in deferred)
            {
                finalPicks.Add(d);
                if (finalPicks.Count >= limit)
                {
                    break;
                }
            }
        }

        return finalPicks;
    }

    private static DtoOptions CreateDtoOptions() => new()
    {
        Fields =
        [
            ItemFields.PrimaryImageAspectRatio,
            ItemFields.Genres,
            ItemFields.Overview,
            ItemFields.Studios,
            ItemFields.People,
        ],
        EnableUserData = true,
        EnableImages = true,
    };

    private static string ExtractFranchiseKey(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return string.Empty;
        }

        var colonIdx = title.IndexOfAny([':', '-']);
        if (colonIdx > 2)
        {
            var prefixNorm = SearchNormalizer.Normalize(title.Substring(0, colonIdx));
            if (prefixNorm.Length >= 3)
            {
                return prefixNorm;
            }
        }

        var norm = SearchNormalizer.Normalize(title);
        var tokens = norm.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var startIndex = 0;
        if (tokens.Length > 1 && (tokens[0] is "the" or "a" or "an"))
        {
            startIndex = 1;
        }

        if (tokens.Length - startIndex > 1)
        {
            var last = tokens[^1];
            if (int.TryParse(last, out _) || last is "ii" or "iii" or "iv" or "v" or "vi" or "vii" or "viii" or "ix" or "x")
            {
                return string.Join(' ', tokens.Skip(startIndex).Take(tokens.Length - startIndex - 1));
            }
        }

        return string.Join(' ', tokens.Skip(startIndex).Take(Math.Min(2, tokens.Length - startIndex)));
    }

    private async Task<List<TmdbItemResult>> FetchTmdbRecommendationsAsync(
        HttpClient client,
        string queryKeyParam,
        string kind,
        int id,
        CancellationToken ct)
    {
        var cacheKey = $"{kind}:{id}";
        if (TmdbRecCache.TryGetValue(cacheKey, out var hit) && DateTime.UtcNow - hit.At < TmdbCacheTtl)
        {
            return hit.Results;
        }

        var results = new List<TmdbItemResult>();
        try
        {
            var separator = queryKeyParam.Length > 0 ? (queryKeyParam.StartsWith("&") ? queryKeyParam : "&" + queryKeyParam) : string.Empty;
            var path = $"{kind}/{id}/recommendations?include_adult=false{separator}";
            using var response = await client.GetAsync(path, ct).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                var payload = await JsonSerializer.DeserializeAsync<TmdbRecommendationsResponse>(stream, JsonOptions, ct).ConfigureAwait(false);
                if (payload?.Results != null)
                {
                    results = payload.Results;
                }
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogDebug(ex, "Recommendations: TMDB recommendation fetch failed for {Kind}/{Id}", kind, id);
        }

        if (TmdbRecCache.Count > 500)
        {
            TmdbRecCache.Clear();
        }

        TmdbRecCache[cacheKey] = (DateTime.UtcNow, results);
        return results;
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
                var tmdb = item.GetProviderId(MetadataProvider.Tmdb);
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

    private sealed class TmdbRecommendationsResponse
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
}
