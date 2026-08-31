// Service name matching, grouping and logo slugs, ported from the
// original Jellio codebase's own streamingHub.js: a service only shows
// up when its real catalog collections exist, matched on the
// collection's own name since Gelato writes no field an item could
// carry instead. Pure logic, no DOM, shared by the home tile strip and
// the service screen.

export const SERVICES = [
  'Netflix',
  'HBO Max',
  'Max',
  'Disney+',
  'Prime Video',
  'Apple TV+',
  'Hulu',
  'Paramount+',
  'Peacock',
  'Crunchyroll',
  'AMC+',
  'Starz',
  'Shudder',
  'Discovery+',
  'Sky Go',
];

// Longest first, so "HBO Max" is not claimed by "Max".
export function serviceOf(name) {
  const ordered = SERVICES.slice().sort(function (a, b) {
    return b.length - a.length;
  });
  const lower = String(name || '').toLowerCase();
  for (let i = 0; i < ordered.length; i++) {
    if (lower.indexOf(ordered[i].toLowerCase()) === 0) return ordered[i];
  }
  return null;
}

export function logoSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// screens/settings.js's own real jellioVersion(): app.js's own script
// tag is the one place this plugin's own real running version already
// lives on the page (IndexHtmlPatchService stamps a ?v= query string
// onto it every release), read back here rather than a second endpoint.
function jellioVersion() {
  const script = document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (!script) return '';
  try {
    return new URL(script.src, window.location.origin).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
}

// Real bug, found live: FrontendController.cs used to serve these SVGs
// with a full year of immutable caching and no version suffix on the
// URL at all, on the premise that a logo is the same bytes every
// release. That premise turned out false (this exact file's own real
// content changed twice in one session), and a reader whose browser
// had already cached the old one kept it regardless of how many times
// the server side fix shipped, since Cache-Control alone cannot
// retroactively un-poison an already cached response. The server side
// policy is fixed now too, but a real version query string here closes
// the gap outright: a new real release is a new real URL, no cache of
// any kind (browser, proxy, CDN) can ever hand back stale bytes for a
// URL it has never seen before.
export function logoUrl(name) {
  const version = jellioVersion();
  return '/Jellio/frontend/img/services/' + logoSlug(name) + '.svg' + (version ? '?v=' + version : '');
}

export function groupByService(items) {
  const groups = {};
  items.forEach(function (item) {
    const service = serviceOf(item.Name);
    if (!service) return;
    if (!groups[service]) groups[service] = [];
    groups[service].push(item);
  });
  return groups;
}

// A row's own name. The bare service catalogs are called just "Netflix"
// twice over, which says nothing on a page already titled Netflix, so
// those two get named for what they hold. Anything else already carries
// a real name ("Netflix Top 10 Movies (Global)") and keeps it.
export function rowTitle(collection, service, kind) {
  if (String(collection.Name).toLowerCase() !== service.toLowerCase()) {
    return collection.Name;
  }
  if (kind === 'tvshows') return 'Series on ' + service;
  if (kind === 'movies') return 'Movies on ' + service;
  return collection.Name;
}
