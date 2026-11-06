import { getProfileSettings, saveWatchlistAutoRemoveSetting } from './apiSocial.js';

const STORAGE_KEY = 'jellioRemoveWatchlistAfterWatching';

export function isRemoveFromWatchlistAfterWatchingEnabled() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw !== 'false';
  } catch (err) {
    return true;
  }
}

export function setRemoveFromWatchlistAfterWatchingEnabled(enabled) {
  const value = Boolean(enabled);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    }
  } catch (err) {
  }
  return saveWatchlistAutoRemoveSetting(value).catch(function () {
    // Ignore network errors gracefully
  });
}

export function syncWatchlistSettingsFromServer() {
  return getProfileSettings()
    .then(function (settings) {
      if (settings && typeof settings.RemoveFromWatchlistAfterWatching === 'boolean') {
        const value = settings.RemoveFromWatchlistAfterWatching;
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
          }
        } catch (err) {
        }
        return value;
      }
      return isRemoveFromWatchlistAfterWatchingEnabled();
    })
    .catch(function () {
      return isRemoveFromWatchlistAfterWatchingEnabled();
    });
}
