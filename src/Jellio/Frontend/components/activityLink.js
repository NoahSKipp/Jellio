// What an activity entry (Feed, profile Recent activity) opens: the show
// rather than the season or episode, the manga series rather than the
// chapter, else the item itself. Returns false when there's nothing to
// open (a badge, or an entry without an item).
import { navigateTo } from '../runtime/router.js';
import { getMangaShelfHash } from './navShared.js';
import { mangaSeriesKey } from './mangaSeries.js';

export function canOpenActivity(entry) {
  return !!(entry && entry.Kind !== 'Badge' && entry.ItemId);
}

export async function openActivity(entry) {
  if (!canOpenActivity(entry)) return false;
  if (entry.ItemType === 'Manga' && entry.SeriesName) {
    const shelf = await getMangaShelfHash();
    if (!shelf) return false;
    navigateTo(shelf + '&series=' + encodeURIComponent(mangaSeriesKey(entry.SeriesName)));
    return true;
  }
  if (entry.ItemType === 'Episode' && entry.SeriesId) {
    navigateTo('#/item?id=' + entry.SeriesId);
    return true;
  }
  navigateTo('#/item?id=' + entry.ItemId);
  return true;
}
