import { getDisplayCulture } from '../i18n.js';
import { getCurrentUserId } from '../auth.js';
import { SEARCH_TIMEOUT_MS, getJson } from './core.js';

export function searchItems(term, limit, signal) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!term) return Promise.resolve([]);
  const culture = getDisplayCulture();
  const params = new URLSearchParams({
    searchTerm: term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio',
    Limit: String(limit || 50),
  });
  if (culture) params.set('Culture', culture);
  return getJson('/Users/' + userId + '/Items?' + params.toString(), SEARCH_TIMEOUT_MS, signal).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function searchLibrary(term, signal) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!term) return Promise.resolve([]);
  const params = new URLSearchParams({
    searchTerm: 'local:' + term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,ProviderIds,ProductionYear',
    Limit: '50',
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString(), SEARCH_TIMEOUT_MS, signal).then(function (result) {
    return (result && result.Items) || [];
  });
}

function searchByType(term, mediaType, signal) {
  if (!term) return Promise.resolve([]);
  const params = new URLSearchParams({ q: term });
  return getJson('/gelato/search/' + mediaType + '?' + params.toString(), SEARCH_TIMEOUT_MS, signal);
}

export function searchMovies(term, signal) {
  return searchByType(term, 'movie', signal);
}

export function searchSeries(term, signal) {
  return searchByType(term, 'series', signal);
}

export function getSearchSuggestions(query) {
  return getJson('/Jellio/search/suggestions?query=' + encodeURIComponent(query)).then(function (result) {
    return result || { MatchedTitle: null, Rows: [] };
  });
}
