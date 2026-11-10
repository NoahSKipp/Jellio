import { getCurrentUserId } from './auth.js';
import { readString, writeString, remove } from './storage.js';

// The newest big release (X.Y.0) in runtime/changelog.js. Bump it whenever a big
// release is added there; tests/frontend/changelog.test.mjs fails until they match.
// Kept here so startup and the notification poll never load the full release list.
export const LATEST_BIG_CHANGELOG_VERSION = '1.109.0';

export function isBigRelease(version) {
  if (!version || typeof version !== 'string') return false;
  const clean = version.trim().replace(/^v/i, '');
  const parts = clean.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2], 10);
    const build = parts.length > 3 ? parseInt(parts[3], 10) : 0;
    return !isNaN(patch) && patch === 0 && (!build || build === 0);
  }
  if (parts.length === 2) return true;
  return false;
}

function storageKey() {
  const userId = getCurrentUserId() || 'global';
  return 'jellio_last_seen_changelog_' + userId;
}

export function shouldShowChangelogNotification() {
  // Notifications and toasts are only triggered by big releases (1.4X.0)
  if (!isBigRelease(LATEST_BIG_CHANGELOG_VERSION)) {
    return false;
  }
  return !hasSeenLatestChangelog();
}

export function hasSeenLatestChangelog() {
  if (!isBigRelease(LATEST_BIG_CHANGELOG_VERSION)) {
    return true;
  }
  try {
    const key = storageKey();
    const seen = readString(key);
    if (seen && seen !== LATEST_BIG_CHANGELOG_VERSION) {
      // Clear older version from storage so the new big release is fresh
      remove(key);
      return false;
    }
    return seen === LATEST_BIG_CHANGELOG_VERSION;
  } catch (err) {
    return false;
  }
}

export function markLatestChangelogSeen() {
  if (!writeString(storageKey(), LATEST_BIG_CHANGELOG_VERSION)) {
    console.warn('Jellio: could not save changelog state');
  }
}
