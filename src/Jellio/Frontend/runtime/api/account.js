import { setDisplayLanguage } from '../i18n.js';
import { getCurrentUserId, updateSessionUser, getAccessToken, getServerAddress } from '../auth.js';
import { authedFetch, cached, getJson, invalidateCache, postJson, rowJson } from './core.js';

export function getCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('user:' + userId, function () {
    return rowJson('/Users/' + userId, 'user').then(function (user) {
      updateSessionUser(user);
      return user;
    });
  });
}

function invalidateCurrentUser() {
  const userId = getCurrentUserId();
  if (userId) invalidateCache('user:' + userId);
}

export function getAvatarPresets() {
  return getJson('/Jellio/avatars');
}

export function getAvatarPresetUrl(id) {
  const encodedSegments = String(id).split('/').map(encodeURIComponent).join('/');
  const token = getAccessToken();
  const query = token ? '?ApiKey=' + encodeURIComponent(token) : '';
  return getServerAddress() + '/Jellio/avatars/' + encodedSegments + query;
}

async function uploadUserAvatarBlob(blob) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));

  const contentType = blob.type || 'image/png';

  const base64 = await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = function () {
      resolve(String(reader.result).split(',')[1]);
    };
    reader.readAsDataURL(blob);
  });

  const response = await authedFetch('/Users/' + userId + '/Images/Primary', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: base64,
  });
  if (!response.ok) {
    const err = new Error('Could not set avatar');
    err.status = response.status;
    throw err;
  }
  invalidateCurrentUser();
}

export async function setUserAvatar(presetId) {
  const imageResponse = await fetch(getAvatarPresetUrl(presetId));
  if (!imageResponse.ok) {
    throw new Error('Could not load preset avatar');
  }
  const blob = await imageResponse.blob();
  return uploadUserAvatarBlob(blob);
}

export function setUserAvatarFromFile(file) {
  return uploadUserAvatarBlob(file);
}

export async function updateLanguagePreferences(audioLanguage, subtitleLanguage, subtitleMode) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const user = await getCurrentUser();
  const isOff = subtitleLanguage === 'off' || subtitleLanguage === 'none' || subtitleMode === 'None';
  const newConfig = {
    AudioLanguagePreference: audioLanguage || '',
    SubtitleLanguagePreference: isOff ? '' : (subtitleLanguage || ''),
  };
  if (subtitleMode !== undefined) {
    newConfig.SubtitleMode = subtitleMode;
  } else if (isOff) {
    newConfig.SubtitleMode = 'None';
  } else if (user && user.Configuration && user.Configuration.SubtitleMode === 'None') {
    newConfig.SubtitleMode = 'Default';
  }
  const configuration = Object.assign({}, user && user.Configuration, newConfig);
  const response = await authedFetch('/Users/' + userId + '/Configuration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(configuration),
  });
  if (!response.ok) {
    const err = new Error('Request failed: Configuration');
    err.status = response.status;
    throw err;
  }
  invalidateCurrentUser();
}

export function isQuickConnectEnabled() {
  return getJson('/QuickConnect/Enabled').catch(function () {
    return false;
  });
}

export async function authorizeQuickConnect(code) {
  const response = await authedFetch('/QuickConnect/Authorize?code=' + encodeURIComponent(code), {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const err = new Error('Request failed: QuickConnect/Authorize');
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : true;
}

export function updateUserPassword(currentPassword, newPassword) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return postJson('/Users/' + userId + '/Password', {
    CurrentPw: currentPassword || '',
    NewPw: newPassword,
  });
}

export function getUserById(userId) {
  return getJson('/Users/' + userId);
}

let cachedDisplayPreferences = null;

export function getCachedServerDisplayPreferences() {
  return cachedDisplayPreferences;
}

export async function getServerDisplayPreferences() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  if (cachedDisplayPreferences && cachedDisplayPreferences.UserId === userId) {
    return cachedDisplayPreferences;
  }
  try {
    const res = await authedFetch('/DisplayPreferences/usersettings?userId=' + encodeURIComponent(userId) + '&client=Jellio', {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      cachedDisplayPreferences = await res.json();
      if (cachedDisplayPreferences) cachedDisplayPreferences.UserId = userId;
      return cachedDisplayPreferences;
    }
  } catch (err) {
    // Network or server error
  }
  return null;
}

export async function saveServerDisplayPreferences(customPrefs) {
  const userId = getCurrentUserId();
  if (!userId || !customPrefs) return;
  try {
    const existing = await getServerDisplayPreferences();
    const existingCustom = (existing && existing.CustomPrefs) || {};
    const merged = Object.assign({}, existingCustom, customPrefs);
    const body = {
      Id: 'usersettings',
      Client: 'Jellio',
      CustomPrefs: merged,
    };
    cachedDisplayPreferences = Object.assign({}, existing, body, { UserId: userId });
    await authedFetch('/DisplayPreferences/usersettings?userId=' + encodeURIComponent(userId) + '&client=Jellio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Best effort only
  }
}

// Sync display language preference to Jellyfin server DisplayPreferences
export async function saveServerDisplayLanguage(lang) {
  return saveServerDisplayPreferences({ language: lang || 'en' });
}

export async function loadServerPreferences() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  const prefs = await getServerDisplayPreferences();
  if (prefs && prefs.CustomPrefs) {
    if (prefs.CustomPrefs.onboarding_done === 'true') {
      try {
        window.localStorage.setItem('jellio_onboarding_done_' + userId, 'true');
      } catch (_) {}
    }
    if (prefs.CustomPrefs.language) {
      try {
        const localLang = window.localStorage.getItem('jellio_display_language');
        if (!localLang && prefs.CustomPrefs.language) {
          setDisplayLanguage(prefs.CustomPrefs.language);
        }
      } catch (_) {}
    }
  }
  return prefs;
}
