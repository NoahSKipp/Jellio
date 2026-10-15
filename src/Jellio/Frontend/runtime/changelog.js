// What's New changelog definitions and tracking for Jellio Web.
// Updated on releases so users can inspect release notes in Settings -> About,
// while notifications are restricted strictly to big releases (1.4X.0) so users
// are not alerted on small patch releases.
import { getCurrentUserId } from './auth.js';

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

export const CHANGELOG_RELEASES = [
  {
    version: '1.79.1',
    title: "What's New in Jellio",
    subtitle: 'Version 1.79.1',
    summary: "UI refinements and What's New display improvements.",
    highlights: [
      {
        title: "Expandable What's New",
        description: "What's New in Settings is now cleanly collapsed with an interactive chevron so it never dominates the About page.",
      },
      {
        title: 'Instant Screen Loading',
        description: 'Secondary screens and modules are loaded dynamically on demand, cutting initial bundle parse time.',
      },
    ],
  },
  {
    version: '1.79.0',
    title: "What's New in Jellio",
    subtitle: 'Version 1.79.0',
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
  },
];

export const LATEST_CHANGELOG = CHANGELOG_RELEASES[0];
export const LATEST_BIG_CHANGELOG = CHANGELOG_RELEASES.find((r) => isBigRelease(r.version)) || LATEST_CHANGELOG;

export const MACOS_CHANGELOG_RELEASES = [
  {
    version: '0.5.0',
    title: "What's New in Jellio for macOS",
    subtitle: 'Version 0.5.0',
    summary: 'Global media keys, display sleep prevention, and Apple Silicon hardware decoding.',
    highlights: [
      {
        title: 'Global Media Keys',
        description: 'Control playback from anywhere using keyboard media keys (Play/Pause, Next Track, Previous Track).',
      },
      {
        title: 'Display Sleep Prevention',
        description: 'Prevents display sleep automatically while a video is playing, without keeping your Mac awake when idle.',
      },
      {
        title: 'Hardware Video Acceleration',
        description: 'Enhanced Apple Silicon hardware decoding flags for zero-copy 4K and HEVC playback with minimal battery draw.',
      },
    ],
  },
  {
    version: '0.4.1',
    title: "What's New in Jellio for macOS",
    subtitle: 'Version 0.4.1',
    summary: 'Direct network routing fix.',
    highlights: [
      {
        title: 'Direct Network Routing',
        description: 'Streams and API calls connect directly to your server without proxying through the main Electron process.',
      },
    ],
  },
  {
    version: '0.4.0',
    title: "What's New in Jellio for macOS",
    subtitle: 'Version 0.4.0',
    summary: 'Native dock menu, download badges, and quit protection.',
    highlights: [
      {
        title: 'Native Dock Menu & Alerts',
        description: 'Quick navigation dock menu, running download badge counts, and graceful exit confirmations.',
      },
      {
        title: 'Apple Silicon Zero-Copy Decoding',
        description: 'Optimized GPU rasterization and zero-copy video buffer transfers for M-series chips.',
      },
    ],
  },
  {
    version: '0.3.0',
    title: "What's New in Jellio for macOS",
    subtitle: 'Version 0.3.0',
    summary: 'HEVC offline downloads support.',
    highlights: [
      {
        title: 'HEVC Offline Downloads',
        description: 'Download movies and episodes in HEVC format when supported by the server, saving disk space and bandwidth.',
      },
    ],
  },
  {
    version: '0.2.0',
    title: "What's New in Jellio for macOS",
    subtitle: 'Version 0.2.0',
    summary: 'In-app updater.',
    highlights: [
      {
        title: 'In-App Automatic Updates',
        description: 'Seamless background update checks and one-click installation directly from Settings > About.',
      },
    ],
  },
];


function storageKey() {
  const userId = getCurrentUserId() || 'global';
  return 'jellio_last_seen_changelog_' + userId;
}

export function shouldShowChangelogNotification() {
  // Notifications and toasts are only triggered by big releases (1.4X.0)
  if (!isBigRelease(LATEST_BIG_CHANGELOG.version)) {
    return false;
  }
  return !hasSeenLatestChangelog();
}

export function hasSeenLatestChangelog() {
  if (!isBigRelease(LATEST_BIG_CHANGELOG.version)) {
    return true;
  }
  try {
    const seen = localStorage.getItem(storageKey());
    return seen === LATEST_BIG_CHANGELOG.version;
  } catch (err) {
    return false;
  }
}

export function markLatestChangelogSeen() {
  try {
    localStorage.setItem(storageKey(), LATEST_BIG_CHANGELOG.version);
  } catch (err) {
    console.warn('Jellio: could not save changelog state', err);
  }
}

export function getChangelogNotification() {
  const rel = LATEST_BIG_CHANGELOG;
  return {
    Id: 'changelog:' + rel.version,
    Name: rel.title,
    Kind: 'whatsnew',
    Detail: rel.subtitle + ': ' + rel.summary,
    Date: new Date().toISOString(),
    Read: false,
    Highlights: rel.highlights,
  };
}
