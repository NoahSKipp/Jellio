import { t } from './i18n.js';
import { getRecentlyCompleted, getRecommendationCandidates, getNextUp, getGenreItems, getGenreItemsPage } from './api.js';
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
  person: 1.2,
  era: 0.4,
  rating: 0.3,
  runtime: 0.3,
};

const LIKED_SEED_BOOST = 1.35;

const MAX_PER_PERSON = 2;
const MAX_PER_GENRE = 3;

const MIN_RATING = 5;

const MIN_GENRE_COUNT = 3;
const MAX_GENRE_ROWS = 1;

const TICKS_PER_HOUR = 10000000 * 3600;

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

function score(seed, entry) {
  const item = entry.item;
  const overlap = jaccard(seed.Genres || [], item.Genres || []);
  if (!overlap) return 0;

  const likedBoost = seed.UserData && seed.UserData.Likes === true ? LIKED_SEED_BOOST : 1;
  let total = WEIGHT.genre * overlap * likedBoost;
  if (entry.viaPerson) total += WEIGHT.person;

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

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
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
  let people = 0;

  for (let i = 0; i < scored.length && chosen.length < count; i++) {
    const entry = scored[i].entry;
    const primary = (entry.item.Genres || [])[0] || '';

    if (entry.viaPerson && people >= MAX_PER_PERSON) continue;
    if (primary && (perGenre[primary] || 0) >= MAX_PER_GENRE) continue;

    if (entry.viaPerson) people++;
    if (primary) perGenre[primary] = (perGenre[primary] || 0) + 1;
    chosen.push(entry.item);
  }

  return chosen;
}

function markSeen(exclude, item) {
  exclude[item.Id] = true;
  exclude[titleKey(item)] = true;
}

const seedCandidatesCache = new Map();

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

function genreWeight(item) {
  const likes = item.UserData && item.UserData.Likes;
  if (likes === true) return 2;
  if (likes === false) return 0;
  return 1;
}

function topGenres(history) {
  const counts = {};
  history.forEach(function (item) {
    const weight = genreWeight(item);
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

function fetchGenreItemsList(genres) {
  return Promise.all(
    genres.map(function (genre) {
      return getGenreItems(null, 'Movie,Series', genre, ROW_SIZE).catch(function (err) {
        console.warn('Jellio: could not load top genre row', err);
        return null;
      });
    }),
  );
}

function buildGenreRows(genres, itemsPerGenre, exclude) {
  const rows = [];
  for (let i = 0; i < genres.length; i++) {
    const raw = itemsPerGenre[i];
    if (!raw) continue;
    const genre = genres[i];
    const items = dedupe(raw.filter(notPlayed), exclude);
    if (items.length) {
      rows.push({
        title: t('home_top_picks'),
        items: items,
        genre: genre,
        fetchPage: function (start, size) {
          return getGenreItemsPage(null, 'Movie,Series', genre, start, size).then(function (page) {
            return dedupe((page || []).filter(notPlayed), exclude);
          });
        },
      });
    }
  }
  return rows;
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
  function notDisliked(seed) {
    return !(seed.UserData && seed.UserData.Likes === false);
  }
  const completedSeeds = history.filter(notDisliked).slice(0, SEED_LIMIT);
  const nextUpSeeds = nextUp.filter(notDisliked);
  const genres = topGenres(history).slice(0, MAX_GENRE_ROWS);

  function emit(spec, slot) {
    if (spec && spec.items && spec.items.length) onRow(spec, slot);
  }

  const jobs = [];
  completedSeeds.forEach(function (seed, i) {
    jobs.push(
      fetchSeedCandidates([seed]).then(function (entries) {
        emit(pickSeedRows([seed], entries, (s) => t('home_because_watched', { name: s.Name }), exclude)[0], RECOMMENDATION_SLOTS.completed + i);
      }),
    );
  });
  nextUpSeeds.forEach(function (seed, i) {
    jobs.push(
      fetchSeedCandidates([seed]).then(function (entries) {
        emit(pickSeedRows([seed], entries, (s) => t('home_because_watching', { name: s.SeriesName || s.Name }), exclude)[0], RECOMMENDATION_SLOTS.nextUp + i);
      }),
    );
  });
  genres.forEach(function (genre, i) {
    jobs.push(
      fetchGenreItemsList([genre]).then(function (list) {
        emit(buildGenreRows([genre], list, exclude)[0], RECOMMENDATION_SLOTS.genres + i);
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

async function buildRecommendationRows(exclude) {
  const [history, nextUp] = await Promise.all([
    getRecentlyCompleted(HISTORY_SAMPLE_LIMIT).catch(function () {
      return [];
    }),
    getNextUp(NEXTUP_SEED_LIMIT).catch(function () {
      return [];
    }),
  ]);

  function notDisliked(seed) {
    return !(seed.UserData && seed.UserData.Likes === false);
  }

  const completedSeeds = history.filter(notDisliked).slice(0, SEED_LIMIT);
  const nextUpSeeds = nextUp.filter(notDisliked);
  const genres = topGenres(history).slice(0, MAX_GENRE_ROWS);

  const [completedEntries, nextUpEntries, genreItemsList] = await Promise.all([
    fetchSeedCandidates(completedSeeds),
    fetchSeedCandidates(nextUpSeeds),
    fetchGenreItemsList(genres),
  ]);

  const completedRows = pickSeedRows(completedSeeds, completedEntries, function (seed) {
    return t('home_because_watched', { name: seed.Name });
  }, exclude);

  const nextUpRows = pickSeedRows(nextUpSeeds, nextUpEntries, function (seed) {
    return t('home_because_watching', { name: seed.SeriesName || seed.Name });
  }, exclude);

  const genreRows = buildGenreRows(genres, genreItemsList, exclude);
  const seasonalRow = await getSeasonalRecommendationRow(exclude);
  const seasonalRows = seasonalRow ? [seasonalRow] : [];

  return genreRows.concat(seasonalRows, completedRows, nextUpRows);
}
