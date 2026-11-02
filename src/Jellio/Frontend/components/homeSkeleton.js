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
