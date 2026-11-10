import { getDisplayCulture } from '../i18n.js';
import { loadItemInfo } from '../itemInfo.js';
import { getCurrentUserId, getServerAddress, getAuthHeaders } from '../auth.js';
import { isNetworkError, findDownload } from '../offline.js';
import { isReleasedToday, isTodayItemStreamVerified, markTodayItemHasStream, isUnreleasedItem, filterReleasedItems } from '../releaseDate.js';
import { ITEM_DETAILS_TIMEOUT_MS, SHORT_CACHE_TTL_MS, cache, cached, cachedRecent, getJson, invalidateCache, invalidateUserDataRows, rowJson } from './core.js';
import { getMediaSources } from './playback.js';

export function getItem(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  return cached('item:' + itemId + ':' + culture, function () {
    return loadItemInfo(getJson, userId, itemId, { culture: culture });
  }).catch(function (err) {
    return downloadedItem(itemId, err);
  });
}

export function isUnreachable(err) {
  return isNetworkError(err) || !!(err && err.timedOut);
}

// A downloaded item's stored data, standing in for the server's when it
// can't be reached; otherwise the original error.
async function downloadedItem(itemId, err) {
  if (!isUnreachable(err)) throw err;
  const record = await findDownload(itemId);
  if (!record) throw err;
  const key = String(itemId).replace(/-/g, '').toLowerCase();
  const track = (record.Tracks || []).find((entry) => String(entry.Id).replace(/-/g, '').toLowerCase() === key);
  return track || record.Item;
}

export function seedItemCache(item) {
  if (!item) return;
  const id = item.Id || item.id;
  if (!id) return;
  if (!item.Id) item.Id = id;
  const key = 'item:' + id;
  const existing = cache.get(key);
  if (!existing) {
    cache.set(key, { promise: Promise.resolve(item), ts: Date.now(), value: item });
  } else if (!existing.value) {
    existing.value = item;
  }
  const culture = getDisplayCulture();
  if (culture) {
    const cultureKey = 'item:' + id + ':' + culture;
    const existingCulture = cache.get(cultureKey);
    if (!existingCulture) {
      cache.set(cultureKey, { promise: Promise.resolve(item), ts: Date.now(), value: item });
    } else if (!existingCulture.value) {
      existingCulture.value = item;
    }
  }
}

export function getCachedItemSync(itemId) {
  if (!itemId) return null;
  const culture = getDisplayCulture();
  const hit = cache.get('details:' + itemId + ':' + culture) ||
    cache.get('details:' + itemId + ':full:' + culture) ||
    cache.get('item:' + itemId + ':' + culture) ||
    cache.get('details:' + itemId) ||
    cache.get('details:' + itemId + ':full') ||
    cache.get('item:' + itemId);
  return hit ? hit.value : null;
}

export function getItemDetails(itemId, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const culture = getDisplayCulture();
  const cacheKey = 'details:' + itemId + (opts.includePlaybackFields ? ':full' : '') + ':' + culture;
  // Info only (runtime/itemInfo.js): streams come from getMediaSources.
  return cachedRecent(cacheKey, function () {
    return loadItemInfo(getJson, userId, itemId, {
      includePlaybackFields: !!opts.includePlaybackFields,
      timeoutMs: ITEM_DETAILS_TIMEOUT_MS,
      culture: culture,
      signal: opts.signal,
    });
  }, SHORT_CACHE_TTL_MS, itemId).catch(function (err) {
    return downloadedItem(itemId, err);
  });
}

export function getResumeItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Resume?Limit=' +
    (limit || 20) +
    // Video only: a half-listened audiobook resumes into its own
    // Continue Listening row (getContinueListening below), not here.
    '&MediaTypes=Video' +
    '&Fields=PrimaryImageAspectRatio,RunTimeTicks&EnableImageTypes=Primary,Backdrop,Thumb' +
    (getDisplayCulture() ? '&Culture=' + encodeURIComponent(getDisplayCulture()) : '');
  return rowJson(query, 'personal', { priority: true, rank: 0 }).then(function (result) {
    return applyRealDurationOverrides((result && result.Items) || []);
  });
}

let audiobookLibraryMissing = false;

export function getAudiobookLibraryChapters(itemId) {
  if (audiobookLibraryMissing) return Promise.resolve(null);
  return getJson('/AudiobookLibrary/Books/' + itemId + '/Chapters').catch(function (err) {
    // A 404 on the route itself most likely means the plugin isn't
    // installed at all; stop asking for the rest of this page's life.
    if (err && err.status === 404) audiobookLibraryMissing = true;
    return null;
  });
}

const todayEmptyStreamsCache = new Map();
export const TODAY_EMPTY_STREAMS_TTL_MS = 2 * 60 * 1000;

export function clearTodayEmptyStreamsCache() {
  todayEmptyStreamsCache.clear();
}

export async function verifyTodayEpisodesHaveStreams(items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const now = Date.now();
  await Promise.all(
    items.map(async function (item) {
      if (!item || !item.Id) return;
      if (!isReleasedToday(item, now)) return;
      const dateStr = item.PremiereDate || item.EndDate;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime()) && d.getTime() > now) {
          return;
        }
      }
      if (isTodayItemStreamVerified(item.Id)) return;
      const idStr = String(item.Id);
      const lastEmptyTime = todayEmptyStreamsCache.get(idStr);
      if (lastEmptyTime && now - lastEmptyTime < TODAY_EMPTY_STREAMS_TTL_MS) {
        return;
      }
      try {
        const sources = await getMediaSources(item.Id);
        const hasStreams = Array.isArray(sources) && sources.length > 0;
        markTodayItemHasStream(item.Id, hasStreams);
        if (hasStreams) {
          todayEmptyStreamsCache.delete(idStr);
        } else {
          todayEmptyStreamsCache.set(idStr, Date.now());
        }
      } catch (_) {
        markTodayItemHasStream(item.Id, false);
        todayEmptyStreamsCache.set(idStr, Date.now());
      }
    }),
  );
  return items.filter(function (item) {
    return !isUnreleasedItem(item, now) && (!isReleasedToday(item, now) || isTodayItemStreamVerified(item.Id));
  });
}

export function getNextUp(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const targetLimit = limit || 20;
  const fetchLimit = Math.max(targetLimit * 2, 40);
  const params = new URLSearchParams({
    userId: userId,
    Limit: String(fetchLimit),
    Fields: 'PrimaryImageAspectRatio,Genres,People,RunTimeTicks,PremiereDate,EndDate',
    enableResumable: 'false',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return Promise.all([
    cached(path, function () {
      return rowJson(path, 'personal', { priority: true, rank: 1 });
    }, SHORT_CACHE_TTL_MS),
    getHiddenNextUpSeries(),
  ]).then(async function (results) {
    const rawItems = (results[0] && results[0].Items) || [];
    const verifiedItems = await verifyTodayEpisodesHaveStreams(rawItems);
    const items = filterReleasedItems(verifiedItems);
    const hidden = results[1];
    const filtered = !hidden.length
      ? items
      : items.filter(function (item) {
          return hidden.indexOf(item.SeriesId) === -1;
        });
    return filtered.slice(0, targetLimit);
  });
}

function getHiddenNextUpSeries() {
  return cached('next-up-hidden', function () {
    return rowJson('/Jellio/next-up-hidden', 'personal', { priority: true, rank: 1 });
  }, SHORT_CACHE_TTL_MS).catch(function () {
    return [];
  });
}

export function hideSeriesFromNextUp(seriesId) {
  invalidateCache('next-up-hidden');
  return fetch(getServerAddress() + '/Jellio/next-up-hidden/' + encodeURIComponent(seriesId), {
    method: 'POST',
    headers: getAuthHeaders(),
  }).then(function (response) {
    if (!response.ok) throw new Error('Failed to hide series from Up Next');
    invalidateUserDataRows();
  });
}

export function getSeriesNextUp(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    userId: userId,
    seriesId: seriesId,
    Limit: '1',
    Fields: 'PrimaryImageAspectRatio,RunTimeTicks,PremiereDate,EndDate',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(async function (result) {
    const rawItems = (result && result.Items) || [];
    const items = await verifyTodayEpisodesHaveStreams(rawItems);
    return items[0] || null;
  });
}

export function getRecentlyCompleted(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Filters: 'IsPlayed',
    SortBy: 'DatePlayed',
    SortOrder: 'Descending',
    Limit: String(limit),
    Fields: 'Genres,People,ProductionYear,CommunityRating,RunTimeTicks',
  });
  return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'personal', { rank: 5 }).then(function (result) {
    return (result && result.Items) || [];
  });
}

export async function getRecommendationCandidates(seed, limit) {
  const userId = getCurrentUserId();
  if (!userId) return [];

  const genres = seed.Genres || [];
  const people = (seed.People || [])
    .filter(function (person) {
      return person.Id && (person.Type === 'Actor' || person.Type === 'Director');
    })
    .slice(0, 5);

  const base =
    '/Users/' +
    userId +
    '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=' +
    (limit || 100) +
    '&Fields=Genres,ProductionYear,CommunityRating,RunTimeTicks&SortBy=CommunityRating&SortOrder=Descending';

  const jobs = [];
  if (genres.length) {
    jobs.push(
      rowJson(base + '&Genres=' + encodeURIComponent(genres.join('|')), 'rows')
        .then(function (result) {
          return { tag: 'genre', items: (result && result.Items) || [] };
        })
        .catch(function () {
          return { tag: 'genre', items: [] };
        }),
    );
  }
  if (people.length) {
    const personIds = people
      .map(function (person) {
        return person.Id;
      })
      .join(',');
    jobs.push(
      rowJson(base + '&PersonIds=' + personIds, 'rows')
        .then(function (result) {
          return { tag: 'person', items: (result && result.Items) || [] };
        })
        .catch(function () {
          return { tag: 'person', items: [] };
        }),
    );
  }
  if (!jobs.length) return [];

  const results = await Promise.all(jobs);
  const byId = {};
  results.forEach(function (result) {
    result.items.forEach(function (item) {
      let entry = byId[item.Id];
      if (!entry) entry = byId[item.Id] = { item: item, viaPerson: false };
      if (result.tag === 'person') entry.viaPerson = true;
    });
  });
  return shuffleInPlace(
    Object.keys(byId).map(function (id) {
      return byId[id];
    }),
  );
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

export function itemTypesForKind(collectionType) {
  if (collectionType === 'movies') return 'Movie';
  if (collectionType === 'books') return 'Book,AudioBook';
  return 'Series';
}

export function audiobookGroupKey(item) {
  return (item.ParentId || '') + '|' + (item.Album || '');
}

export function audiobookTitle(item, trackCount) {
  if (item.Album) return item.Album;
  if (trackCount > 1) {
    const parts = String(item.Path || '').split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
  }
  return item.Name;
}

export function collapseAudiobookTracks(items) {
  const counts = new Map();
  (items || []).forEach(function (item) {
    if (item && item.Type === 'AudioBook') {
      const key = audiobookGroupKey(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  const seen = new Set();
  const out = [];
  (items || []).forEach(function (item) {
    if (!item || item.Type !== 'AudioBook') {
      out.push(item);
      return;
    }
    const key = audiobookGroupKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    const title = audiobookTitle(item, counts.get(key));
    out.push(title !== item.Name ? Object.assign({}, item, { Name: title, SortName: title }) : item);
  });
  return out;
}

export function getLibraryItems(parentId, collectionType, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const params = new URLSearchParams({
    ParentId: parentId,
    Recursive: 'true',
    IncludeItemTypes: itemTypesForKind(collectionType),
    SortBy: opts.sortBy || 'SortName',
    SortOrder: opts.sortOrder || 'Ascending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,CommunityRating,Path',
    Limit: String(opts.limit || 100),
    StartIndex: String(opts.startIndex || 0),
  });
  if (opts.genre) params.set('Genres', opts.genre);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
    if (collectionType !== 'books' || !result) return result;
    return Object.assign({}, result, { Items: collapseAudiobookTracks(result.Items) });
  });
}

export function getSeasons(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  const path = '/Shows/' + seriesId + '/Seasons?userId=' + userId + (culture ? '&Culture=' + encodeURIComponent(culture) : '');
  return cachedRecent(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS, seriesId).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Every episode of a series, all seasons, in order, with watched state.
export function getSeriesEpisodes(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({ userId: userId, Fields: 'PrimaryImageAspectRatio,PremiereDate,EndDate' });
  return getJson('/Shows/' + seriesId + '/Episodes?' + params.toString(), 30000).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getEpisodes(seriesId, seasonId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  const params = new URLSearchParams({
    userId: userId,
    Fields: 'Overview,PrimaryImageAspectRatio,PremiereDate,EndDate',
  });
  if (seasonId) params.set('seasonId', seasonId);
  if (culture) params.set('Culture', culture);
  const path = '/Shows/' + seriesId + '/Episodes?' + params.toString();
  return cachedRecent(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS, seriesId).then(function (result) {
    return (result && result.Items) || [];
  });
}

export async function getNextEpisode(item) {
  if (!item || item.Type !== 'Episode' || !item.SeriesId) return null;

  if (item.SeasonId) {
    const episodes = await getEpisodes(item.SeriesId, item.SeasonId);
    const index = episodes.findIndex(function (episode) {
      return episode.Id === item.Id;
    });
    if (index !== -1 && index + 1 < episodes.length) {
      const candidate = episodes[index + 1];
      if (candidate) {
        const verified = await verifyTodayEpisodesHaveStreams([candidate]);
        if (!verified.length) return null;
        return candidate;
      }
    }
  }

  const seasons = await getSeasons(item.SeriesId);
  const seasonIndex = seasons.findIndex(function (season) {
    return season.Id === item.SeasonId;
  });
  const nextSeason = seasonIndex !== -1 ? seasons[seasonIndex + 1] : null;
  if (!nextSeason) return null;

  const nextEpisodes = await getEpisodes(item.SeriesId, nextSeason.Id);
  const candidate = nextEpisodes.length ? nextEpisodes[0] : null;
  if (candidate) {
    const verified = await verifyTodayEpisodesHaveStreams([candidate]);
    if (!verified.length) return null;
    return candidate;
  }
  return null;
}

export function getPerson(personId) {
  return getItem(personId);
}

function getRealDurationOverrides(itemIds) {
  if (!itemIds.length) return Promise.resolve({});
  return rowJson('/Jellio/real-duration?ids=' + itemIds.join(','), 'personal', { priority: true, rank: 0 }).catch(function () {
    return {};
  });
}

function applyRealDurationOverrides(items) {
  const withIds = items.filter(function (item) {
    return item && item.Id;
  });
  if (!withIds.length) return Promise.resolve(items);
  return getRealDurationOverrides(
    withIds.map(function (item) {
      return item.Id;
    }),
  ).then(function (overrides) {
    withIds.forEach(function (item) {
      const key = item.Id.replace(/-/g, '');
      const realTicks = overrides[key];
      if (!realTicks) return;
      item.RunTimeTicks = realTicks;
      const posTicks = item.UserData && item.UserData.PlaybackPositionTicks;
      if (item.UserData && posTicks) {
        item.UserData.PlayedPercentage = Math.min(100, (posTicks / realTicks) * 100);
      }
    });
    return items;
  });
}

export function getPersonFilmography(personId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    personIds: personId,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series,Book,AudioBook',
    SortBy: 'PremiereDate,SortName',
    SortOrder: 'Descending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,Album,Artists,SeriesName',
    Limit: String(limit || 100),
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}
