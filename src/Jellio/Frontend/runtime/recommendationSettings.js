import { getCurrentUserId } from './auth.js';

function storageKey() {
  const userId = getCurrentUserId() || 'guest';
  return 'jellio_recommendations_' + userId;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(settings));
  } catch (err) {
    console.warn('Jellio: could not save recommendation settings', err);
  }
}

export function isCommunityRowEnabled() {
  const settings = loadSettings();
  return settings.communityRowEnabled !== undefined ? Boolean(settings.communityRowEnabled) : true;
}

export function setCommunityRowEnabled(enabled) {
  const settings = loadSettings();
  settings.communityRowEnabled = Boolean(enabled);
  saveSettings(settings);
}

export function getCommunityExcludedUsers() {
  const settings = loadSettings();
  return Array.isArray(settings.communityExcludedUsers) ? settings.communityExcludedUsers : [];
}

function setCommunityExcludedUsers(userIds) {
  const settings = loadSettings();
  settings.communityExcludedUsers = Array.isArray(userIds) ? userIds : [];
  saveSettings(settings);
}

export function toggleCommunityExcludedUser(userId) {
  const excluded = new Set(getCommunityExcludedUsers());
  if (excluded.has(userId)) {
    excluded.delete(userId);
  } else {
    excluded.add(userId);
  }
  setCommunityExcludedUsers(Array.from(excluded));
  return excluded.has(userId);
}

export function getSelectedGenres() {
  const settings = loadSettings();
  return Array.isArray(settings.selectedGenres) ? settings.selectedGenres : [];
}

export function setSelectedGenres(genres) {
  const settings = loadSettings();
  settings.selectedGenres = Array.isArray(genres) ? genres : [];
  saveSettings(settings);
}

export function toggleSelectedGenre(genre) {
  const current = getSelectedGenres();
  const index = current.indexOf(genre);
  let updated;
  if (index >= 0) {
    updated = current.filter(function (g) {
      return g !== genre;
    });
  } else {
    updated = current.concat([genre]);
  }
  setSelectedGenres(updated);
  return updated;
}

export function getCustomGenres() {
  const settings = loadSettings();
  return Array.isArray(settings.customGenres) ? settings.customGenres : [];
}

export function setCustomGenres(list) {
  const settings = loadSettings();
  settings.customGenres = Array.isArray(list) ? list : [];
  saveSettings(settings);
}

export function addCustomGenre(genreObj) {
  if (!genreObj || !genreObj.name) return getCustomGenres();
  const current = getCustomGenres();
  const trimmedName = String(genreObj.name).trim();
  const index = current.findIndex(function (g) {
    return (g.name || '').trim().toLowerCase() === trimmedName.toLowerCase();
  });
  const item = {
    name: trimmedName,
    category: genreObj.category || null,
    enabled: genreObj.enabled !== undefined ? Boolean(genreObj.enabled) : true,
  };
  let updated;
  if (index >= 0) {
    updated = current.map(function (g, i) {
      return i === index ? item : g;
    });
  } else {
    updated = current.concat([item]);
  }
  setCustomGenres(updated);
  return updated;
}

export function removeCustomGenre(name) {
  const current = getCustomGenres();
  const target = String(name || '').trim().toLowerCase();
  const updated = current.filter(function (g) {
    return (g.name || '').trim().toLowerCase() !== target;
  });
  setCustomGenres(updated);
  return updated;
}
