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
import { getRecentlyCompleted, getRecommendationCandidates } from './api.js';

const SEED_LIMIT = 4;
const POOL_LIMIT = 100;
const ROW_SIZE = 20;

const WEIGHT = {
  genre: 3,
  person: 1.2,
  era: 0.4,
  rating: 0.3,
};

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

  let total = WEIGHT.genre * overlap;
  if (entry.viaPerson) total += WEIGHT.person;

  if (seed.ProductionYear && item.ProductionYear) {
    const gap = Math.abs(seed.ProductionYear - item.ProductionYear);
    total += WEIGHT.era * (1 - Math.min(1, gap / 20));
  }

  if (item.CommunityRating) {
    total += WEIGHT.rating * (item.CommunityRating / 10);
  }

  return total;
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

// One row per completed title, newest first, fewer than asked for
// when the reader has finished fewer, none at all on a server with no
// watch history: a row named after something nobody watched is worse
// than no row. Rows are resolved and picked one at a time, in order,
// rather than in parallel: each row's own pick() reads and then adds
// to the same exclude object, and running them together would have
// every row scoring against the same, still-empty exclusion set.
export async function buildRecommendationRows(exclude) {
  const seeds = await getRecentlyCompleted(SEED_LIMIT).catch(function () {
    return [];
  });

  const rows = [];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    let entries = [];
    try {
      entries = await getRecommendationCandidates(seed, POOL_LIMIT);
    } catch (err) {
      console.warn('Jellio: could not load recommendation candidates', err);
      continue;
    }
    const items = pick(seed, entries, exclude, ROW_SIZE);
    if (!items.length) continue;
    items.forEach(function (item) {
      markSeen(exclude, item);
    });
    rows.push({ title: 'Because you watched ' + seed.Name, items: items });
  }
  return rows;
}
