import { jellioVersion } from '../runtime/util.js';

const SERVICES = [
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

function logoSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function logoUrl(name) {
  const version = jellioVersion();
  return '/Jellio/frontend/img/services/' + logoSlug(name) + '.svg' + (version ? '?v=' + version : '');
}

// Each service's brand colour, for the wash behind its hub header.
// Kept in step with Jellio TV's Services.kt.
const SERVICE_COLORS = {
  Netflix: '229 9 20',
  'HBO Max': '88 34 180',
  Max: '0 43 231',
  'Disney+': '17 60 207',
  'Prime Video': '0 168 225',
  'Apple TV+': '142 142 147',
  Hulu: '28 231 131',
  'Paramount+': '0 100 255',
  Peacock: '255 184 0',
  Crunchyroll: '244 117 33',
  'AMC+': '245 196 0',
  Starz: '110 110 115',
  Shudder: '200 16 46',
  'Discovery+': '33 117 217',
  'Sky Go': '0 114 201',
};

// "r g b" for rgb(... / alpha) in CSS, or null for an unknown service.
export function serviceColor(name) {
  return SERVICE_COLORS[name] || null;
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

export function rowTitle(collection, service, kind) {
  if (String(collection.Name).toLowerCase() !== service.toLowerCase()) {
    return collection.Name;
  }
  if (kind === 'tvshows') return 'Series on ' + service;
  if (kind === 'movies') return 'Movies on ' + service;
  return collection.Name;
}
