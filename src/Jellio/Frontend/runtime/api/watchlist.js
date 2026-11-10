import { getCurrentUserId, getServerAddress, getAuthHeaders } from '../auth.js';
import { SHORT_CACHE_TTL_MS, cached, getJson, invalidateCache, invalidateUserDataRows, postJson, rowJson } from './core.js';

export function getWatchlistItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Filters: 'IsFavorite',
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,CommunityRating',
    Limit: String(limit || 100),
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getGrouplistIds() {
  return cached('grouplist:ids', function () {
    return getJson('/Jellio/grouplist');
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.ItemIds) || [];
  });
}

export function getGrouplistItems() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getGrouplistIds().then(function (ids) {
    if (!ids.length) return [];
    const params = new URLSearchParams({
      Ids: ids.join(','),
      Fields: 'PrimaryImageAspectRatio,CommunityRating',
    });
    return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
      return (result && result.Items) || [];
    });
  });
}

export function addToGrouplist(itemId) {
  return postJson('/Jellio/grouplist/' + itemId).then(function (result) {
    invalidateCache('grouplist:ids');
    return result;
  });
}

export async function removeFromGrouplist(itemId) {
  const response = await fetch(
    getServerAddress() + '/Jellio/grouplist/' + itemId,
    {
      method: 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: Grouplist');
    err.status = response.status;
    throw err;
  }
  invalidateCache('grouplist:ids');
  return response.json();
}

export async function setWatchlist(itemId, isWatchlisted) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const response = await fetch(
    getServerAddress() + '/Users/' + userId + '/FavoriteItems/' + itemId,
    {
      method: isWatchlisted ? 'POST' : 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: FavoriteItems');
    err.status = response.status;
    throw err;
  }
  // Adding a title to the Watchlist brings it back to Upcoming if it was
  // taken out.
  if (isWatchlisted) setUpcomingHidden(itemId, false).catch(function () {});
  invalidateUserDataRows();
  return response.json();
}

export function getCalendarEntries() {
  return rowJson('/Jellio/calendar', 'watchlist', { timeout: 25000 });
}

// Remove from Upcoming (or put back): a series watched once is otherwise
// followed for years.
export async function setUpcomingHidden(itemId, hidden) {
  const response = await fetch(getServerAddress() + '/Jellio/calendar/hidden/' + encodeURIComponent(itemId), {
    method: hidden ? 'POST' : 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed: calendar/hidden');
  invalidateUserDataRows();
}
