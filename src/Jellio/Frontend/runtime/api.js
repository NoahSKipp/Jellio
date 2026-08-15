// Every server call Jellio's own screens need, built directly on fetch and
// auth.js's own headers. Nothing here touches window.ApiClient: the whole
// point of this runtime is that a screen's data never depends on native
// jellyfin-web's own request/cache state, only on a real HTTP response.
import { getServerAddress, getAuthHeaders, getCurrentUserId } from './auth.js';

async function getJson(path) {
  const response = await fetch(getServerAddress() + path, {
    headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
  });
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export function getSystemInfo() {
  return getJson('/System/Info');
}

export function getCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Users/' + userId);
}

// A user's own libraries, the same list the native sidebar and home screen
// both read from, real endpoint (GET /Users/{id}/Views).
export function getUserViews() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Users/' + userId + '/Views').then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real endpoint, the same one the native Resume/Continue Watching row
// reads: GET /Users/{id}/Items/Resume.
export function getResumeItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Resume?Limit=' +
    (limit || 20) +
    '&Fields=PrimaryImageAspectRatio&EnableImageTypes=Primary,Backdrop,Thumb';
  return getJson(query).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Latest items for one library, the same data the native home screen's own
// per-library "Latest in X" row reads (GET /Users/{id}/Items/Latest).
export function getLatestItems(parentId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Latest?ParentId=' +
    encodeURIComponent(parentId) +
    '&Limit=' +
    (limit || 16) +
    '&Fields=PrimaryImageAspectRatio';
  return getJson(query);
}

export function getImageUrl(itemId, type, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  if (opts.quality) params.set('quality', String(opts.quality));
  const query = params.toString();
  return (
    getServerAddress() +
    '/Items/' +
    itemId +
    '/Images/' +
    (type || 'Primary') +
    (query ? '?' + query : '')
  );
}
