// Real Watchlist state comes for free on every fetched item
// (item.UserData.IsFavorite), Jellyfin's own real favorites concept.
// Grouplist has no native concept to piggyback on (runtime/api.js's
// own getGrouplistIds() header explains why), so nothing about a
// freshly fetched item already says whether it is on this reader's
// own Grouplist. One cached id Set instead, loaded lazily the first
// time components/listMembershipMenu.js actually needs it (a reader
// with runtime/grouplistSettings.js's own isGrouplistEnabled() off
// never pays for this at all) rather than at boot alongside that
// plain boolean.
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

// Synchronous, real "not yet known" default (false) until the load
// above has actually resolved once: callers that need this to paint
// correctly call ensureGrouplistIdsLoaded() first and repaint off its
// own resolution, same real pattern this whole runtime already uses
// for every other cached synchronous read.
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
