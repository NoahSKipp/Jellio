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
