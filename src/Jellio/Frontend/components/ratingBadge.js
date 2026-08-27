// TMDB's own real mark (img/ratings/tmdb.svg's own header explains where
// it came from and why there is only one), shown next to every real
// CommunityRating this runtime displays: real feedback was that a bare
// star and a number said nothing about which service that rating was
// actually from. Every CommunityRating this runtime ever renders comes
// from the same real source, Gelato's own TMDB backed catalog import,
// so this one fixed badge covers every one of them, no per-item source
// field to read first.

// Mirrors components/services.js's own jellioVersion(), not imported
// from it: that file's own header scopes it to the streaming hub, this
// one is a different real concern (attributing a rating's own source),
// and that same real helper already has a second copy of its own in
// screens/settings.js for the same reason.
function jellioVersion() {
  const script = document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (!script) return '';
  try {
    return new URL(script.src, window.location.origin).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
}

export function tmdbBadgeUrl() {
  const version = jellioVersion();
  return '/Jellio/frontend/img/ratings/tmdb.svg' + (version ? '?v=' + version : '');
}

// extraClassName carries whatever positioning/background a call site's
// own context already needs (screens/player.js's own absolute
// positioned episode thumb chip, chief among them); the icon plus
// number layout itself is the same everywhere.
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
