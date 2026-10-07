import { getJellioConfig, getCurrentUserId, getJson } from './api.js';
import { activeSeasonalTheme } from '../components/seasons.js';
import { dedupe } from './recommend.js';

const ROW_SIZE = 24;

const SEASONS_SPEC = {
  halloween: {
    title: 'Spooky Season',
    genres: ['Horror', 'Mystery'],
    searchTerms: ['Halloween', 'Spooky', 'Ghost', 'Haunted', 'Witch', 'Vampire', 'Zombie'],
  },
  christmas: {
    title: 'Holiday Favorites',
    genres: ['Holiday', 'Christmas', 'Family'],
    searchTerms: ['Christmas', 'Holiday', 'Santa', 'Noel', 'Xmas'],
  },
  newyear: {
    title: 'New Year Celebrations',
    genres: ['Comedy', 'Music', 'Musical'],
    searchTerms: ['New Year', 'Countdown', 'Celebration', 'Party'],
  },
  valentine: {
    title: 'Romance & Date Night',
    genres: ['Romance'],
    searchTerms: ['Valentine', 'Love', 'Romance', 'Romantic'],
  },
};

function notPlayed(item) {
  return !(item.UserData && item.UserData.Played);
}

export async function getSeasonalRecommendationRow(exclude) {
  const userId = getCurrentUserId();
  if (!userId) return null;

  try {
    const config = await getJellioConfig();
    const activeTheme = activeSeasonalTheme(new Date(), config);
    if (!activeTheme) return null;

    const spec = SEASONS_SPEC[activeTheme];
    if (!spec) return null;

    const base =
      '/Users/' +
      userId +
      '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=60&Fields=Genres,ProductionYear,CommunityRating&SortBy=CommunityRating&SortOrder=Descending';

    const jobs = [];

    // Query 1: by genres
    if (spec.genres && spec.genres.length) {
      jobs.push(
        getJson(base + '&Genres=' + encodeURIComponent(spec.genres.join('|')))
          .then(function (result) {
            return (result && result.Items) || [];
          })
          .catch(function () {
            return [];
          }),
      );
    }

    // Query 2: search term queries for holiday-specific titles
    if (spec.searchTerms && spec.searchTerms.length) {
      const termsToSearch = spec.searchTerms.slice(0, 2);
      termsToSearch.forEach(function (term) {
        jobs.push(
          getJson('/Users/' + userId + '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=25&searchTerm=' + encodeURIComponent(term))
            .then(function (result) {
              return (result && result.Items) || [];
            })
            .catch(function () {
              return [];
            }),
        );
      });
    }

    const results = await Promise.all(jobs);
    const combined = [];
    const itemIds = new Set();

    results.forEach(function (list) {
      list.forEach(function (item) {
        if (!itemIds.has(item.Id)) {
          itemIds.add(item.Id);
          combined.push(item);
        }
      });
    });

    if (!combined.length) return null;

    // Filter unplayed and dedupe against exclude
    const eligible = dedupe(combined.filter(notPlayed), exclude);
    if (!eligible.length) return null;

    const selected = eligible.slice(0, ROW_SIZE);
    return {
      title: spec.title,
      items: selected,
    };
  } catch (err) {
    console.warn('Jellio: could not load seasonal recommendations', err);
    return null;
  }
}
