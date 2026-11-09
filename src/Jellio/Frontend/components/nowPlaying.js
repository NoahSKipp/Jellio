import { t } from '../runtime/i18n.js';
import { getNowPlayingSessions, getImageUrl } from '../runtime/api.js';
import { getBookCoverUrl, getMangaSeriesCoverUrl, getStreamCoverUrl } from '../runtime/apiBooks.js';
import { getMangaShelfHash } from './navShared.js';
import { mangaSeriesKey } from './mangaSeries.js';
import { isAuthenticated, getCurrentUserId, getCurrentUser } from '../runtime/auth.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const POLL_INTERVAL_MS = 10000;
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
  if (item.Type === 'TvChannel') return item.SeriesName || '';
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
  if (session.Activity === 'watching_live') return session.IsPaused ? 'Paused' : t('live_now_playing');
  if (session.IsPaused) return 'Paused';
  return session.Activity === 'listening' ? 'Listening' : 'Playing';
}

// Covers: a manga's series cover, a book's (Chaptarr) cover, an
// audiobook's album art, else the item's own image.
function posterUrls(item, imageId) {
  if (item.Type === 'TvChannel') {
    if (item.Source === 'link') return item.LogoUrl ? [item.LogoUrl] : [];
    return item.Id ? [getImageUrl(item.Id, 'Primary', { maxWidth: 200 })] : [];
  }
  if (item.Type === 'Manga') {
    return [item.MangaId ? getStreamCoverUrl(item.MangaId) : getMangaSeriesCoverUrl(item.Id)];
  }
  if (item.Type === 'Book') {
    const urls = [getImageUrl(item.Id, 'Primary', { maxWidth: 200 })];
    if (item.MangaId || (item.Stream && item.Stream.MangaId)) {
      urls.push(getStreamCoverUrl(item.MangaId || item.Stream.MangaId, item.SeriesName));
    }
    urls.push(getMangaSeriesCoverUrl(item.Id, item.SeriesName));
    urls.push(getBookCoverUrl(item.Id));
    return Array.from(new Set(urls.filter(Boolean)));
  }
  if (item.Type === 'AudioBook' && item.AlbumId) {
    return [getImageUrl(item.AlbumId, 'Primary', { maxWidth: 200 }), getImageUrl(item.Id, 'Primary', { maxWidth: 200 })];
  }
  return [getImageUrl(imageId, 'Primary', { maxWidth: 200 })];
}

function deviceIcon(session) {
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
  row.setAttribute('aria-label', t('action_go_to', { name: displayTitle(item) || '' }));

  function open() {
    hideNowPlayingPanel();
    // A live channel opens that channel; someone else's link opens Live TV.
    if (item.Type === 'TvChannel') {
      navigateTo(item.Source !== 'link' && item.Id ? '#/live?id=' + encodeURIComponent(item.Id) : '#/livetv');
      return;
    }
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

  const currentUserId = getCurrentUserId();
  const currentUser = getCurrentUser();
  const isOwnSession = Boolean(
    (currentUserId && session.UserId && currentUserId.replace(/-/g, '').toLowerCase() === session.UserId.replace(/-/g, '').toLowerCase()) ||
    (session.UserName && currentUser && session.UserName.toLowerCase() === (currentUser.Name || '').toLowerCase())
  );
  const isReading = session.Activity === 'reading';
  const canHandoff = Boolean(item && item.Id && !isReading && isOwnSession);

  if (canHandoff) {
    const handoffBtn = el('button', 'jellio-now-playing-handoff-btn');
    handoffBtn.type = 'button';
    handoffBtn.title = t('now_playing_handoff');
    handoffBtn.setAttribute('aria-label', t('now_playing_handoff'));

    const handoffIcon = el('span', 'material-icons', 'play_arrow');
    const handoffLabel = el('span', 'jellio-now-playing-handoff-label', t('now_playing_handoff'));
    handoffBtn.appendChild(handoffIcon);
    handoffBtn.appendChild(handoffLabel);

    handoffBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      hideNowPlayingPanel();
      if (item.Type === 'TvChannel' || session.Activity === 'watching_live') {
        navigateTo(item.Source !== 'link' && item.Id ? '#/live?id=' + encodeURIComponent(item.Id) : '#/livetv');
        return;
      }
      const ticks = session.PositionTicks || 0;
      const url = '#/play?id=' + encodeURIComponent(item.Id) + (ticks > 0 ? '&at=' + encodeURIComponent(ticks) : '');
      navigateTo(url);
    });

    row.appendChild(handoffBtn);
  }

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

  if (button && !button.dataset.jellioNowPlayingHoverBound) {
    button.dataset.jellioNowPlayingHoverBound = '1';
    button.addEventListener('mouseenter', showNowPlayingPanel);
    button.addEventListener('mouseleave', scheduleHoverClose);
  }

  panel.textContent = '';
  if (!sessions.length) {
    panel.appendChild(el('div', 'jellio-now-playing-empty', t('now_playing_nothing')));
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
  panel.setAttribute('aria-label', t('now_playing_title'));
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

function hideNowPlayingPanel() {
  cancelHoverClose();
  if (!panel) return;
  panel.classList.remove('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', 'false');
}

export function startNowPlaying() {
  if (started || !isAuthenticated()) return;
  started = true;
  createPanel();
  poll();
}

export function nowPlayingCount() {
  return lastCount;
}
