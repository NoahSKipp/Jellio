// Rich TMDB + Jellyfin person profile logic shared by screens/person.js and tests.

export const TMDB_API_KEY = '4219e299c89411838049ab0dab19ebd5';
export const TMDB_API_BASE = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

const DEPARTMENT_PRIORITY = {
  Acting: 0,
  Directing: 1,
  Writing: 2,
};

export function normalizeTitleForMatching(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function calculateAge(birthday, deathday, nowDate) {
  if (!birthday || typeof birthday !== 'string') return null;
  const birthParts = birthday.trim().split('-').map(Number);
  if (birthParts.length < 3 || birthParts.slice(0, 3).some(function (n) { return !Number.isFinite(n); })) {
    return null;
  }
  const birthYear = birthParts[0];
  const birthMonth = birthParts[1];
  const birthDay = birthParts[2];

  let endYear;
  let endMonth;
  let endDay;
  if (deathday && typeof deathday === 'string' && deathday.trim()) {
    const deathParts = deathday.trim().split('-').map(Number);
    if (deathParts.length >= 3 && !deathParts.slice(0, 3).some(function (n) { return !Number.isFinite(n); })) {
      endYear = deathParts[0];
      endMonth = deathParts[1];
      endDay = deathParts[2];
    }
  }
  if (endYear == null) {
    const now = nowDate instanceof Date ? nowDate : new Date();
    endYear = now.getUTCFullYear();
    endMonth = now.getUTCMonth() + 1;
    endDay = now.getUTCDate();
  }

  let age = endYear - birthYear;
  if (endMonth < birthMonth || (endMonth === birthMonth && endDay < birthDay)) {
    age -= 1;
  }
  return age >= 0 && age <= 130 ? age : null;
}

// Parses basic markdown (**bold**, __bold__, *italic*, _italic_, [label](url))
// into safe plain text/bold/italic segments without raw HTML interpolation.
export function parseMarkdownBio(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const cleanLinks = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const segments = [];
  const tokenRegex = /(\*\*|__)(.+?)\1|(\*)([^*]+?)\3|(?:(?<=^)|(?<=[\s(\["']))_([^_\s][^_]*?)_(?=$|[\s.,;:!?)\]"'])/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(cleanLinks)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: cleanLinks.slice(lastIndex, match.index) });
    }
    if (match[2] != null) {
      segments.push({ type: 'bold', text: match[2] });
    } else if (match[4] != null) {
      segments.push({ type: 'italic', text: match[4] });
    } else if (match[5] != null) {
      segments.push({ type: 'italic', text: match[5] });
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < cleanLinks.length) {
    segments.push({ type: 'text', text: cleanLinks.slice(lastIndex) });
  }
  return segments;
}

function mapCrewDepartment(rawDepartment) {
  const lower = String(rawDepartment || '').toLowerCase();
  if (lower === 'directing') return 'Directing';
  if (lower === 'writing') return 'Writing';
  if (lower === 'production') return 'Production';
  return 'Other';
}

function yearFromDate(releaseDate) {
  if (!releaseDate || typeof releaseDate !== 'string') return null;
  const year = Number(releaseDate.split('-')[0]);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function indexLocalItems(localFilmography) {
  const byTmdb = new Map();
  const byTitleAndYear = new Map();
  (Array.isArray(localFilmography) ? localFilmography : []).forEach(function (item) {
    if (!item || (item.Type !== 'Movie' && item.Type !== 'Series')) return;
    const tmdbId = item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.tmdb);
    if (tmdbId) {
      const key = String(tmdbId).trim();
      if (key && !byTmdb.has(key)) byTmdb.set(key, item);
    }
    const normTitle = normalizeTitleForMatching(item.Name);
    if (normTitle) {
      const year = item.ProductionYear || 0;
      const key = normTitle + ':' + year;
      if (!byTitleAndYear.has(key)) byTitleAndYear.set(key, item);
    }
  });
  return { byTmdb, byTitleAndYear };
}

function findLocalMatch(index, tmdbId, title, year) {
  if (tmdbId != null && index.byTmdb.has(String(tmdbId))) {
    return index.byTmdb.get(String(tmdbId));
  }
  if (year != null) {
    const key = normalizeTitleForMatching(title) + ':' + year;
    if (index.byTitleAndYear.has(key)) return index.byTitleAndYear.get(key);
  }
  return null;
}

function sortCreditsNewestFirst(a, b) {
  const keyA = a.releaseDate || String(a.year || 0);
  const keyB = b.releaseDate || String(b.year || 0);
  if (keyA === keyB) return (b.popularity || 0) - (a.popularity || 0);
  return keyB.localeCompare(keyA);
}

function buildDepartmentTabs(dedupedCredits, uniqueCount, labels) {
  const getLabel = function (key, fallback) {
    return (labels && labels[key]) || fallback;
  };
  const counts = {
    Acting: 0,
    Directing: 0,
    Writing: 0,
    Production: 0,
    Other: 0,
  };
  dedupedCredits.forEach(function (credit) {
    if (Object.prototype.hasOwnProperty.call(counts, credit.department)) {
      counts[credit.department] += 1;
    } else {
      counts.Other += 1;
    }
  });

  const tabs = [
    { key: 'All', label: getLabel('all', 'All'), count: uniqueCount },
  ];
  const deptDefs = [
    { key: 'Acting', labelKey: 'acting', fallback: 'Acting' },
    { key: 'Directing', labelKey: 'directing', fallback: 'Directing' },
    { key: 'Writing', labelKey: 'writing', fallback: 'Writing' },
    { key: 'Production', labelKey: 'production', fallback: 'Production' },
    { key: 'Other', labelKey: 'other', fallback: 'Other' },
  ];
  deptDefs.forEach(function (dept) {
    if (counts[dept.key] > 0) {
      tabs.push({
        key: dept.key,
        label: getLabel(dept.labelKey, dept.fallback),
        count: counts[dept.key],
      });
    }
  });
  return tabs;
}

export function extractIsoDate(rawDate) {
  if (!rawDate || typeof rawDate !== 'string') return null;
  const match = rawDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1800 || year >= 9000) return null;
  return match[1] + '-' + match[2] + '-' + match[3];
}

export function generateDeterministicVirtualId(type, tmdbId) {
  const input = 'jellio-virtual:' + String(type || 'movie').toLowerCase() + ':' + String(tmdbId || 0);
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const hex3 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
  const hex4 = ((Math.imul(h1, 31) ^ h2) >>> 0).toString(16).padStart(8, '0');
  const full = (hex1 + hex2 + hex3 + hex4).slice(0, 32);
  return (
    full.slice(0, 8) + '-' +
    full.slice(8, 12) + '-3' +
    full.slice(13, 16) + '-8' +
    full.slice(17, 20) + '-' +
    full.slice(20, 32)
  );
}

const richPersonDetailsCache = new Map();

export function getCachedRichPersonDetails(personId, lang) {
  if (!personId) return null;
  const key = String(personId) + ':' + String(lang || 'en');
  return richPersonDetailsCache.get(key) || null;
}

export function setCachedRichPersonDetails(personId, details, lang) {
  if (!personId || !details) return;
  const key = String(personId) + ':' + String(lang || 'en');
  richPersonDetailsCache.set(key, details);
}

export function clearCachedRichPersonDetails() {
  richPersonDetailsCache.clear();
}

export function buildRichPersonDetails(personId, person, tmdb, localFilmography, labels, nowDate) {
  const safePerson = person || {};
  const localIndex = indexLocalItems(localFilmography);
  const rawCredits = [];

  const combined = (tmdb && tmdb.combined_credits) || {};
  const castList = Array.isArray(combined.cast) ? combined.cast : [];
  castList.forEach(function (cast) {
    if (!cast) return;
    const title = cast.title || cast.name;
    if (!title || cast.id == null) return;
    const mediaType = cast.media_type === 'tv' ? 'Series' : 'Movie';
    const releaseDate = cast.release_date || cast.first_air_date || null;
    const year = yearFromDate(releaseDate);
    const localItem = findLocalMatch(localIndex, cast.id, title, year);
    const id = localItem ? localItem.Id : generateDeterministicVirtualId(cast.media_type === 'tv' ? 'tv' : 'movie', cast.id);

    rawCredits.push({
      id: id,
      tmdbId: cast.id,
      title: title,
      mediaType: mediaType,
      year: year,
      releaseDate: releaseDate,
      role: cast.character && cast.character.trim() ? cast.character.trim() : null,
      department: 'Acting',
      overview: cast.overview || null,
      posterUrl: cast.poster_path ? TMDB_IMAGE_BASE + '/w500' + cast.poster_path : null,
      backdropUrl: cast.backdrop_path ? TMDB_IMAGE_BASE + '/w1280' + cast.backdrop_path : null,
      rating: typeof cast.vote_average === 'number' ? cast.vote_average : null,
      popularity: typeof cast.popularity === 'number' ? cast.popularity : 0,
      voteCount: typeof cast.vote_count === 'number' ? cast.vote_count : 0,
      localItem: localItem,
    });
  });

  const crewList = Array.isArray(combined.crew) ? combined.crew : [];
  crewList.forEach(function (crew) {
    if (!crew) return;
    const title = crew.title || crew.name;
    if (!title || crew.id == null) return;
    const mediaType = crew.media_type === 'tv' ? 'Series' : 'Movie';
    const releaseDate = crew.release_date || crew.first_air_date || null;
    const year = yearFromDate(releaseDate);
    const department = mapCrewDepartment(crew.department);
    const localItem = findLocalMatch(localIndex, crew.id, title, year);
    const id = localItem ? localItem.Id : generateDeterministicVirtualId(crew.media_type === 'tv' ? 'tv' : 'movie', crew.id);

    rawCredits.push({
      id: id,
      tmdbId: crew.id,
      title: title,
      mediaType: mediaType,
      year: year,
      releaseDate: releaseDate,
      role: crew.job || crew.department || null,
      department: department,
      overview: crew.overview || null,
      posterUrl: crew.poster_path ? TMDB_IMAGE_BASE + '/w500' + crew.poster_path : null,
      backdropUrl: crew.backdrop_path ? TMDB_IMAGE_BASE + '/w1280' + crew.backdrop_path : null,
      rating: typeof crew.vote_average === 'number' ? crew.vote_average : null,
      popularity: typeof crew.popularity === 'number' ? crew.popularity : 0,
      voteCount: typeof crew.vote_count === 'number' ? crew.vote_count : 0,
      localItem: localItem,
    });
  });

  // Deduplicate within each (tmdbId, department), keeping highest popularity.
  const byTmdbAndDept = new Map();
  rawCredits.forEach(function (credit) {
    const key = credit.tmdbId + ':' + credit.department;
    const existing = byTmdbAndDept.get(key);
    if (!existing || credit.popularity > existing.popularity) {
      byTmdbAndDept.set(key, credit);
    }
  });
  const dedupedCredits = Array.from(byTmdbAndDept.values()).sort(sortCreditsNewestFirst);

  // Known For: distinct by tmdbId, weighted by voteCount * rating + popularity * 2, top 10.
  const uniqueByTmdb = new Map();
  dedupedCredits.forEach(function (credit) {
    const existing = uniqueByTmdb.get(credit.tmdbId);
    if (!existing) {
      uniqueByTmdb.set(credit.tmdbId, credit);
      return;
    }
    const existingPrio = DEPARTMENT_PRIORITY[existing.department] != null ? DEPARTMENT_PRIORITY[existing.department] : 99;
    const nextPrio = DEPARTMENT_PRIORITY[credit.department] != null ? DEPARTMENT_PRIORITY[credit.department] : 99;
    if (nextPrio < existingPrio) {
      uniqueByTmdb.set(credit.tmdbId, credit);
    }
  });

  const knownFor = Array.from(uniqueByTmdb.values())
    .sort(function (a, b) {
      const scoreA = (a.voteCount * (a.rating || 0)) + (a.popularity * 2);
      const scoreB = (b.voteCount * (b.rating || 0)) + (b.popularity * 2);
      return scoreB - scoreA;
    })
    .slice(0, 10);

  const backdropHit = knownFor.find(function (c) { return !!c.backdropUrl; })
    || dedupedCredits.find(function (c) { return !!c.backdropUrl; });

  const personName = (tmdb && tmdb.name && tmdb.name.trim()) ? tmdb.name : (safePerson.Name || '');
  const biography = (tmdb && tmdb.biography && tmdb.biography.trim()) ? tmdb.biography : (safePerson.Overview || null);
  const birthday = (tmdb && tmdb.birthday) || extractIsoDate(safePerson.PremiereDate) || null;
  const deathday = (tmdb && tmdb.deathday) || extractIsoDate(safePerson.EndDate) || null;
  const placeOfBirth = (tmdb && tmdb.place_of_birth)
    || (Array.isArray(safePerson.ProductionLocations) && safePerson.ProductionLocations[0])
    || null;
  const age = calculateAge(birthday, deathday, nowDate);
  const profileUrl = (tmdb && tmdb.profile_path) ? (TMDB_IMAGE_BASE + '/h632' + tmdb.profile_path) : null;
  const imdbId = (tmdb && tmdb.external_ids && tmdb.external_ids.imdb_id)
    || (safePerson.ProviderIds && (safePerson.ProviderIds.Imdb || safePerson.ProviderIds.imdb))
    || null;
  const rawTmdbId = (tmdb && tmdb.id) || (safePerson.ProviderIds && Number(safePerson.ProviderIds.Tmdb || safePerson.ProviderIds.tmdb));
  const tmdbId = Number.isFinite(rawTmdbId) && rawTmdbId > 0 ? rawTmdbId : null;
  const uniqueCount = uniqueByTmdb.size;

  return {
    id: personId,
    name: personName,
    biography: biography,
    birthday: birthday,
    deathday: deathday,
    placeOfBirth: placeOfBirth,
    age: age,
    knownForDepartment: (tmdb && tmdb.known_for_department) || 'Acting',
    profileUrl: profileUrl,
    backdropUrl: backdropHit ? backdropHit.backdropUrl : null,
    imdbId: imdbId,
    tmdbId: tmdbId,
    totalCreditsCount: uniqueCount,
    knownFor: knownFor,
    allCredits: dedupedCredits,
    departmentTabs: buildDepartmentTabs(dedupedCredits, uniqueCount, labels),
  };
}

export function buildFallbackPersonDetails(personId, person, localFilmography, labels, nowDate) {
  const safePerson = person || {};
  const films = (Array.isArray(localFilmography) ? localFilmography : [])
    .filter(function (item) {
      return item && (item.Type === 'Movie' || item.Type === 'Series');
    });
  const credits = films.map(function (item) {
    const rawTmdb = item.ProviderIds && Number(item.ProviderIds.Tmdb || item.ProviderIds.tmdb);
    return {
      id: item.Id,
      tmdbId: Number.isFinite(rawTmdb) ? rawTmdb : 0,
      title: item.Name || '',
      mediaType: item.Type || 'Movie',
      year: item.ProductionYear || null,
      releaseDate: item.PremiereDate || null,
      role: item.Type || null,
      department: 'Acting',
      overview: item.Overview || null,
      posterUrl: null,
      backdropUrl: null,
      rating: typeof item.CommunityRating === 'number' ? item.CommunityRating : null,
      popularity: 0,
      voteCount: 0,
      localItem: item,
    };
  });
  const tabs = [
    { key: 'All', label: (labels && labels.all) || 'All', count: credits.length },
  ];
  if (credits.length > 0) {
    tabs.push({ key: 'Acting', label: (labels && labels.acting) || 'Acting', count: credits.length });
  }
  const birthday = extractIsoDate(safePerson.PremiereDate);
  const deathday = extractIsoDate(safePerson.EndDate);
  const placeOfBirth = (Array.isArray(safePerson.ProductionLocations) && safePerson.ProductionLocations[0]) || null;
  const rawTmdbId = safePerson.ProviderIds && Number(safePerson.ProviderIds.Tmdb || safePerson.ProviderIds.tmdb);
  return {
    id: personId,
    name: safePerson.Name || '',
    biography: safePerson.Overview || null,
    birthday: birthday,
    deathday: deathday,
    placeOfBirth: placeOfBirth,
    age: calculateAge(birthday, deathday, nowDate),
    knownForDepartment: 'Acting',
    profileUrl: null,
    backdropUrl: null,
    imdbId: (safePerson.ProviderIds && (safePerson.ProviderIds.Imdb || safePerson.ProviderIds.imdb)) || null,
    tmdbId: Number.isFinite(rawTmdbId) && rawTmdbId > 0 ? rawTmdbId : null,
    totalCreditsCount: credits.length,
    knownFor: credits.slice(0, 10),
    allCredits: credits,
    departmentTabs: tabs,
  };
}

export function filterCreditsForDepartment(departmentKey, allCredits) {
  const list = Array.isArray(allCredits) ? allCredits : [];
  if (String(departmentKey || 'All').toLowerCase() === 'all') {
    const grouped = new Map();
    list.forEach(function (credit) {
      const key = credit.tmdbId ? String(credit.tmdbId) : String(credit.id);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(credit);
    });
    const merged = [];
    grouped.forEach(function (group) {
      const pick =
        group.find(function (c) { return c.department === 'Acting'; }) ||
        group.find(function (c) { return c.department === 'Directing'; }) ||
        group.find(function (c) { return c.department === 'Writing'; }) ||
        group.reduce(function (best, candidate) {
          return (candidate.popularity || 0) > (best.popularity || 0) ? candidate : best;
        }, group[0]);
      merged.push(pick);
    });
    return merged.sort(sortCreditsNewestFirst);
  }

  const targetDept = String(departmentKey || '').toLowerCase();
  const seen = new Set();
  return list
    .filter(function (credit) {
      if (String(credit.department || '').toLowerCase() !== targetDept) return false;
      const key = (credit.tmdbId ? String(credit.tmdbId) : String(credit.id)) + ':' + (credit.role || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(sortCreditsNewestFirst);
}

export function formatCreditSubtitle(credit) {
  if (!credit) return '';
  const yearStr = credit.year != null ? String(credit.year) : null;
  const roleStr = credit.role && String(credit.role).trim() ? String(credit.role).trim() : null;
  if (credit.department === 'Acting' && roleStr && yearStr) {
    return yearStr + ' (as ' + roleStr + ')';
  }
  if (roleStr && yearStr) {
    return yearStr + ' (' + roleStr + ')';
  }
  if (yearStr) return yearStr;
  if (roleStr) return roleStr;
  return credit.mediaType || '';
}

export async function searchTmdbPersonId(name, fetchFn) {
  const fetcher = fetchFn || globalThis.fetch;
  if (!name || typeof fetcher !== 'function') return null;
  try {
    const url = TMDB_API_BASE + '/search/person?api_key=' + TMDB_API_KEY + '&query=' + encodeURIComponent(name);
    const res = await fetcher(url);
    if (!res || !res.ok) return null;
    const data = await res.json();
    const first = data && Array.isArray(data.results) ? data.results[0] : null;
    return first && typeof first.id === 'number' ? first.id : null;
  } catch (err) {
    return null;
  }
}

export async function fetchTmdbPersonDetails(tmdbId, fetchFn) {
  const fetcher = fetchFn || globalThis.fetch;
  if (!tmdbId || typeof fetcher !== 'function') return null;
  try {
    const url = TMDB_API_BASE + '/person/' + encodeURIComponent(String(tmdbId)) +
      '?api_key=' + TMDB_API_KEY + '&append_to_response=combined_credits,external_ids';
    const res = await fetcher(url);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

export async function resolveCreditTarget(credit, apis) {
  if (!credit) return null;
  if (credit.localItem && credit.localItem.Id) {
    return {
      hash: '#/item?id=' + encodeURIComponent(credit.localItem.Id),
      item: credit.localItem,
    };
  }
  const title = credit.title || '';
  const searchFn = credit.mediaType === 'Series' ? apis && apis.searchSeries : apis && apis.searchMovies;
  if (typeof searchFn === 'function' && title) {
    try {
      const results = await searchFn(title);
      if (Array.isArray(results) && results.length) {
        const targetTmdb = credit.tmdbId ? String(credit.tmdbId) : null;
        const normTitle = normalizeTitleForMatching(title);
        const match =
          (targetTmdb && results.find(function (r) {
            return r && r.ProviderIds && String(r.ProviderIds.Tmdb || '') === targetTmdb;
          })) ||
          results.find(function (r) {
            if (!r || normalizeTitleForMatching(r.Name) !== normTitle) return false;
            if (!credit.year || !r.ProductionYear) return true;
            return Math.abs(Number(r.ProductionYear) - Number(credit.year)) <= 1;
          }) ||
          results.find(function (r) {
            return r && normalizeTitleForMatching(r.Name) === normTitle;
          });
        if (match && match.Id) {
          return {
            hash: '#/item?id=' + encodeURIComponent(match.Id),
            item: match,
          };
        }
      }
    } catch (err) {
      // Fall back to search route below.
    }
  }
  return {
    hash: '#/search?q=' + encodeURIComponent(title),
    item: null,
  };
}
