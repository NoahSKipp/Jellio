import { jellioVersion } from '../runtime/util.js';

function tmdbBadgeUrl() {
  const version = jellioVersion();
  return '/Jellio/frontend/img/ratings/tmdb.svg' + (version ? '?v=' + version : '');
}

export function buildRatingBadge(rating, extraClassName) {
  const badge = document.createElement('span');
  badge.className = extraClassName ? 'jellio-rating-badge ' + extraClassName : 'jellio-rating-badge';
  const icon = document.createElement('img');
  icon.className = 'jellio-rating-badge-icon';
  icon.src = tmdbBadgeUrl();
  icon.alt = 'TMDB';
  icon.loading = 'lazy';
  badge.appendChild(icon);
  badge.appendChild(document.createTextNode(rating.toFixed(1)));
  return badge;
}
