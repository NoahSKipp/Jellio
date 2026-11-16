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

namespace Jellio.Services;

public record FuzzySearchResult(
    IReadOnlyList<BaseItemDto> Items,
    string? CorrectedQuery,
    double TopScore);

public class FuzzySearchService
{
    private static readonly TimeSpan IndexTtl = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private static readonly string[] CommonTitleVocabulary =
    [
        "breaking", "bad", "interstellar", "inception", "stranger", "things", "game", "thrones",
        "house", "dragon", "lord", "rings", "fellowship", "two", "towers", "return", "king",
        "harry", "potter", "star", "wars", "empire", "strikes", "back", "jedi", "phantom", "menace",
        "attack", "clones", "revenge", "sith", "force", "awakens", "last", "skywalker", "rogue",
        "andor", "mandalorian", "ahsoka", "acolyte", "obi", "wan", "kenobi", "boba", "fett",
        "avengers", "endgame", "infinity", "war", "ultron", "spider", "man", "spiderman",
        "homecoming", "far", "from", "home", "no", "way", "into", "across", "spiderverse",
        "batman", "begins", "dark", "knight", "rises", "joker", "penguin", "superman", "wonder",
        "woman", "aquaman", "flash", "justice", "league", "watchmen", "peacemaker", "guardians",
        "galaxy", "iron", "captain", "america", "winter", "soldier", "civil", "thor", "ragnarok",
        "black", "panther", "widow", "doctor", "strange", "multiverse", "madness", "deadpool",
        "wolverine", "logan", "xmen", "wandavision", "loki", "hawkeye", "moon", "daredevil",
        "punisher", "jessica", "jones", "defenders", "oppenheimer", "dune", "messiah", "part",
        "blade", "runner", "arrival", "sicario", "prisoners", "incendies", "memento", "prestige",
        "tenet", "dunkirk", "insomnia", "shawshank", "redemption", "green", "mile", "forrest",
        "gump", "saving", "private", "ryan", "band", "brothers", "pacific", "masters", "air",
        "schindlers", "list", "pianist", "truman", "show", "eternal", "sunshine", "spotless",
        "mind", "ex", "machina", "annihilation", "everything", "everywhere", "all", "once",
        "parasite", "whiplash", "gladiator", "matrix", "reloaded", "revolutions", "terminator",
        "judgment", "day", "alien", "aliens", "romulus", "predator", "prey", "godfather",
        "goodfellas", "scarface", "casino", "departed", "wolf", "wall", "street", "shutter",
        "island", "irishman", "killers", "flower", "taxi", "driver", "raging", "bull", "pulp",
        "fiction", "django", "unchained", "inglourious", "basterds", "kill", "bill", "reservoir",
        "dogs", "hateful", "eight", "once", "upon", "time", "hollywood", "jackie", "brown",
        "social", "network", "gone", "girl", "zodiac", "seven", "se7en", "fight", "club",
        "curious", "case", "benjamin", "button", "panic", "room", "tattoo", "mindhunter",
        "shining", "doctor", "sleep", "exorcist", "conjuring", "hereditary", "midsommar",
        "witch", "nosferatu", "lighthouse", "northman", "beetlejuice", "scream", "halloween",
        "friday", "thirteenth", "nightmare", "elm", "saw", "insidious", "sinister", "babadook",
        "it", "follows", "quiet", "place", "get", "out", "us", "nope", "talk", "to", "me",
        "smile", "longlegs", "substance", "weapons", "sinners", "jurassic", "park", "world",
        "indiana", "jones", "raiders", "lost", "ark", "crusade", "pirates", "caribbean",
        "mission", "impossible", "fallout", "reckoning", "bourne", "identity", "supremacy",
        "ultimatum", "john", "wick", "fast", "furious", "top", "gun", "maverick", "mad", "max",
        "fury", "road", "furiosa", "avatar", "titanic", "abyss", "true", "lies", "alita",
        "district", "edge", "tomorrow", "oblivion", "minority", "report", "ready", "player",
        "jaws", "hook", "catch", "if", "you", "can", "terminal", "munich", "lincoln", "bridge",
        "spies", "fabelmans", "knives", "glass", "onion", "looper", "sixth", "sense",
        "unbreakable", "split", "signs", "village", "grand", "budapest", "hotel", "moonrise",
        "kingdom", "royal", "tenenbaums", "fantastic", "fox", "isle", "french", "dispatch",
        "asteroid", "city", "poor", "things", "favourite", "lobster", "sacred", "deer",
        "shogun", "fargo", "severance", "succession", "sopranos", "wire", "office", "friends",
        "seinfeld", "parks", "recreation", "community", "brooklyn", "nine", "arrested",
        "development", "good", "ted", "lasso", "shrinking", "bear", "only", "murders",
        "building", "white", "lotus", "euphoria", "detective", "leftovers", "station", "eleven",
        "silo", "foundation", "mankind", "slow", "horses", "morning", "bad", "sisters",
        "pachinko", "matter", "presumed", "innocent", "yellowstone", "mayor", "kingstown",
        "tulsa", "lioness", "landman", "reacher", "jack", "boys", "invincible", "vox",
        "fleabag", "expanse", "wheel", "witcher", "sandman", "wednesday", "bridgerton",
        "crown", "ozark", "narcos", "mexico", "queens", "gambit", "squid", "alice",
        "borderland", "sweet", "glory", "crash", "landing", "goblin", "vincenzo", "attorney",
        "woo", "moving", "alchemy", "souls", "hospital", "playlist", "reply", "signal",
        "mouse", "beyond", "evil", "mister", "sherlock", "luther", "broadchurch", "line",
        "duty", "bodyguard", "happy", "valley", "peaky", "blinders", "downton", "abbey",
        "mirror", "utopia", "skins", "misfits", "inbetweeners", "crowd", "taskmaster",
        "clarkson", "farm", "planet", "earth", "cosmos", "chernobyl", "deadwood", "rome",
        "boardwalk", "six", "feet", "under", "veep", "silicon", "barry", "righteous",
        "gemstones", "curb", "enthusiasm", "entourage", "industry", "gilded", "age", "tokyo",
        "vice", "prison", "break", "heroes", "fringe", "person", "interest", "westworld",
        "robot", "halt", "fire", "americans", "homeland", "men", "better", "call", "saul",
        "walking", "dead", "sons", "anarchy", "shield", "justified", "atlanta", "snowfall",
        "shadows", "files", "twin", "peaks", "buffy", "vampire", "slayer", "firefly",
        "battlestar", "galactica", "stargate", "trek", "next", "generation", "deep", "space",
        "voyager", "enterprise", "discovery", "picard", "worlds", "lower", "decks", "supernatural",
        "smallville", "arrow", "dexter", "yellowjackets", "billions", "shameless", "monk",
        "psych", "mentalist", "castle", "bones", "ncis", "criminal", "minds", "greys", "anatomy",
        "resident", "chicago", "rookie", "suits", "collar", "burn", "notice", "leverage",
        "chuck", "designated", "survivor", "night", "agent", "diplomat", "gentlemen", "ripley",
        "baby", "reindeer", "body", "problem", "arcane", "cyberpunk", "edgerunners",
        "castlevania", "bojack", "horseman", "rick", "morty", "futurama", "simpsons", "family",
        "guy", "archer", "south", "korra", "gravity", "falls", "adventure", "regular", "steven",
        "universe", "garden", "owl", "amphibia", "teen", "titans", "young", "chainsaw",
        "jujutsu", "kaisen", "demon", "titan", "hunter", "bleach", "naruto", "shippuden",
        "one", "piece", "dragon", "ball", "super", "death", "note", "steins", "gate",
        "cowboy", "bebop", "evangelion", "akira", "spirited", "away", "mononoke", "totoro",
        "howls", "castle", "your", "name", "weathering", "suzume", "frieren", "dandadan",
        "solo", "leveling", "apothecary", "diaries", "vinland", "saga", "monster", "pluto",
        "fullmetal", "alchemist", "brotherhood", "academia", "haikyuu", "blue", "lock",
        "spy", "code", "geass", "mob", "psycho", "punch", "gintama", "berserk", "claymore",
        "parasyte", "erased", "promised", "neverland", "rezero", "konosuba", "overlord",
        "mushoku", "tensei", "slime", "tokyo", "ghoul", "revengers", "black", "clover",
        "fairy", "tail", "inuyasha", "yu", "hakusho", "trigun", "hellsing", "samurai",
        "champloo", "flcl", "lain", "gurren", "lagann", "kill", "la", "violet", "evergarden",
        "clannad", "anohana", "lie", "april", "silent", "voice", "horimiya", "kaguya", "sama",
        "ocarina", "bocchi", "rock", "oshi", "ko", "chainsawman", "shrek", "toy", "story",
        "finding", "nemo", "incredibles", "ratatouille", "walle", "coco", "inside", "zootopia",
        "moana", "frozen", "encanto", "lion", "aladdin", "mulan", "hercules", "tangled",
        "cars", "monsters", "despicable", "minions", "kung", "fu", "panda", "train",
        "madagascar", "megamind",
    ];

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IDtoService _dtoService;
    private readonly ILogger<FuzzySearchService> _logger;
    private readonly IHttpClientFactory? _httpClientFactory;
    private readonly object _indexSync = new();
    private DateTime _indexBuiltAt = DateTime.MinValue;
    private List<IndexedEntry> _entries = [];
    private HashSet<string> _vocabulary = new(CommonTitleVocabulary, StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, ExternalCorrectionResult Result)> _externalCache = new(StringComparer.OrdinalIgnoreCase);

    public FuzzySearchService(
        ILibraryManager libraryManager,
        IUserManager userManager,
        IDtoService dtoService,
        ILogger<FuzzySearchService> logger,
        IHttpClientFactory? httpClientFactory = null)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _dtoService = dtoService;
        _logger = logger;
        _httpClientFactory = httpClientFactory;

        try
        {
            _libraryManager.ItemAdded += OnLibraryChanged;
            _libraryManager.ItemRemoved += OnLibraryChanged;
        }
        catch
        {
            // Ignored when ILibraryManager is mocked in unit tests
        }
    }

    public sealed record IndexedEntry(
        Guid ItemId,
        string Name,
        string? OriginalTitle,
        int? ProductionYear,
        BaseItemKind Kind,
        string NormalizedTitle,
        string CollapsedTitle,
        string Initialism,
        string ShortInitialism,
        string[] Tokens,
        string[] PhoneticTokens,
        string? NormalizedOriginalTitle,
        string[] OriginalTokens,
        float CommunityRating);

    public sealed record ExternalCorrectionResult(
        string? CorrectedQuery,
        IReadOnlyList<BaseItemDto> VirtualOrMatchedItems,
        double Confidence);

    private void OnLibraryChanged(object? sender, ItemChangeEventArgs e)
    {
        if (e.Item is Movie or Series)
        {
            InvalidateIndex();
        }
    }

    public void InvalidateIndex()
    {
        lock (_indexSync)
        {
            _indexBuiltAt = DateTime.MinValue;
        }
    }

    public IReadOnlyList<IndexedEntry> GetIndex()
    {
        if (DateTime.UtcNow - _indexBuiltAt < IndexTtl && _entries.Count > 0)
        {
            return _entries;
        }

        lock (_indexSync)
        {
            if (DateTime.UtcNow - _indexBuiltAt < IndexTtl && _entries.Count > 0)
            {
                return _entries;
            }

            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            }) ?? [];

            var list = new List<IndexedEntry>(items.Count);
            var vocab = new HashSet<string>(CommonTitleVocabulary, StringComparer.Ordinal);

            foreach (var item in items)
            {
                if (string.IsNullOrWhiteSpace(item.Name))
                {
                    continue;
                }

                var norm = SearchNormalizer.Normalize(item.Name);
                if (string.IsNullOrEmpty(norm))
                {
                    continue;
                }

                var collapsed = SearchNormalizer.CollapseCompound(norm);
                var (fullInit, shortInit) = SearchNormalizer.ComputeInitialisms(norm);
                var tokens = norm.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var phoneticTokens = tokens.Select(SearchNormalizer.SimplePhoneticKey).Where(k => k.Length > 0).ToArray();

                foreach (var t in tokens)
                {
                    if (t.Length >= 3)
                    {
                        vocab.Add(t);
                    }
                }

                string? normOrig = null;
                var origTokens = Array.Empty<string>();
                if (!string.IsNullOrWhiteSpace(item.OriginalTitle) &&
                    !string.Equals(item.OriginalTitle, item.Name, StringComparison.OrdinalIgnoreCase))
                {
                    normOrig = SearchNormalizer.Normalize(item.OriginalTitle);
                    if (!string.IsNullOrEmpty(normOrig))
                    {
                        origTokens = normOrig.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                        foreach (var t in origTokens)
                        {
                            if (t.Length >= 3)
                            {
                                vocab.Add(t);
                            }
                        }
                    }
                }

                var kind = item is Movie ? BaseItemKind.Movie : BaseItemKind.Series;
                list.Add(new IndexedEntry(
                    item.Id,
                    item.Name,
                    item.OriginalTitle,
                    item.ProductionYear,
                    kind,
                    norm,
                    collapsed,
                    fullInit,
                    shortInit,
                    tokens,
                    phoneticTokens,
                    normOrig,
                    origTokens,
                    item.CommunityRating ?? 0f));
            }

            _entries = list;
            _vocabulary = vocab;
            _indexBuiltAt = DateTime.UtcNow;
            return _entries;
        }
    }

    public FuzzySearchResult Search(
        string query,
        Guid? userId = null,
        int limit = 24,
        string[]? includeItemTypes = null)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return new FuzzySearchResult([], null, 0.0);
        }

        var variants = SearchNormalizer.ExpandQueryVariants(query);
        if (variants.Count == 0)
        {
            return new FuzzySearchResult([], null, 0.0);
        }

        var rawNorm = variants[0];
        var allowedKinds = ParseAllowedKinds(includeItemTypes);
        var entries = GetIndex();

        // Also include a vocabulary-repaired variant if tokens have typos
        var repairedVariant = RepairQueryTokens(rawNorm);
        var allVariants = variants.ToList();
        if (!string.IsNullOrEmpty(repairedVariant) && !allVariants.Contains(repairedVariant, StringComparer.Ordinal))
        {
            allVariants.Add(repairedVariant);
        }

        var scored = new List<(IndexedEntry Entry, double Score)>();

        foreach (var entry in entries)
        {
            if (allowedKinds.Count > 0 && !allowedKinds.Contains(entry.Kind))
            {
                continue;
            }

            var bestEntryScore = 0.0;
            for (var i = 0; i < allVariants.Count; i++)
            {
                var isAliasOrRepair = i > 0;
                var vScore = ScoreEntryAgainstVariant(entry, allVariants[i], isAliasOrRepair);
                if (vScore > bestEntryScore)
                {
                    bestEntryScore = vScore;
                }
            }

            if (bestEntryScore >= 0.65)
            {
                scored.Add((entry, bestEntryScore));
            }
        }

        scored.Sort((a, b) =>
        {
            var cmp = b.Score.CompareTo(a.Score);
            if (Math.Abs(a.Score - b.Score) > 0.005)
            {
                return cmp;
            }

            return b.Entry.CommunityRating.CompareTo(a.Entry.CommunityRating);
        });

        var user = userId.HasValue && userId.Value != Guid.Empty
            ? _userManager.GetUserById(userId.Value)
            : null;

        var matchedItems = new List<BaseItem>();
        IndexedEntry? topEntry = null;
        var topScore = 0.0;

        foreach (var (entry, score) in scored)
        {
            var item = _libraryManager.GetItemById(entry.ItemId);
            if (item == null)
            {
                continue;
            }

            if (user != null && !item.IsVisible(user))
            {
                continue;
            }

            if (topEntry == null)
            {
                topEntry = entry;
                topScore = score;
            }

            matchedItems.Add(item);
            if (matchedItems.Count >= limit * 2)
            {
                break;
            }
        }

        var distinctItems = GenreCache.DistinctTitles(matchedItems).Take(limit).ToList();
        var dtoOptions = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres, ItemFields.Overview],
            EnableUserData = true,
            EnableImages = true,
        };

        var dtos = distinctItems.Count > 0
            ? _dtoService.GetBaseItemDtosCompat(distinctItems, dtoOptions, user, _logger)
            : [];

        string? correctedQuery = null;
        if (topEntry != null && topScore >= 0.70)
        {
            if (!string.Equals(topEntry.NormalizedTitle, rawNorm, StringComparison.Ordinal))
            {
                correctedQuery = topEntry.Name;
            }
        }
        else if (!string.IsNullOrEmpty(repairedVariant) && !string.Equals(repairedVariant, rawNorm, StringComparison.Ordinal))
        {
            correctedQuery = CultureInfo.CurrentCulture.TextInfo.ToTitleCase(repairedVariant);
        }

        return new FuzzySearchResult(dtos, correctedQuery, topScore);
    }

    public async Task<FuzzySearchResult> SearchWithExternalFallbackAsync(
        string query,
        Guid? userId = null,
        int limit = 24,
        string[]? includeItemTypes = null,
        CancellationToken ct = default)
    {
        var localResult = Search(query, userId, limit, includeItemTypes);
        if (localResult.TopScore >= 0.78 || string.IsNullOrWhiteSpace(query) || query.Trim().Length < 3)
        {
            return localResult;
        }

        var external = await ResolveExternalSpellCorrectionAsync(query, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(external.CorrectedQuery) && external.VirtualOrMatchedItems.Count == 0)
        {
            return localResult;
        }

        // If external resolved a clean CorrectedQuery, check if local index has items for that corrected query
        if (!string.IsNullOrWhiteSpace(external.CorrectedQuery))
        {
            var retryLocal = Search(external.CorrectedQuery, userId, limit, includeItemTypes);
            if (retryLocal.Items.Count > 0 && retryLocal.TopScore >= localResult.TopScore)
            {
                var combined = retryLocal.Items.ToList();
                var seenIds = new HashSet<Guid>(combined.Select(i => i.Id));
                foreach (var v in external.VirtualOrMatchedItems)
                {
                    if (combined.Count >= limit)
                    {
                        break;
                    }

                    if (seenIds.Add(v.Id))
                    {
                        combined.Add(v);
                    }
                }

                return new FuzzySearchResult(
                    combined,
                    external.CorrectedQuery,
                    Math.Max(retryLocal.TopScore, external.Confidence));
            }
        }

        var mergedItems = localResult.Items.ToList();
        var existingIds = new HashSet<Guid>(mergedItems.Select(i => i.Id));
        foreach (var extItem in external.VirtualOrMatchedItems)
        {
            if (mergedItems.Count >= limit)
            {
                break;
            }

            if (existingIds.Add(extItem.Id))
            {
                mergedItems.Add(extItem);
            }
        }

        return new FuzzySearchResult(
            mergedItems,
            external.CorrectedQuery ?? localResult.CorrectedQuery,
            Math.Max(localResult.TopScore, external.Confidence));
    }

    public async Task<ExternalCorrectionResult> ResolveExternalSpellCorrectionAsync(
        string query,
        CancellationToken ct = default)
    {
        var trimmed = (query ?? string.Empty).Trim();
        var norm = SearchNormalizer.Normalize(trimmed);
        if (norm.Length < 3)
        {
            return new ExternalCorrectionResult(null, [], 0.0);
        }

        if (_externalCache.TryGetValue(norm, out var cached) && DateTime.UtcNow - cached.At < TimeSpan.FromHours(6))
        {
            return cached.Result;
        }

        var variants = SearchNormalizer.ExpandQueryVariants(trimmed).ToList();
        var repaired = RepairQueryTokens(norm);
        if (!string.IsNullOrEmpty(repaired) && !variants.Contains(repaired, StringComparer.Ordinal))
        {
            // Prioritize the vocabulary-repaired query first when it differs from the raw typo
            variants.Insert(0, repaired);
        }

        if (_httpClientFactory == null)
        {
            var fallbackTitle = !string.IsNullOrEmpty(repaired) && !string.Equals(repaired, norm, StringComparison.Ordinal)
                ? CultureInfo.CurrentCulture.TextInfo.ToTitleCase(repaired)
                : null;
            return new ExternalCorrectionResult(fallbackTitle, [], fallbackTitle != null ? 0.80 : 0.0);
        }

        var candidateQueries = new List<string>(variants);

        // Also query MediaWiki OpenSearch with a fast 1500ms timeout for spell correction suggestions
        try
        {
            using var wikiCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            wikiCts.CancelAfter(TimeSpan.FromMilliseconds(1500));
            using var wikiClient = _httpClientFactory.CreateClient();
            wikiClient.Timeout = TimeSpan.FromMilliseconds(1500);
            wikiClient.DefaultRequestHeaders.UserAgent.ParseAdd("Jellio/1.0 (https://github.com/NoahSKipp/Jellio)");

            var wikiUrl = $"https://en.wikipedia.org/w/api.php?action=opensearch&search={Uri.EscapeDataString(trimmed)}&limit=3&format=json";
            using var wikiResp = await wikiClient.GetAsync(wikiUrl, wikiCts.Token).ConfigureAwait(false);
            if (wikiResp.IsSuccessStatusCode)
            {
                using var stream = await wikiResp.Content.ReadAsStreamAsync(wikiCts.Token).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: wikiCts.Token).ConfigureAwait(false);
                if (doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() >= 2)
                {
                    var suggestions = doc.RootElement[1];
                    if (suggestions.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var elem in suggestions.EnumerateArray())
                        {
                            var rawSuggestion = elem.GetString();
                            if (!string.IsNullOrWhiteSpace(rawSuggestion))
                            {
                                // Strip parenthetical suffixes like "(film)" or "(TV series)"
                                var parenIdx = rawSuggestion.IndexOf('(');
                                var cleanSuggestion = (parenIdx > 0 ? rawSuggestion[..parenIdx] : rawSuggestion).Trim();
                                var normSugg = SearchNormalizer.Normalize(cleanSuggestion);
                                if (!string.IsNullOrEmpty(normSugg) && !candidateQueries.Contains(normSugg, StringComparer.OrdinalIgnoreCase))
                                {
                                    candidateQueries.Add(cleanSuggestion);
                                }
                            }
                        }
                    }
                }
            }
        }
        catch
        {
            // MediaWiki OpenSearch is optional; proceed with TMDB verification
        }

        try
        {
            using var tmdbClient = GenreCache.CreateTmdbClient(_httpClientFactory, null, out var queryKeyParam);
            foreach (var candidate in candidateQueries.Take(4))
            {
                var path = $"search/multi?include_adult=false&query={Uri.EscapeDataString(candidate)}{queryKeyParam}";
                using var response = await tmdbClient.GetAsync(path, ct).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    continue;
                }

                using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                var payload = await JsonSerializer.DeserializeAsync<TmdbMultiSearchResponse>(stream, JsonOptions, ct).ConfigureAwait(false);
                var hits = payload?.Results?
                    .Where(r => r.MediaType is "movie" or "tv" && !string.IsNullOrWhiteSpace(r.Title ?? r.Name))
                    .ToList();

                if (hits == null || hits.Count == 0)
                {
                    continue;
                }

                var topHit = hits[0];
                var topTitle = (topHit.Title ?? topHit.Name)!.Trim();
                var topNorm = SearchNormalizer.Normalize(topTitle);

                // Verify similarity between the user's original query (or its alias/repaired variant) and the TMDB title
                var dice = Math.Max(
                    SearchNormalizer.TrigramDiceSimilarity(norm, topNorm),
                    SearchNormalizer.TrigramDiceSimilarity(repaired ?? norm, topNorm));
                var dist = SearchNormalizer.RestrictedDamerauLevenshtein(norm.AsSpan(), topNorm.AsSpan(), 4);
                var confidence = dist <= 2 ? 0.88 : Math.Max(0.75, dice);

                var virtualDtos = new List<BaseItemDto>();
                foreach (var hit in hits.Take(12))
                {
                    var isMovie = hit.MediaType == "movie";
                    var genres = GenreCache.ResolveGenreNamesByIds(hit.GenreIds, isMovie);
                    var dto = GenreCache.BuildVirtualItemDto(
                        hit.Id,
                        hit.Title ?? hit.Name,
                         isMovie ? hit.ReleaseDate : hit.FirstAirDate,
                        isMovie,
                        hit.VoteAverage,
                        hit.Overview,
                        hit.PosterPath,
                        hit.BackdropPath,
                        genres,
                        skipUnreleased: true);
                    if (dto != null)
                    {
                        virtualDtos.Add(dto);
                    }
                }

                var corrected = !string.Equals(topNorm, norm, StringComparison.Ordinal)
                    ? topTitle
                    : null;

                var result = new ExternalCorrectionResult(corrected, virtualDtos, confidence);
                if (_externalCache.Count > 500)
                {
                    _externalCache.Clear();
                }

                _externalCache[norm] = (DateTime.UtcNow, result);
                return result;
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            _logger.LogDebug(ex, "FuzzySearchService: external spell correction lookup failed for {Query}", trimmed);
        }

        if (!string.IsNullOrEmpty(repaired) && !string.Equals(repaired, norm, StringComparison.Ordinal))
        {
            var titleCase = CultureInfo.CurrentCulture.TextInfo.ToTitleCase(repaired);
            return new ExternalCorrectionResult(titleCase, [], 0.80);
        }

        return new ExternalCorrectionResult(null, [], 0.0);
    }

    public string RepairQueryTokens(string normalizedQuery)
    {
        if (string.IsNullOrWhiteSpace(normalizedQuery))
        {
            return string.Empty;
        }

        _ = GetIndex();
        var tokens = normalizedQuery.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length == 0)
        {
            return string.Empty;
        }

        var repaired = new string[tokens.Length];
        var changed = false;

        for (var i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i];
            if (token.Length < 3 || _vocabulary.Contains(token))
            {
                repaired[i] = token;
                continue;
            }

            var maxEdits = token.Length >= 7 ? 2 : 1;
            var tokenPhonetic = SearchNormalizer.SimplePhoneticKey(token);
            string? bestWord = null;
            var bestDist = maxEdits + 1;
            var bestDice = 0.0;

            foreach (var candidate in _vocabulary)
            {
                if (Math.Abs(candidate.Length - token.Length) > maxEdits)
                {
                    continue;
                }

                // Require matching first character or matching phonetic key to avoid wild substitutions on short words
                var sameFirstChar = candidate[0] == token[0];
                var candidatePhonetic = sameFirstChar ? null : SearchNormalizer.SimplePhoneticKey(candidate);
                if (!sameFirstChar && !string.Equals(tokenPhonetic, candidatePhonetic, StringComparison.Ordinal))
                {
                    continue;
                }

                var dist = SearchNormalizer.RestrictedDamerauLevenshtein(token.AsSpan(), candidate.AsSpan(), maxEdits);
                if (dist <= maxEdits)
                {
                    var dice = SearchNormalizer.TrigramDiceSimilarity(token, candidate);
                    if (dist < bestDist || (dist == bestDist && dice > bestDice))
                    {
                        bestDist = dist;
                        bestDice = dice;
                        bestWord = candidate;
                    }
                }
            }

            if (bestWord != null)
            {
                repaired[i] = bestWord;
                changed = true;
            }
            else
            {
                repaired[i] = token;
            }
        }

        return changed ? string.Join(' ', repaired) : normalizedQuery;
    }

    private static double ScoreEntryAgainstVariant(IndexedEntry entry, string queryVariant, bool isAliasVariant)
    {
        if (string.IsNullOrEmpty(queryVariant))
        {
            return 0.0;
        }

        var qCollapsed = SearchNormalizer.CollapseCompound(queryVariant);

        // 1. Exact normalized or compound-collapsed match (1.0, or 0.95 via alias)
        if (string.Equals(entry.NormalizedTitle, queryVariant, StringComparison.Ordinal) ||
            (qCollapsed.Length >= 3 && string.Equals(entry.CollapsedTitle, qCollapsed, StringComparison.Ordinal)) ||
            (entry.NormalizedOriginalTitle != null && string.Equals(entry.NormalizedOriginalTitle, queryVariant, StringComparison.Ordinal)))
        {
            return isAliasVariant ? 0.95 : 1.0;
        }

        // 2. Exact initialism match (0.95)
        if (queryVariant.Length >= 2 &&
            (string.Equals(entry.Initialism, queryVariant, StringComparison.Ordinal) ||
             string.Equals(entry.ShortInitialism, queryVariant, StringComparison.Ordinal)))
        {
            return 0.95;
        }

        // 3. Prefix or substring match (0.88)
        if (queryVariant.Length >= 3)
        {
            if (entry.NormalizedTitle.StartsWith(queryVariant, StringComparison.Ordinal) ||
                entry.CollapsedTitle.StartsWith(qCollapsed, StringComparison.Ordinal))
            {
                return 0.89;
            }

            if (entry.NormalizedTitle.Contains(queryVariant, StringComparison.Ordinal) ||
                (qCollapsed.Length >= 4 && entry.CollapsedTitle.Contains(qCollapsed, StringComparison.Ordinal)) ||
                (entry.NormalizedOriginalTitle != null && entry.NormalizedOriginalTitle.Contains(queryVariant, StringComparison.Ordinal)))
            {
                return 0.88;
            }
        }

        var qTokens = queryVariant.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var bestScore = 0.0;

        // 4. Token-wise Restricted Damerau-Levenshtein match & 5. Phonetic token match
        var titleTokenScore = ScoreTokenMatch(qTokens, entry.Tokens, entry.PhoneticTokens);
        if (titleTokenScore > bestScore)
        {
            bestScore = titleTokenScore;
        }

        if (entry.OriginalTokens.Length > 0)
        {
            var origPhonetic = entry.OriginalTokens.Select(SearchNormalizer.SimplePhoneticKey).ToArray();
            var origTokenScore = ScoreTokenMatch(qTokens, entry.OriginalTokens, origPhonetic);
            if (origTokenScore > bestScore)
            {
                bestScore = origTokenScore;
            }
        }

        // Also check whole-title Damerau-Levenshtein for compound or single-token queries
        if (qCollapsed.Length >= 4 && Math.Abs(entry.CollapsedTitle.Length - qCollapsed.Length) <= 2)
        {
            var maxWholeEdits = qCollapsed.Length >= 7 ? 2 : 1;
            var wholeDist = SearchNormalizer.RestrictedDamerauLevenshtein(qCollapsed.AsSpan(), entry.CollapsedTitle.AsSpan(), maxWholeEdits);
            if (wholeDist <= maxWholeEdits)
            {
                var wholeScore = wholeDist == 1 ? 0.88 : 0.82;
                if (wholeScore > bestScore)
                {
                    bestScore = wholeScore;
                }
            }
        }

        // 6. Trigram Dice similarity >= 0.52 (0.65 - 0.85)
        var dice = SearchNormalizer.TrigramDiceSimilarity(queryVariant, entry.NormalizedTitle);
        if (dice >= 0.52)
        {
            var diceScore = 0.65 + Math.Min(0.20, (dice - 0.52) / 0.48 * 0.20);
            if (diceScore > bestScore)
            {
                bestScore = diceScore;
            }
        }

        return bestScore;
    }

    private static double ScoreTokenMatch(string[] qTokens, string[] targetTokens, string[] targetPhoneticTokens)
    {
        if (qTokens.Length == 0 || targetTokens.Length == 0)
        {
            return 0.0;
        }

        var matchedEditTokens = 0;
        var totalEditPenalty = 0.0;
        var matchedPhoneticTokens = 0;

        foreach (var qt in qTokens)
        {
            var maxEdits = qt.Length >= 7 ? 2 : (qt.Length >= 4 ? 1 : 0);
            var bestDist = int.MaxValue;

            foreach (var tt in targetTokens)
            {
                if (string.Equals(qt, tt, StringComparison.Ordinal))
                {
                    bestDist = 0;
                    break;
                }

                if (qt.Length >= 3 && tt.StartsWith(qt, StringComparison.Ordinal))
                {
                    bestDist = Math.Min(bestDist, 1);
                }

                if (maxEdits > 0 && Math.Abs(qt.Length - tt.Length) <= maxEdits)
                {
                    var dist = SearchNormalizer.RestrictedDamerauLevenshtein(qt.AsSpan(), tt.AsSpan(), maxEdits);
                    if (dist < bestDist)
                    {
                        bestDist = dist;
                    }
                }
            }

            if (bestDist <= maxEdits)
            {
                matchedEditTokens++;
                totalEditPenalty += bestDist * 0.04;
            }

            var qPhonetic = SearchNormalizer.SimplePhoneticKey(qt);
            if (qPhonetic.Length >= 2 && targetPhoneticTokens.Contains(qPhonetic, StringComparer.Ordinal))
            {
                matchedPhoneticTokens++;
            }
        }

        var best = 0.0;
        var editRatio = (double)matchedEditTokens / qTokens.Length;
        var coverageRatio = (double)matchedEditTokens / Math.Max(qTokens.Length, targetTokens.Length);

        if (matchedEditTokens == qTokens.Length)
        {
            // All query tokens matched within allowed edit distance: score in [0.75, 0.90]
            var raw = 0.90 - totalEditPenalty - ((1.0 - coverageRatio) * 0.06);
            best = Math.Clamp(raw, 0.75, 0.90);
        }
        else if (qTokens.Length >= 2 && editRatio >= 0.66)
        {
            best = Math.Clamp(0.75 * editRatio, 0.66, 0.80);
        }

        if (matchedPhoneticTokens == qTokens.Length)
        {
            best = Math.Max(best, 0.72);
        }

        return best;
    }

    private static HashSet<BaseItemKind> ParseAllowedKinds(string[]? includeItemTypes)
    {
        var set = new HashSet<BaseItemKind>();
        if (includeItemTypes == null)
        {
            return set;
        }

        foreach (var raw in includeItemTypes)
        {
            foreach (var part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (Enum.TryParse<BaseItemKind>(part, true, out var kind))
                {
                    set.Add(kind);
                }
            }
        }

        return set;
    }

    private sealed class TmdbMultiSearchResponse
    {
        [JsonPropertyName("results")]
        public List<TmdbMultiSearchHit>? Results { get; set; }
    }

    private sealed class TmdbMultiSearchHit
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
