// "Because you watched X" recommendation rows, scored here rather than
// asked of the server. Ported from the original codebase's own
// js/recommend.js, real reasoning preserved rather than re-derived:
// Jellyfin's own similarity engine (GET /Items/{id}/Similar) 404s on a
// Gelato server, because Gelato remaps item ids through its own action
// filter and that route is not one of the ones it covers, confirmed
// on a live install before any of this was written there.
// /Users/{id}/Suggestions does answer, but with no watch history
// behind it the result is noise. So the scoring is ours.
//
// What the fields can actually carry, sampled from 300 real movies and
// series on that same install: genres 98% (2.5 each on average),
// people 94% and ordered by billing, community rating 94% but bunched
// between 6.6 and 8.1 at the quartiles, why rating is only ever a
// tiebreaker below: it barely separates anything.
import { getRecentlyCompleted, getRecommendationCandidates, getNextUp, getGenreItems, getPersonItems } from './api.js';

const SEED_LIMIT = 4;
// Seeds for the two aggregate rows below, a wider real sample of the
// same real endpoint rather than a second one: the first SEED_LIMIT of
// this same, already sorted-by-DatePlayed list is exactly what used to
// be fetched on its own for the per title rows, so one real call here
// covers both instead of firing the same real query twice at two
// different limits.
const HISTORY_SAMPLE_LIMIT = 60;
// A NextUp item is the reader's own real "currently watching", not
// something finished yet, so it earns the same real per title
// treatment as a completed seed, just fewer of them: NextUp's own
// list is normally short (one entry per series in progress), unlike
// getRecentlyCompleted's much deeper real history.
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

// Real Jellyfin's own UserData.Likes (POST/DELETE /Users/{id}/Items/
// {id}/Rating, a plain like/dislike, not a 1-10 scale), fed into this
// scorer on real feedback's own direct ask: a title the reader
// explicitly liked should pull its own "because you watched" row (and
// the aggregate genre signal below) harder toward the same genre,
// explicit signal outweighing whatever a title's own community rating
// or recency alone would have said. A disliked title is excluded as a
// seed entirely further down, never even reaching score() with it.
const LIKED_SEED_BOOST = 1.35;

// Diversity is enforced here, at selection, and not by lowering the
// weights above. Lowering them does not work: one dominant signal
// still wins repeatedly and a row fills with titles sharing a lead
// actor that each scored fairly on their own. A cap during the greedy
// pick is what actually stops it.
const MAX_PER_PERSON = 2;
const MAX_PER_GENRE = 3;

// A floor rather than more weight on rating, for the same reason the
// caps above are caps: a weight can be outvoted by a strong genre
// match, and nothing rated under this should reach a recommendation
// row however well it matches otherwise. Unrated titles pass, no
// rating is not a bad rating.
const MIN_RATING = 5;

// A genre or person needs to recur at least this many times across
// the reader's own real watch history before it is a real enough
// pattern to build a whole row around, not just one title that
// happened to have five genres tagged on it.
const MIN_GENRE_COUNT = 3;
const MIN_PERSON_COUNT = 2;
const MAX_GENRE_ROWS = 1;
const MAX_PERSON_ROWS = 1;

// 1 hour in the same real ticks every RunTimeTicks field already uses
// (api.js's own TICKS_PER_SECOND header documents the same real unit).
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

  // The genre term specifically, not the whole real score: a liked
  // seed should pull harder toward the same genre, not toward a
  // stronger era/rating/runtime coincidence that has nothing to do
  // with why the reader actually liked it.
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

  // A feature-length pick for a seed that was itself a quick watch, or
  // the reverse, reads as a mismatch even with genres lined up
  // perfectly: same real one-hour-gap-forgiving shape the era term
  // above already uses, just measured in runtime instead of years.
  if (seed.RunTimeTicks && item.RunTimeTicks) {
    const gap = Math.abs(seed.RunTimeTicks - item.RunTimeTicks);
    total += WEIGHT.runtime * (1 - Math.min(1, gap / TICKS_PER_HOUR));
  }

  return total;
}

// Real feedback: a title already fully watched has nothing left to
// recommend it for, "because you watched X" or not. Checked here
// rather than at the server, same real UserData shape every other
// signal in this file already reads off each item.
function notPlayed(item) {
  return !(item.UserData && item.UserData.Played);
}

// Title and year, not just id: the library really can carry a
// handful of same name, same year titles that are different films,
// and Gelato hands out an aliased id for the same item on some routes,
// so an id-only exclude set can miss a duplicate a title/year one
// would not.
export function titleKey(item) {
  return String(item.Name || '').trim().toLowerCase() + '|' + (item.ProductionYear || '');
}

// Greedy by score, then the caps. exclude carries everything already
// drawn on the page (this file's own rows and, since
// screens/home.js's own buildRecommendationRows() feeds the same
// object back into its catalog/genre rows, those too), so several
// rows do not become the same twenty titles several times over.
function pick(seed, entries, exclude, count) {
  const seedKey = titleKey(seed);
  const scored = entries
    .filter(function (entry) {
      if (entry.item.Id === seed.Id || titleKey(entry.item) === seedKey) return false;
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

// Same real shape as screens/home.js's own private dedupe(): kept here
// too rather than imported across that boundary, small enough not to
// be worth sharing, and this file already owns titleKey/exclude's own
// real contract.
function dedupe(items, exclude) {
  const kept = [];
  items.forEach(function (item) {
    if (exclude[item.Id] || exclude[titleKey(item)]) return;
    exclude[item.Id] = true;
    exclude[titleKey(item)] = true;
    kept.push(item);
  });
  return kept;
}

// Fetching each seed's own candidates has no dependency on exclude at
// all, only pick() below reads that, so every seed's own real network
// round trip fires together here rather than the second seed waiting
// on the first one's response before it even starts. Split from the
// actual scoring/picking below (buildRecommendationRows' own real
// reason for the split): that part does read and mutate the shared
// exclude object and has to run in a fixed real order across every
// row family, but the fetch that feeds it does not, and used to be
// stuck behind that same ordering for no real reason of its own.
function fetchSeedCandidates(seeds) {
  return Promise.all(
    seeds.map(function (seed) {
      return getRecommendationCandidates(seed, POOL_LIMIT).catch(function (err) {
        console.warn('Jellio: could not load recommendation candidates', err);
        return null;
      });
    }),
  );
}

// Scores and picks one row per seed, in order: pick() reads and then
// adds to the same exclude object, and running it concurrently would
// have every row scoring against the same, still-empty exclusion set.
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

// Genre and person, aggregated across the reader's own whole real
// watch history sample rather than one seed at a time: a broader "you
// generally like X" signal, alongside the per title "because you
// watched" rows above, not a replacement for them.
// A liked title counts double toward its own genres here, a disliked
// one not at all: the same real UserData.Likes signal score() above
// already leans on, applied to the aggregate "Top Picks for You" count
// instead of one seed's own row. Neither changes MIN_GENRE_COUNT's own
// real floor, a liked title just clears it faster.
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

function topPeople(history) {
  const counts = {};
  history.forEach(function (item) {
    (item.People || []).forEach(function (person) {
      if (!person.Id || (person.Type !== 'Actor' && person.Type !== 'Director')) return;
      const entry = counts[person.Id] || (counts[person.Id] = { id: person.Id, name: person.Name, count: 0 });
      entry.count += 1;
    });
  });
  return Object.keys(counts)
    .map(function (id) {
      return counts[id];
    })
    .filter(function (entry) {
      return entry.count >= MIN_PERSON_COUNT;
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });
}

// Real feedback: "Your {genre} picks" read as one more per-attribute
// row sitting right next to the real per title ones ("Because you
// watched X"), nothing telling the two families apart at a glance. The
// signal behind this one specifically is the reader's own whole real
// watch history, not one seed title, "Top Picks for You" is the one
// real title that says so; MAX_GENRE_ROWS staying at 1 is what keeps
// that real title from ever needing a second, differently named row to
// share the page with.
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
    const items = dedupe(raw.filter(notPlayed), exclude);
    if (items.length) rows.push({ title: 'Top Picks for You', items: items });
  }
  return rows;
}

function fetchPersonItemsList(people) {
  return Promise.all(
    people.map(function (person) {
      return getPersonItems(person.id, ROW_SIZE).catch(function (err) {
        console.warn('Jellio: could not load top person row', err);
        return null;
      });
    }),
  );
}

function buildPersonRows(people, itemsPerPerson, exclude) {
  const rows = [];
  for (let i = 0; i < people.length; i++) {
    const raw = itemsPerPerson[i];
    if (!raw) continue;
    const items = dedupe(raw.filter(notPlayed), exclude);
    if (items.length) rows.push({ title: 'More with ' + people[i].name, items: items });
  }
  return rows;
}

// Every personalized row this app builds without a second backend: one
// row per recently completed title ("Because you watched X"), one per
// series still in progress ("Because you're watching X", from NextUp's
// own seed shape), plus the two aggregate rows above. exclude is
// screens/home.js's own shared seen object, carried through and added
// to here in the same real priority order real feedback already
// established: per title rows first (the strongest, most specific
// signal), the two aggregate rows after.
export async function buildRecommendationRows(exclude) {
  const [history, nextUp] = await Promise.all([
    getRecentlyCompleted(HISTORY_SAMPLE_LIMIT).catch(function () {
      return [];
    }),
    getNextUp(NEXTUP_SEED_LIMIT).catch(function () {
      return [];
    }),
  ]);

  // A title the reader explicitly disliked has no business leading its
  // own "because you watched" row at all, real feedback's own signal
  // used to exclude a seed here rather than only ever down-weight one.
  function notDisliked(seed) {
    return !(seed.UserData && seed.UserData.Likes === false);
  }

  const completedSeeds = history.filter(notDisliked).slice(0, SEED_LIMIT);
  const nextUpSeeds = nextUp.filter(notDisliked);
  const genres = topGenres(history).slice(0, MAX_GENRE_ROWS);
  const people = topPeople(history).slice(0, MAX_PERSON_ROWS);

  // Real bug, audit-found: each of these four candidate pools is an
  // independent real network fetch, none of them reading or needing
  // exclude, only the scoring/dedupe below does. Used to fire one
  // whole row family at a time regardless, each one's own fetch
  // waiting on the previous family's fetch and pick both finishing
  // first. Fetched together here instead, the scoring/dedupe phase
  // below still runs strictly in the same real order against the same
  // shared exclude object, same real priority and same real dedupe
  // guarantee as before, just no longer paying for a network wait
  // between every stage.
  const [completedEntries, nextUpEntries, genreItemsList, personItemsList] = await Promise.all([
    fetchSeedCandidates(completedSeeds),
    fetchSeedCandidates(nextUpSeeds),
    fetchGenreItemsList(genres),
    fetchPersonItemsList(people),
  ]);

  const completedRows = pickSeedRows(completedSeeds, completedEntries, function (seed) {
    return 'Because you watched ' + seed.Name;
  }, exclude);

  const nextUpRows = pickSeedRows(nextUpSeeds, nextUpEntries, function (seed) {
    return "Because you're watching " + (seed.SeriesName || seed.Name);
  }, exclude);

  const genreRows = buildGenreRows(genres, genreItemsList, exclude);
  const personRows = buildPersonRows(people, personItemsList, exclude);

  // Real feedback: "Top Picks for You" (genreRows' own aggregate row)
  // should sit right after Studio Hubs, ahead of every per-title
  // "Because you watched/watching X" row, not behind them.
  return genreRows.concat(completedRows, nextUpRows, personRows);
}
