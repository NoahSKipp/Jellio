import { t } from './i18n.js';
import { onHomeInvalidate } from './homeInvalidate.js';
import { getRecentlyCompleted, getRecommendationCandidates, getTopPicksRecommendations, getNextUp, getGenreItems } from './api.js';
import { dedupe, titleKey } from './dedupe.js';
// Loaded on first use: it pulls in components/seasons.js, which startup does not need.
function getSeasonalRecommendationRow(exclude) {
  return import('./seasonalRecommendations.js').then(
    function (m) {
      return m.getSeasonalRecommendationRow(exclude);
    },
    function () {
      return null;
    },
  );
}

const SEED_LIMIT = 4;
const HISTORY_SAMPLE_LIMIT = 60;
const NEXTUP_SEED_LIMIT = 2;
const POOL_LIMIT = 100;
const ROW_SIZE = 20;

const WEIGHT = {
  genre: 3,
  person: 1.6,
  studio: 0.7,
  era: 0.4,
  rating: 0.6,
  runtime: 0.3,
};

const LIKED_SEED_BOOST = 2.5;
const MAX_PER_PERSON = 2;
const MAX_PER_GENRE = 3;
const MIN_RATING = 5.5;
const MIN_GENRE_COUNT = 3;
const TICKS_PER_HOUR = 10000000 * 3600;
const RECENCY_HALF_LIFE_DAYS = 21;

const seedCandidatesCache = new Map();
let topPicksBackendCache = null;

export function invalidateRecommendationsCache() {
  seedCandidatesCache.clear();
  topPicksBackendCache = null;
}

onHomeInvalidate(function () {
  invalidateRecommendationsCache();
});

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const set = {};
  a.forEach(function (x) {
    set[x] = true;
  });
  let shared = 0;
  b.forEach(function (x) {
    if (set[x]) shared++;
  });
  return shared / (a.length + b.length - shared);
}

function hasSharedStudio(seed, item) {
  const sStudios = (seed.Studios || []).map(function (s) { return (s && (s.Name || s)) || ''; }).filter(Boolean);
  const iStudios = (item.Studios || []).map(function (s) { return (s && (s.Name || s)) || ''; }).filter(Boolean);
  if (!sStudios.length || !iStudios.length) return false;
  return iStudios.some(function (s) { return sStudios.indexOf(s) !== -1; });
}

export function seedWeight(seed, nowMs) {
  const likes = seed.UserData && seed.UserData.Likes;
  if (likes === false) return 0;
  let weight = likes === true ? LIKED_SEED_BOOST : 1.0;

  const playedStr = seed.UserData && seed.UserData.LastPlayedDate;
  if (playedStr) {
    const playedMs = Date.parse(playedStr);
    if (!Number.isNaN(playedMs)) {
      const daysAgo = Math.max(0, ((nowMs || Date.now()) - playedMs) / 86400000);
      weight *= Math.exp(-daysAgo / RECENCY_HALF_LIFE_DAYS);
    }
  }

  const playCount = (seed.UserData && seed.UserData.PlayCount) || 0;
  const recentEps = seed._recentEpisodeCount || 0;
  if (playCount > 1 || recentEps >= 3) {
    weight += 0.4;
  }
  return weight;
}

export function score(seed, entry) {
  const item = entry.item;
  const overlap = jaccard(seed.Genres || [], item.Genres || []);
  const sharedStudio = hasSharedStudio(seed, item);
  if (!overlap && !entry.viaPerson && !sharedStudio) return 0;

  const sWeight = seedWeight(seed);
  if (!sWeight) return 0;

  let total = WEIGHT.genre * overlap * sWeight;
  if (entry.viaPerson) total += WEIGHT.person * Math.min(2, (entry.matchedPersonIds && entry.matchedPersonIds.length) || 1) * (seed.UserData && seed.UserData.Likes === true ? 1.5 : 1);
  if (sharedStudio) total += WEIGHT.studio;

  if (seed.ProductionYear && item.ProductionYear) {
    const gap = Math.abs(seed.ProductionYear - item.ProductionYear);
    total += WEIGHT.era * (1 - Math.min(1, gap / 20));
  }

  if (item.CommunityRating) {
    total += WEIGHT.rating * (item.CommunityRating / 10);
  }

  if (seed.RunTimeTicks && item.RunTimeTicks) {
    const gap = Math.abs(seed.RunTimeTicks - item.RunTimeTicks);
    total += WEIGHT.runtime * (1 - Math.min(1, gap / TICKS_PER_HOUR));
  }

  return total;
}

function notPlayed(item) {
  return !(item.UserData && item.UserData.Played);
}

function notDislikedItem(item) {
  return !(item.UserData && item.UserData.Likes === false);
}

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function franchiseKey(item) {
  if (item.CollectionName) return 'col:' + nameKey(item.CollectionName);
  if (item.SeriesId) return 'series:' + item.SeriesId;
  const base = nameKey(item.SeriesName || item.Name)
    .replace(/\s+(part|vol|volume|chapter)\s+[0-9ivx]+$/i, '')
    .replace(/\s+[0-9]+$/, '')
    .replace(/:\s+.*$/, '');
  return base || titleKey(item);
}

function pick(seed, entries, exclude, count) {
  const seedKey = titleKey(seed);
  const seedNames = [nameKey(seed.SeriesName || seed.Name), nameKey(seed.Name)].filter(Boolean);
  const scored = entries
    .filter(function (entry) {
      if (entry.item.Id === seed.Id || titleKey(entry.item) === seedKey) return false;
      if (seedNames.indexOf(nameKey(entry.item.SeriesName || entry.item.Name)) !== -1) return false;
      if (seed.SeriesId && (entry.item.Id === seed.SeriesId || entry.item.SeriesId === seed.SeriesId)) return false;
      if (exclude[entry.item.Id] || exclude[titleKey(entry.item)]) return false;
      if (!notDislikedItem(entry.item)) return false;
      if (entry.item.CommunityRating && entry.item.CommunityRating < MIN_RATING) return false;
      if (!notPlayed(entry.item)) return false;
      return true;
    })
    .map(function (entry) {
      return { entry: entry, value: score(seed, entry) };
    })
    .filter(function (s) {
      return s.value > 0;
    })
    .sort(function (a, b) {
      return b.value - a.value;
    });

  const chosen = [];
  const perGenre = {};
  const perPerson = {};

  for (let i = 0; i < scored.length && chosen.length < count; i++) {
    const entry = scored[i].entry;
    const primary = (entry.item.Genres || [])[0] || '';
    const personIds = entry.viaPerson
      ? ((entry.matchedPersonIds && entry.matchedPersonIds.length) ? entry.matchedPersonIds : ['_person'])
      : [];

    if (personIds.some(function (pid) { return (perPerson[pid] || 0) >= MAX_PER_PERSON; })) continue;
    if (primary && (perGenre[primary] || 0) >= MAX_PER_GENRE) continue;

    personIds.forEach(function (pid) {
      perPerson[pid] = (perPerson[pid] || 0) + 1;
    });
    if (primary) perGenre[primary] = (perGenre[primary] || 0) + 1;
    chosen.push(entry.item);
  }

  return chosen;
}

function markSeen(exclude, item) {
  exclude[item.Id] = true;
  exclude[titleKey(item)] = true;
}

function fetchSeedCandidates(seeds) {
  return Promise.all(
    seeds.map(function (seed) {
      if (!seed || !seed.Id) return Promise.resolve(null);
      if (seedCandidatesCache.has(seed.Id)) {
        return Promise.resolve(seedCandidatesCache.get(seed.Id));
      }
      return getRecommendationCandidates(seed, POOL_LIMIT)
        .then(function (res) {
          seedCandidatesCache.set(seed.Id, res);
          return res;
        })
        .catch(function (err) {
          console.warn('Jellio: could not load recommendation candidates', err);
          return null;
        });
    }),
  );
}

function pickSeedRows(seeds, entriesPerSeed, titleFor, exclude) {
  const rows = [];
  for (let i = 0; i < seeds.length; i++) {
    const entries = entriesPerSeed[i];
    if (!entries) continue;
    const seed = seeds[i];
    const items = pick(seed, entries, exclude, ROW_SIZE);
    if (!items.length) continue;
    items.forEach(function (item) {
      markSeen(exclude, item);
    });
    rows.push({ title: titleFor(seed), items: items });
  }
  return rows;
}

function topGenres(history) {
  const counts = {};
  history.forEach(function (item) {
    const weight = seedWeight(item);
    if (!weight) return;
    (item.Genres || []).forEach(function (genre) {
      counts[genre] = (counts[genre] || 0) + weight;
    });
  });
  return Object.keys(counts)
    .filter(function (genre) {
      return counts[genre] >= MIN_GENRE_COUNT;
    })
    .sort(function (a, b) {
      return counts[b] - counts[a];
    });
}

async function buildTopPicksRow(history, exclude) {
  if (!topPicksBackendCache) {
    topPicksBackendCache = getTopPicksRecommendations(ROW_SIZE).catch(function () {
      return [];
    });
  }

  const topSeeds = history
    .filter(notDislikedItem)
    .slice()
    .sort(function (a, b) { return seedWeight(b) - seedWeight(a); })
    .slice(0, 5);

  const [backendItems, seedEntriesList] = await Promise.all([
    topPicksBackendCache,
    fetchSeedCandidates(topSeeds),
  ]);

  const combinedScores = new Map();
  const historyIds = new Set(history.map(function (h) { return h.Id; }));

  // Backend curated TMDB collaborative + library affinity items lead Top Picks
  (backendItems || []).forEach(function (item, index) {
    if (!item || !item.Id) return;
    if (historyIds.has(item.Id) || exclude[item.Id] || exclude[titleKey(item)]) return;
    if (!notPlayed(item) || !notDislikedItem(item)) return;
    if (item.CommunityRating && item.CommunityRating < MIN_RATING) return;
    combinedScores.set(item.Id, {
      item: item,
      score: 12 - index * 0.25,
      seedMatches: 1,
    });
  });

  // Multi-seed client aggregation with co-occurrence boost
  topSeeds.forEach(function (seed, idx) {
    const entries = seedEntriesList[idx];
    if (!entries) return;
    entries.forEach(function (entry) {
      const item = entry && entry.item;
      if (!item || !item.Id || item.Id === seed.Id) return;
      if (historyIds.has(item.Id) || exclude[item.Id] || exclude[titleKey(item)]) return;
      if (!notPlayed(item) || !notDislikedItem(item)) return;
      if (item.CommunityRating && item.CommunityRating < MIN_RATING) return;

      const s = score(seed, entry);
      if (s <= 0) return;

      const existing = combinedScores.get(item.Id);
      if (!existing) {
        combinedScores.set(item.Id, { item: item, score: s, seedMatches: 1 });
      } else {
        existing.score += s + 1.5;
        existing.seedMatches += 1;
      }
    });
  });

  // Fallback fill with top weighted genres if still under ROW_SIZE
  if (combinedScores.size < ROW_SIZE) {
    const fallbackGenres = topGenres(history).slice(0, 2);
    if (fallbackGenres.length) {
      const lists = await Promise.all(
        fallbackGenres.map(function (genre) {
          return getGenreItems(null, 'Movie,Series', genre, 12).catch(function () { return []; });
        }),
      );
      lists.forEach(function (items, gIdx) {
        (items || []).forEach(function (item, rankIdx) {
          if (!item || !item.Id || combinedScores.has(item.Id)) return;
          if (historyIds.has(item.Id) || exclude[item.Id] || exclude[titleKey(item)]) return;
          if (!notPlayed(item) || !notDislikedItem(item)) return;
          if (item.CommunityRating && item.CommunityRating < MIN_RATING) return;
          combinedScores.set(item.Id, {
            item: item,
            score: 1.5 - gIdx * 0.3 - rankIdx * 0.05 + ((item.CommunityRating || 6) / 10) * 0.5,
            seedMatches: 1,
          });
        });
      });
    }
  }

  const ranked = Array.from(combinedScores.values())
    .sort(function (a, b) {
      return b.score - a.score;
    });

  const chosen = [];
  const seenFranchise = new Set();
  for (let i = 0; i < ranked.length && chosen.length < ROW_SIZE; i++) {
    const item = ranked[i].item;
    const fKey = franchiseKey(item);
    if (fKey && seenFranchise.has(fKey)) continue;
    if (fKey) seenFranchise.add(fKey);
    markSeen(exclude, item);
    chosen.push(item);
  }

  if (!chosen.length) return null;
  return {
    title: t('home_top_picks'),
    items: chosen,
  };
}

const RECOMMENDATION_SLOTS = { genres: 0, seasonal: 10, completed: 20, nextUp: 40 };

export async function streamRecommendationRows(exclude, onRow) {
  const [history, nextUp] = await Promise.all([
    getRecentlyCompleted(HISTORY_SAMPLE_LIMIT).catch(function () {
      return [];
    }),
    getNextUp(NEXTUP_SEED_LIMIT).catch(function () {
      return [];
    }),
  ]);
  const completedSeeds = history.filter(notDislikedItem).slice(0, SEED_LIMIT);
  const nextUpSeeds = nextUp.filter(notDislikedItem);

  function emit(spec, slot) {
    if (spec && spec.items && spec.items.length) onRow(spec, slot);
  }

  // Build "Top Picks for You" FIRST before individual seed rows claim items in exclude.
  const topPicksRow = await buildTopPicksRow(history, exclude).catch(function () {
    return null;
  });
  emit(topPicksRow, RECOMMENDATION_SLOTS.genres);

  const jobs = [];
  completedSeeds.forEach(function (seed, i) {
    jobs.push(
      fetchSeedCandidates([seed]).then(function (entries) {
        emit(pickSeedRows([seed], entries, function (s) { return t('home_because_watched', { name: s.Name }); }, exclude)[0], RECOMMENDATION_SLOTS.completed + i);
      }),
    );
  });
  nextUpSeeds.forEach(function (seed, i) {
    jobs.push(
      fetchSeedCandidates([seed]).then(function (entries) {
        emit(pickSeedRows([seed], entries, function (s) { return t('home_because_watching', { name: s.SeriesName || s.Name }); }, exclude)[0], RECOMMENDATION_SLOTS.nextUp + i);
      }),
    );
  });
  jobs.push(
    getSeasonalRecommendationRow(exclude)
      .then(function (row) {
        emit(row, RECOMMENDATION_SLOTS.seasonal);
      })
      .catch(function () {}),
  );
  await Promise.all(jobs);
}
