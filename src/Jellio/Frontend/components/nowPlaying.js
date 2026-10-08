// Now playing panel: shows every active session on the server, usernames
// included, real endpoint backed by Jellio's own ISessionManager reader
// (Controllers/NowPlayingController.cs, ported verbatim from the original
// Jellio codebase), no cron job or static file needed the way community
// scripts without a plugin backend have to do it. Self starting, module
// level singleton (an ES module only ever runs once), so this file's own
// poll loop and panel element exist for the lifetime of the page rather
// than being recreated on every sidebar render the way the original
// reskin's own IIFE version had to coordinate over a DOM CustomEvent
// between two independently loaded classic scripts, not needed here
// since sidebar.js can just import and call this module's own exports
// directly.
import {
  getNowPlayingSessions,
  getImageUrl,
  getBookCoverUrl,
  getMangaSeriesCoverUrl,
  getStreamCoverUrl,
} from '../runtime/api.js';
import { getMangaShelfHash } from './navShared.js';
import { mangaSeriesKey } from './mangaSeries.js';
import { isAuthenticated } from '../runtime/auth.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const POLL_INTERVAL_MS = 10000;
// Long enough to cross the real gap between the sidebar's own rail and
// this panel's own fixed position without the panel already closing
// under the reader's own cursor, short enough that leaving for
// somewhere else on the page still reads as an intentional close
// rather than a stuck-open panel.
const HOVER_CLOSE_DELAY_MS = 200;

let panel = null;
let started = false;
let lastCount = 0;
let hoverCloseTimer = null;

function pageText(item) {
  if (!item.Page) return '';
  return 'Page ' + item.Page + (item.PageCount ? ' of ' + item.PageCount : '');
}

function subtitle(item) {
  if (item.Type === 'Episode') {
    const parts = [];
    if (item.ParentIndexNumber != null && item.IndexNumber != null) {
      parts.push('S' + item.ParentIndexNumber + ' E' + item.IndexNumber);
    }
    return parts.join(' • ');
  }
  // A manga chapter under its series; a book by page.
  if (item.Type === 'Manga') return [item.SeriesName ? item.Name : '', pageText(item)].filter(Boolean).join(' • ');
  if (item.Type === 'Book') return pageText(item);
  if (item.Type === 'AudioBook') return item.Album && item.Name !== item.Album ? item.Name : '';
  return item.ProductionYear ? String(item.ProductionYear) : '';
}

function displayTitle(item) {
  if (item.Type === 'Episode' && item.SeriesName) return item.SeriesName;
  if (item.Type === 'Manga' && item.SeriesName) return item.SeriesName;
  if (item.Type === 'AudioBook' && item.Album) return item.Album;
  return item.Name || '';
}

function statusWord(session) {
  if (session.Activity === 'reading') return 'Reading';
  if (session.IsPaused) return 'Paused';
  return session.Activity === 'listening' ? 'Listening' : 'Playing';
}

// Covers: a manga's series cover, a book's (Chaptarr) cover, an
// audiobook's album art, else the item's own image.
function posterUrls(item, imageId) {
  if (item.Type === 'Manga') {
    return [item.MangaId ? getStreamCoverUrl(item.MangaId) : getMangaSeriesCoverUrl(item.Id)];
  }
  if (item.Type === 'Book') return [getImageUrl(item.Id, 'Primary', { maxWidth: 200 }), getBookCoverUrl(item.Id)];
  if (item.Type === 'AudioBook' && item.AlbumId) {
    return [getImageUrl(item.AlbumId, 'Primary', { maxWidth: 200 }), getImageUrl(item.Id, 'Primary', { maxWidth: 200 })];
  }
  return [getImageUrl(imageId, 'Primary', { maxWidth: 200 })];
}

// Real feedback: a reader could see who was watching what, real names
// and titles both, but had no way to actually reach the title itself
// from here, the one real thing this whole panel is already about.
// imageId already picks the series over an individual episode
// (SeriesId), same real title displayTitle() shows above the poster,
// so the row navigates to that same real item, not the episode's own
// id nothing here otherwise refers to.
// A Material icon for the device a session plays on, from what its client
// reports about itself (Jellyfin has no device type of its own).
export function deviceIcon(session) {
  const text = ((session.Client || '') + ' ' + (session.DeviceName || '')).toLowerCase();
  if (!text.trim()) return null;
  if (/chromecast|crkey|\bcast\b/.test(text)) return { icon: 'cast', label: 'Chromecast' };
  if (/\btv\b|android tv|google tv|fire ?tv|aft\w|shield|roku|kodi|webos|web0s|tizen|bravia|apple tv|tvos|xbox|playstation|smart-?tv/.test(text)) {
    return { icon: 'tv', label: 'TV' };
  }
  if (/ipad|tablet/.test(text)) return { icon: 'tablet_mac', label: 'Tablet' };
  if (/iphone|ipod|android phone|android|mobile|findroid|swiftfin|phone|pixel|galaxy|sm-[a-z]\d/.test(text)) {
    return { icon: 'smartphone', label: 'Phone' };
  }
  if (/windows|mac|linux|chromeos|desktop|media player|jellyfin web|browser|chrome|firefox|edge|safari|opera|jellio/.test(text)) {
    return { icon: 'computer', label: 'Computer' };
  }
  return { icon: 'devices', label: 'Device' };
}

function buildRow(session) {
  const row = el('div', 'jellio-now-playing-row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const item = session.Item;
  const imageId = item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
  row.setAttribute('aria-label', 'Go to ' + (displayTitle(item) || 'title'));

  function open() {
    hideNowPlayingPanel();
    // A manga opens its series on the Manga shelf.
    if (item.Type === 'Manga' && item.SeriesName) {
      getMangaShelfHash().then(function (shelf) {
        if (shelf) navigateTo(shelf + '&series=' + encodeURIComponent(mangaSeriesKey(item.SeriesName)));
      });
      return;
    }
    navigateTo('#/item?id=' + (item.Type === 'AudioBook' && item.AlbumId ? item.AlbumId : imageId));
  }
  row.addEventListener('click', open);
  row.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  const poster = el('div', 'jellio-now-playing-row-poster');
  poster.style.backgroundImage = posterUrls(item, imageId)
    .map((url) => 'url("' + url + '")')
    .join(', ');
  row.appendChild(poster);

  const text = el('div', 'jellio-now-playing-row-text');
  text.appendChild(el('p', 'jellio-now-playing-row-title', displayTitle(item)));
  const metaBits = [session.UserName];
  const sub = subtitle(item);
  if (sub) metaBits.push(sub);
  metaBits.push(statusWord(session));
  const meta = el('p', 'jellio-now-playing-row-meta');
  const device = deviceIcon(session);
  if (device) {
    const icon = el('span', 'material-icons jellio-now-playing-row-device ' + device.icon);
    const where = [session.DeviceName, session.Client].filter(Boolean).join(' · ');
    icon.title = where ? device.label + ': ' + where : device.label;
    icon.setAttribute('aria-label', icon.title);
    meta.appendChild(icon);
  }
  meta.appendChild(document.createTextNode(metaBits.filter(Boolean).join(' • ')));
  text.appendChild(meta);
  row.appendChild(text);

  return row;
}

function cancelHoverClose() {
  if (hoverCloseTimer) {
    window.clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
}

function scheduleHoverClose() {
  cancelHoverClose();
  hoverCloseTimer = window.setTimeout(hideNowPlayingPanel, HOVER_CLOSE_DELAY_MS);
}

function showNowPlayingPanel() {
  if (!panel) return;
  cancelHoverClose();
  panel.classList.add('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', 'true');
}

function render(sessions) {
  const button = document.querySelector('.jellio-sidebar-now-playing');
  const badge = document.querySelector('.jellio-sidebar-now-playing-badge');
  lastCount = sessions.length;
  if (badge) badge.textContent = String(sessions.length);
  if (button) button.classList.toggle('jellio-sidebar-now-playing-active', sessions.length > 0);

  // Real feedback: this used to only ever open on click. Bound here
  // rather than in startNowPlaying(), the one real place this button
  // is guaranteed to already exist: startNowPlaying() itself runs
  // before renderSidebar() on this same page's very first sync(), so
  // the button does not exist yet the first time it would try. This
  // same render() already re-queries the button on every poll tick
  // regardless, so the dataset marker below just keeps a stable button
  // from ever getting a second real listener stacked on top of the
  // first.
  if (button && !button.dataset.jellioNowPlayingHoverBound) {
    button.dataset.jellioNowPlayingHoverBound = '1';
    button.addEventListener('mouseenter', showNowPlayingPanel);
    button.addEventListener('mouseleave', scheduleHoverClose);
  }

  panel.textContent = '';
  if (!sessions.length) {
    panel.appendChild(el('div', 'jellio-now-playing-empty', 'Nothing playing right now'));
    return;
  }
  sessions.forEach(function (session) {
    panel.appendChild(buildRow(session));
  });
}

function poll() {
  getNowPlayingSessions()
    .then(function (sessions) {
      render(sessions || []);
    })
    .catch(function () {
      // Leave whatever was last shown, a failed poll is not worth
      // disrupting the panel over, it will try again on the next tick.
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

function createPanel() {
  panel = el('div', 'jellio-now-playing-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Now playing');
  panel.addEventListener('mouseenter', showNowPlayingPanel);
  panel.addEventListener('mouseleave', scheduleHoverClose);
  document.body.appendChild(panel);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.classList.contains('jellio-now-playing-panel-visible')) {
      hideNowPlayingPanel();
      const trigger = document.querySelector('.jellio-sidebar-now-playing');
      if (trigger) trigger.focus();
    }
  });
}

export function toggleNowPlayingPanel() {
  if (!panel) return;
  cancelHoverClose();
  const visible = panel.classList.toggle('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', String(visible));
}

export function hideNowPlayingPanel() {
  cancelHoverClose();
  if (!panel) return;
  panel.classList.remove('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', 'false');
}

// Called from app.js's own sync() once a session is confirmed
// authenticated, not at module load: this runtime's own session may not
// exist yet on first page load, and there is no point polling a real
// endpoint before there is a real token to send it.
export function startNowPlaying() {
  if (started || !isAuthenticated()) return;
  started = true;
  createPanel();
  poll();
}

export function nowPlayingCount() {
  return lastCount;
}
