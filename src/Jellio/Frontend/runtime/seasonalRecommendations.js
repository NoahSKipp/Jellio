import { getJellioConfig, getSeasonalItems } from './api.js';
import { activeSeasonalTheme } from '../components/seasons.js';
import { dedupe } from './recommend.js';
import { t } from './i18n.js';

const ROW_SIZE = 24;

const SEASONS_SPEC = {
  halloween: {
    titleKey: 'seasonal_halloween',
    title: 'Spooky Season',
    genres: ['Horror', 'Mystery'],
    searchTerms: ['Halloween', 'Spooky', 'Ghost', 'Haunted', 'Witch', 'Vampire', 'Zombie'],
  },
  christmas: {
    titleKey: 'seasonal_christmas',
    title: 'Holiday Favorites',
    genres: ['Holiday', 'Christmas', 'Family'],
    searchTerms: ['Christmas', 'Holiday', 'Santa', 'Noel', 'Xmas'],
  },
  newyear: {
    titleKey: 'seasonal_newyear',
    title: 'New Year Celebrations',
    genres: ['Comedy', 'Music', 'Musical'],
    searchTerms: ['New Year', 'Countdown', 'Celebration', 'Party'],
  },
  valentine: {
    titleKey: 'seasonal_valentine',
    title: 'Romance & Date Night',
    genres: ['Romance'],
    searchTerms: ['Valentine', 'Love', 'Romance', 'Romantic'],
  },
};

function notPlayed(item) {
  return !(item.UserData && item.UserData.Played);
}

export async function getSeasonalRecommendationRow(exclude) {
  try {
    const config = await getJellioConfig();
    const activeTheme = activeSeasonalTheme(new Date(), config);
    if (!activeTheme) return null;

    const spec = SEASONS_SPEC[activeTheme];
    if (!spec) return null;

    const rawItems = await getSeasonalItems(spec.genres, spec.searchTerms, 60);
    if (!rawItems || !rawItems.length) return null;

    const eligible = dedupe(rawItems.filter(notPlayed), exclude);
    if (!eligible.length) return null;

    return {
      title: t(spec.titleKey, null, spec.title),
      items: eligible.slice(0, ROW_SIZE),
    };
  } catch (err) {
    console.warn('Jellio: could not load seasonal recommendations', err);
    return null;
  }
}
