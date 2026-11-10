import { getCurrentUserId } from '../auth.js';
import { COLLECTIONS_CACHE_TTL_MS, COLLECTIONS_SESSION_PREFIX, cached, clearCollectionsSessionCache, getJson, invalidateCache, rowJson } from './core.js';
import { collapseAudiobookTracks, itemTypesForKind } from './items.js';

export function getUserViews() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('views:' + userId, function () {
    return rowJson('/Users/' + userId + '/Views', 'views').then(function (result) {
      return (result && result.Items) || [];
    });
  });
}

function getAllCollections(userId) {
  const pageSize = 100;
  function fetchPage(startIndex) {
    const params = new URLSearchParams({
      IncludeItemTypes: 'BoxSet',
      Recursive: 'true',
      SortBy: 'SortName',
      Limit: String(pageSize),
      StartIndex: String(startIndex),
      Fields: 'ProviderIds,ChildCount',
    });
    return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'collections');
  }

  return fetchPage(0).then(function (first) {
    const items = (first && first.Items) || [];
    const total = (first && first.TotalRecordCount) || items.length;
    if (items.length < pageSize || items.length >= total) return items;

    const laterPages = [];
    for (let startIndex = pageSize; startIndex < total; startIndex += pageSize) {
      laterPages.push(fetchPage(startIndex));
    }
    return Promise.all(laterPages).then(function (pages) {
      const all = items.slice();
      pages.forEach(function (page) {
        all.push.apply(all, (page && page.Items) || []);
      });
      return all;
    });
  });
}

export function getCollections() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const sessionKey = COLLECTIONS_SESSION_PREFIX + userId;
  return cached(
    'collections:' + userId,
    function () {
      try {
        const raw = typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage.getItem(sessionKey) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.items) && Date.now() - parsed.ts < COLLECTIONS_CACHE_TTL_MS) {
            return Promise.resolve(parsed.items);
          }
        }
      } catch (err) {}
      return getAllCollections(userId).then(function (items) {
        try {
          if (typeof window !== 'undefined' && window.sessionStorage) {
            window.sessionStorage.setItem(sessionKey, JSON.stringify({ ts: Date.now(), items: items }));
          }
        } catch (err) {}
        return items;
      });
    },
    COLLECTIONS_CACHE_TTL_MS,
  );
}

export function invalidateNavCaches() {
  const userId = getCurrentUserId();
  if (!userId) return;
  invalidateCache('views:' + userId);
  invalidateCache('collections:' + userId);
  clearCollectionsSessionCache(userId);
}

export function isAnimeCollection(collection) {
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) return String(stremio).split('.')[0].toLowerCase() === 'anime';
  return /anime|anilist|kitsu/i.test(collection.Name || '');
}

function normalizedId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function getAnimeIds() {
  return cached('anime-ids', function () {
    return rowJson('/Jellio/anime/ids', 'collections', { timeout: 20000 }).then(function (result) {
      return new Set(((result && result.Ids) || []).map(normalizedId));
    });
  }).catch(function () {
    return new Set();
  });
}

function isAnimeItem(item, animeIds) {
  if (!item || !animeIds || !animeIds.size) return false;
  return animeIds.has(normalizedId(item.Id)) || (!!item.SeriesId && animeIds.has(normalizedId(item.SeriesId)));
}

export function withoutAnime(items, animeIds) {
  if (!animeIds || !animeIds.size) return items || [];
  return (items || []).filter(function (item) {
    return !isAnimeItem(item, animeIds);
  });
}

export function collectionKind(collection) {
  if (isAnimeCollection(collection)) return 'tvshows';
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) {
    const type = String(stremio).split('.')[0].toLowerCase();
    return type === 'movie' ? 'movies' : 'tvshows';
  }
  return 'movies';
}

export function getCollectionItems(collectionId, kind, limit, startIndex) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    ParentId: collectionId,
    IncludeItemTypes: itemTypesForKind(kind),
    Limit: String(limit || 24),
    Fields: 'ProductionYear,CommunityRating,Genres',
    SortBy: 'SortName',
  });
  if (startIndex) params.set('StartIndex', String(startIndex));
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'rows');
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getHeroCandidates(limit, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const itemTypes = opts.itemTypes || 'Movie,Series';
  const key = 'hero:' + userId + ':' + (opts.parentId || '') + ':' + itemTypes + ':' + (limit || 8);
  return cached(key, function () {
    // Asks for extra so there are still enough once anime and incomplete items are left out.
    const params = new URLSearchParams({
      SortBy: 'Random',
      Recursive: 'true',
      IncludeItemTypes: itemTypes,
      ImageTypes: 'Backdrop',
      EnableImageTypes: 'Backdrop,Logo,Primary',
      Limit: String((limit || 8) * 4),
      Fields: 'Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating,ImageTags,BackdropImageTags,ParentBackdropItemId,ParentBackdropImageTags',
    });
    if (opts.parentId) params.set('ParentId', opts.parentId);
    return Promise.all([rowJson('/Users/' + userId + '/Items?' + params.toString(), 'hero'), getAnimeIds()]).then(function (results) {
      const candidates = withoutAnime((results[0] && results[0].Items) || [], results[1]);
      const highQuality = candidates.filter(function (item) {
        const hasBackdrop = Boolean(
          (item.BackdropImageTags && item.BackdropImageTags.length > 0) ||
          (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0)
        );
        const hasTitle = Boolean(item.Name && item.Name.trim().length > 0);
        const hasOverview = Boolean(item.Overview && item.Overview.trim().length > 0);
        return hasBackdrop && hasTitle && hasOverview;
      });
      if (highQuality.length >= (limit || 8)) {
        return highQuality.slice(0, limit || 8);
      }
      const withBackdrop = candidates.filter(function (item) {
        const hasBackdrop = Boolean(
          (item.BackdropImageTags && item.BackdropImageTags.length > 0) ||
          (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0)
        );
        const hasTitle = Boolean(item.Name && item.Name.trim().length > 0);
        return hasBackdrop && hasTitle;
      });
      return (withBackdrop.length ? withBackdrop : candidates).slice(0, limit || 8);
    });
  });
}

const COMMON_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
];

function scanGenres(parentId, itemType) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Limit: '4000',
    Fields: 'Genres',
  });
  if (parentId) params.set('ParentId', parentId);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres');
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}

function getGenreCounts(parentId, itemType) {
  const params = new URLSearchParams({ types: itemType });
  if (parentId) params.set('parentId', parentId);
  const path = '/Jellio/genres?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres', { timeout: 30000 });
  }).then(function (result) {
    return (result && result.Genres) || [];
  });
}

function genreCountsOrScan(parentId, itemType) {
  return getGenreCounts(parentId, itemType).catch(function () {
    return scanGenres(parentId, itemType).then(function (items) {
      const counts = {};
      items.forEach(function (item) {
        (item.Genres || []).forEach(function (genre) {
          counts[genre] = (counts[genre] || 0) + 1;
        });
      });
      return Object.keys(counts).map(function (name) {
        return { Name: name, Count: counts[name] };
      });
    });
  });
}

export function getAllGenres(parentId, itemType) {
  return genreCountsOrScan(parentId, itemType).then(function (counts) {
    return counts.map(function (entry) {
      return entry.Name;
    }).sort(function (a, b) {
      return a.localeCompare(b);
    });
  });
}

function discoverGenresByCount(parentId, itemType, limit) {
  return genreCountsOrScan(parentId, itemType)
    .then(function (counts) {
      return counts
        .filter(function (entry) {
          return entry.Count >= 8;
        })
        .sort(function (a, b) {
          return b.Count - a.Count;
        })
        .slice(0, limit || 6)
        .map(function (entry) {
          return entry.Name;
        });
    })
    .catch(function () {
      return [];
    });
}

export function discoverGenres(parentId, itemType, limit) {
  const max = limit || 6;
  return getAllGenres(parentId, itemType)
    .then(function (allGenres) {
      const byLower = {};
      allGenres.forEach(function (genre) {
        byLower[genre.toLowerCase()] = genre;
      });

      const picked = [];
      COMMON_GENRES.forEach(function (name) {
        const real = byLower[name.toLowerCase()];
        if (real && picked.indexOf(real) === -1) picked.push(real);
      });

      if (picked.length >= max) return picked;

      return discoverGenresByCount(parentId, itemType, max + picked.length)
        .then(function (byCount) {
          byCount.forEach(function (genre) {
            if (picked.length < max && picked.indexOf(genre) === -1) picked.push(genre);
          });
          return picked;
        })
        .catch(function () {
          return picked;
        });
    })
    .catch(function () {
      return discoverGenresByCount(parentId, itemType, max);
    });
}

export function searchGenreOrCategory(query) {
  return getJson('/Jellio/genres/search?query=' + encodeURIComponent(query || ''));
}

// A genre row, from the server's few-minute cache of the same query
// (Controllers/GenresController.cs), else asked of Jellyfin directly.
export function getGenreItems(parentId, itemType, genre, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const cachedParams = new URLSearchParams({
    genre: genre,
    types: itemType,
    limit: String(limit || 24),
    enableVirtual: 'true',
  });
  if (parentId) cachedParams.set('parentId', parentId);
  const cachedPath = '/Jellio/genres/items?' + cachedParams.toString();
  return cached(cachedPath, function () {
    return rowJson(cachedPath, 'genres');
  })
    .then(function (result) {
      return collapseAudiobookTracks((result && result.Items) || []);
    })
    .catch(function () {
      return getGenreItemsDirect(parentId, itemType, genre, limit);
    });
}

// One page of a genre, for list views that keep loading as they scroll.
export function getGenreItemsPage(parentId, itemType, genre, startIndex, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const cachedParams = new URLSearchParams({
    genre: genre,
    types: itemType || 'Movie,Series',
    startIndex: String(startIndex || 0),
    limit: String(limit || 24),
    enableVirtual: 'true',
  });
  if (parentId) cachedParams.set('parentId', parentId);
  const cachedPath = '/Jellio/genres/items?' + cachedParams.toString();
  return rowJson(cachedPath, 'genres')
    .then(function (result) {
      return collapseAudiobookTracks((result && result.Items) || []);
    })
    .catch(function () {
      const params = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: itemType,
        Genres: genre,
        StartIndex: String(startIndex || 0),
        Limit: String(limit || 60),
        Fields: 'ProductionYear,CommunityRating,PrimaryImageAspectRatio,Genres,Overview,ImageTags,BackdropImageTags',
        SortBy: 'CommunityRating',
        SortOrder: 'Descending',
      });
      if (parentId) params.set('ParentId', parentId);
      return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'genres').then(function (result) {
        return collapseAudiobookTracks((result && result.Items) || []);
      });
    });
}

function getGenreItemsDirect(parentId, itemType, genre, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Genres: genre,
    Limit: String(limit || 20),
    Fields: 'ProductionYear,CommunityRating,PrimaryImageAspectRatio,Genres,Overview,ImageTags,BackdropImageTags',
    SortBy: 'CommunityRating',
    SortOrder: 'Descending',
  });
  if (parentId) params.set('ParentId', parentId);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres');
  }).then(function (result) {
    return collapseAudiobookTracks((result && result.Items) || []);
  });
}

export function getSeasonalItems(genres, searchTerms, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const jobs = [];

  if (genres && genres.length) {
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      Genres: genres.join('|'),
      Limit: String(limit || 50),
      Fields: 'Genres,ProductionYear,CommunityRating',
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
    });
    const path = '/Users/' + userId + '/Items?' + params.toString();
    jobs.push(
      cached(path, function () {
        return rowJson(path, 'rows');
      }).then(function (result) {
        return (result && result.Items) || [];
      }).catch(function () {
        return [];
      }),
    );
  }

  if (searchTerms && searchTerms.length) {
    searchTerms.slice(0, 2).forEach(function (term) {
      const params = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        searchTerm: term,
        Limit: '25',
        Fields: 'Genres,ProductionYear,CommunityRating',
      });
      const path = '/Users/' + userId + '/Items?' + params.toString();
      jobs.push(
        cached(path, function () {
          return rowJson(path, 'rows');
        }).then(function (result) {
          return (result && result.Items) || [];
        }).catch(function () {
          return [];
        }),
      );
    });
  }

  return Promise.all(jobs).then(function (results) {
    const combined = [];
    const seen = new Set();
    results.forEach(function (list) {
      list.forEach(function (item) {
        if (!seen.has(item.Id)) {
          seen.add(item.Id);
          combined.push(item);
        }
      });
    });
    return collapseAudiobookTracks(combined);
  });
}
