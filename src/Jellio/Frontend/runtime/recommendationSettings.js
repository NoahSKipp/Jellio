// Per-user recommendation settings for Home screen:
// - "What Others Are Watching" community row toggle and excluded user IDs
// - Preferred genre rows selection (empty = automatic discovery)
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

export function setCommunityExcludedUsers(userIds) {
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
