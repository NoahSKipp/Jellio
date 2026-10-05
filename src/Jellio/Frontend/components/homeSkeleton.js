// Nuvio's own real HomeSkeletonHero/HomeSkeletonRow (features/home/
// components/HomeSkeletonLoading.kt, confirmed against its real source
// before writing this): a 1200ms diagonal shimmer sweep over
// placeholder blocks shaped like the real thing underneath (a title
// bar, a row of poster-ratio cards), not a single generic spinner
// sitting alone on an otherwise blank page. Shown the instant
// screens/home.js's own renderHome() starts building its real rows,
// removed the moment the first real row actually arrives through that
// screen's own progressive render path (preloadHomeSectionsWithProgress()),
// same reasoning components/networkState.js's own renderLoading()
// documents for every other screen, sized for this one instead of the
// generic single-spinner shape those use.
import { el } from '../runtime/dom.js';

const SKELETON_ROW_CARDS = 6;
const SKELETON_ROW_COUNT = 4;

export function buildSkeletonRow(cardsCount) {
  const row = el('div', 'jellio-home-skeleton-row');
  row.appendChild(el('div', 'jellio-home-skeleton-row-title jellio-shimmer'));
  const track = el('div', 'jellio-home-skeleton-row-track');
  const count = typeof cardsCount === 'number' ? cardsCount : SKELETON_ROW_CARDS;
  for (let i = 0; i < count; i++) {
    track.appendChild(el('div', 'jellio-home-skeleton-card jellio-shimmer'));
  }
  row.appendChild(track);
  return row;
}

export function buildHomeSkeleton(rowCount, cardsCount) {
  const wrap = el('div', 'jellio-home-skeleton');
  const count = typeof rowCount === 'number' ? rowCount : SKELETON_ROW_COUNT;
  for (let i = 0; i < count; i++) {
    wrap.appendChild(buildSkeletonRow(cardsCount));
  }
  return wrap;
}
