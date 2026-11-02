import { getGrouplistIds, addToGrouplist, removeFromGrouplist } from './api.js';

let ids = null;
let loadPromise = null;

export function ensureGrouplistIdsLoaded() {
  if (ids) return Promise.resolve(ids);
  if (!loadPromise) {
    loadPromise = getGrouplistIds()
      .then(function (list) {
        ids = new Set(list);
        return ids;
      })
      .catch(function () {
        ids = new Set();
        return ids;
      });
  }
  return loadPromise;
}

export function isOnGrouplistSync(itemId) {
  return !!(ids && ids.has(itemId));
}

export function toggleGrouplist(itemId) {
  const isOn = isOnGrouplistSync(itemId);
  const request = isOn ? removeFromGrouplist(itemId) : addToGrouplist(itemId);
  return request.then(function (result) {
    if (!ids) ids = new Set();
    if (isOn) {
      ids.delete(itemId);
    } else {
      ids.add(itemId);
    }
    return result;
  });
}
