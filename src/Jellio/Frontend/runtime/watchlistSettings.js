import { getProfileSettings, saveWatchlistAutoRemoveSetting } from './apiSocial.js';
import { readString, writeString } from './storage.js';

const STORAGE_KEY = 'jellioRemoveWatchlistAfterWatching';

export function isRemoveFromWatchlistAfterWatchingEnabled() {
  const raw = readString(STORAGE_KEY);
  return raw === null ? true : raw !== 'false';
}

export function setRemoveFromWatchlistAfterWatchingEnabled(enabled) {
  const value = Boolean(enabled);
  writeString(STORAGE_KEY, value ? 'true' : 'false');
  return saveWatchlistAutoRemoveSetting(value).catch(function () {
    // Ignore network errors gracefully
  });
}

export function syncWatchlistSettingsFromServer() {
  return getProfileSettings()
    .then(function (settings) {
      if (settings && typeof settings.RemoveFromWatchlistAfterWatching === 'boolean') {
        const value = settings.RemoveFromWatchlistAfterWatching;
        writeString(STORAGE_KEY, value ? 'true' : 'false');
        return value;
      }
      return isRemoveFromWatchlistAfterWatchingEnabled();
    })
    .catch(function () {
      return isRemoveFromWatchlistAfterWatchingEnabled();
    });
}
