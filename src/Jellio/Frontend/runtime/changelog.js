// What's New changelog definitions and tracking for Jellio Web.
// Updated on notable/major releases so users are notified of new features
// without spamming them on minor bugfix patches.
import { getCurrentUserId } from './auth.js';

export const LATEST_CHANGELOG = {
  version: '1.78.0',
  title: "What's New in Jellio",
  subtitle: 'Version 1.78.0',
  summary: 'New Recommendations row, custom recommendation settings, manga chapter art fallback, and performance optimizations.',
  highlights: [
    {
      title: 'What Others Are Watching',
      description: 'A new row on your home screen highlights what friends and family on your server are actively streaming or recently finished, complete with viewer avatars.',
    },
    {
      title: 'Recommendations Settings',
      description: 'A new dedicated Settings tab lets you manage which users appear in your social watching row, or toggle the row off entirely.',
    },
    {
      title: 'Genre Row Customization',
      description: 'Take control of your home feed: select and order your favorite genre rows directly from Recommendations settings.',
    },
    {
      title: 'Manga Chapter Cover Fallback',
      description: 'Chapters without individual thumbnails automatically use the overall manga series cover art.',
    },
    {
      title: 'Performance & Speed Improvements',
      description: 'Server-side caching for genres and watching activity reduces database load for faster, smoother browsing.',
    },
  ],
};

function storageKey() {
  const userId = getCurrentUserId() || 'global';
  return 'jellio_last_seen_changelog_' + userId;
}

export function hasSeenLatestChangelog() {
  try {
    const seen = localStorage.getItem(storageKey());
    return seen === LATEST_CHANGELOG.version;
  } catch (err) {
    return false;
  }
}

export function markLatestChangelogSeen() {
  try {
    localStorage.setItem(storageKey(), LATEST_CHANGELOG.version);
  } catch (err) {
    console.warn('Jellio: could not save changelog state', err);
  }
}

export function getChangelogNotification() {
  return {
    Id: 'changelog:' + LATEST_CHANGELOG.version,
    Name: LATEST_CHANGELOG.title,
    Kind: 'whatsnew',
    Detail: LATEST_CHANGELOG.subtitle + ': ' + LATEST_CHANGELOG.summary,
    Date: new Date().toISOString(),
    Read: false,
    Highlights: LATEST_CHANGELOG.highlights,
  };
}
