// Live TV: every channel with what is on now, favourites first, a search
// box, and a 24 hour guide per channel. Picking a channel opens the live
// player (screens/livePlayer.js).
import { t } from '../runtime/i18n.js';
import { el } from '../runtime/dom.js';
import { navigateTo } from '../runtime/router.js';
import { getLiveChannels, getLivePrograms, getImageUrl, setChannelFavorite } from '../runtime/api.js';
import { mapChannels, filterChannels, arrangeChannels, guideWindow, GUIDE_HOURS } from '../runtime/liveTv.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';

const STATE_KEY = 'jellio.livetv.state';
const HOUR_MS = 60 * 60 * 1000;

function readState() {
  try {
    return JSON.parse(window.sessionStorage.getItem(STATE_KEY) || '{}') || {};
  } catch (err) {
    return {};
  }
}

function writeState(patch) {
  try {
    window.sessionStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(readState(), patch)));
  } catch (err) {}
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  return String(name || '?')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(function (part) {
      return part[0].toUpperCase();
    })
    .join('');
}

export function buildChannelLogo(channel, size) {
  const wrap = el('div', 'jellio-live-logo');
  const fallback = el('span', 'jellio-live-logo-initials', initials(channel.name));
  wrap.appendChild(fallback);
  if (channel.imageTag) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = getImageUrl(channel.id, 'Primary', { tag: channel.imageTag, maxWidth: size || 160 });
    img.addEventListener('load', function () {
      wrap.classList.add('jellio-live-logo-loaded');
    });
    img.addEventListener('error', function () {
      img.remove();
    });
    wrap.appendChild(img);
  }
  return wrap;
}

function openChannel(channel) {
  writeState({ lastChannelId: channel.id });
  navigateTo('#/live?id=' + encodeURIComponent(channel.id));
}

// The next 24 hours of one channel, as a sheet over the current screen.
export async function openGuide(channel, onPlay) {
  const overlay = el('div', 'jellio-live-guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const panel = el('div', 'jellio-live-guide');
  const header = el('div', 'jellio-live-guide-header');
  header.appendChild(buildChannelLogo(channel, 120));
  const titles = el('div', 'jellio-live-guide-titles');
  titles.appendChild(el('div', 'jellio-live-guide-channel', channel.name));
  titles.appendChild(el('div', 'jellio-live-guide-sub', t('live_guide')));
  header.appendChild(titles);
  const actions = el('div', 'jellio-live-guide-actions');
  if (onPlay) {
    const watch = el('button', 'jellio-settings-button', '▶');
    watch.type = 'button';
    watch.setAttribute('aria-label', channel.name);
    watch.addEventListener('click', function () {
      close();
      onPlay(channel);
    });
    actions.appendChild(watch);
  }
  const closeButton = el('button', 'jellio-settings-button', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.addEventListener('click', close);
  actions.appendChild(closeButton);
  header.appendChild(actions);
  panel.appendChild(header);
  const list = el('div', 'jellio-live-guide-list');
  panel.appendChild(list);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  renderLoading(list);

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  closeButton.focus();

  const now = Date.now();
  try {
    const programs = await getLivePrograms([channel.id], now, now + GUIDE_HOURS * HOUR_MS);
    const slots = guideWindow(programs, Date.now(), GUIDE_HOURS);
    list.textContent = '';
    if (!slots.length) {
      list.appendChild(el('p', 'jellio-live-empty', t('live_guide_empty')));
      return close;
    }
    let lastDay = '';
    slots.forEach(function (programme) {
      const day = new Date(programme.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      if (day !== lastDay) {
        lastDay = day;
        list.appendChild(el('div', 'jellio-live-guide-day', day));
      }
      const row = el('div', 'jellio-live-guide-row' + (programme.airing ? ' jellio-live-guide-row-airing' : ''));
      row.appendChild(el('div', 'jellio-live-guide-time', formatTime(programme.start) + ' – ' + formatTime(programme.end)));
      const body = el('div', 'jellio-live-guide-body');
      body.appendChild(el('div', 'jellio-live-guide-title', programme.name || t('live_nothing_listed')));
      if (programme.airing) {
        const bar = el('div', 'jellio-live-progress');
        const fill = el('div', 'jellio-live-progress-fill');
        fill.style.width = Math.round(programme.progress * 100) + '%';
        bar.appendChild(fill);
        body.appendChild(bar);
      }
      row.appendChild(body);
      list.appendChild(row);
    });
  } catch (err) {
    list.textContent = '';
    list.appendChild(el('p', 'jellio-live-empty', describeNetworkFailure(err)));
  }
  return close;
}

function buildChannelTile(channel, onFavorite) {
  const tile = el('div', 'jellio-live-tile');
  const main = el('button', 'jellio-live-tile-main');
  main.type = 'button';
  main.setAttribute('aria-label', channel.name + (channel.now ? ', ' + channel.now.name : ''));
  main.addEventListener('click', function () {
    openChannel(channel);
  });
  main.appendChild(buildChannelLogo(channel));
  const text = el('div', 'jellio-live-tile-text');
  text.appendChild(el('div', 'jellio-live-tile-name', channel.name));
  if (channel.now) {
    text.appendChild(el('div', 'jellio-live-tile-now', channel.now.name || t('live_nothing_listed')));
    const times = el('div', 'jellio-live-tile-times', formatTime(channel.now.start) + ' – ' + formatTime(channel.now.end));
    text.appendChild(times);
    const bar = el('div', 'jellio-live-progress');
    const fill = el('div', 'jellio-live-progress-fill');
    fill.style.width = Math.round(channel.now.progress * 100) + '%';
    bar.appendChild(fill);
    text.appendChild(bar);
  } else {
    text.appendChild(el('div', 'jellio-live-tile-now jellio-live-tile-idle', t('live_nothing_listed')));
  }
  main.appendChild(text);
  tile.appendChild(main);

  const side = el('div', 'jellio-live-tile-actions');
  const fav = el('button', 'jellio-live-icon-button' + (channel.favorite ? ' jellio-live-icon-button-active' : ''));
  fav.type = 'button';
  fav.setAttribute('aria-label', channel.favorite ? t('live_remove_favorite') : t('live_add_favorite'));
  fav.title = fav.getAttribute('aria-label');
  fav.appendChild(el('span', 'material-icons', channel.favorite ? 'star' : 'star_border'));
  fav.addEventListener('click', function () {
    onFavorite(channel);
  });
  side.appendChild(fav);
  const guide = el('button', 'jellio-live-icon-button');
  guide.type = 'button';
  guide.setAttribute('aria-label', t('live_guide'));
  guide.title = t('live_guide');
  guide.appendChild(el('span', 'material-icons', 'view_list'));
  guide.addEventListener('click', function () {
    openGuide(channel, openChannel);
  });
  side.appendChild(guide);
  tile.appendChild(side);
  return tile;
}

export async function renderLiveTv(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-livetv';

  const header = el('header', 'jellio-live-header');
  header.appendChild(el('h1', 'jellio-settings-title', t('nav_live_tv')));
  const count = el('div', 'jellio-live-count', '');
  header.appendChild(count);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'jellio-search-input jellio-live-search';
  search.placeholder = t('live_search');
  search.setAttribute('aria-label', t('live_search'));
  const state = readState();
  search.value = state.filter || '';
  header.appendChild(search);
  root.appendChild(header);

  const body = el('div', 'jellio-live-body');
  root.appendChild(body);
  renderLoading(body);

  let channels = [];
  let refreshTimer = null;
  let scrollTimer = null;
  let restoredScroll = false;

  async function load(fresh) {
    try {
      channels = mapChannels(await getLiveChannels({ fresh: fresh }), Date.now());
    } catch (err) {
      renderRetry(body, describeNetworkFailure(err), function () {
        renderLoading(body);
        load(true);
      });
      return;
    }
    render();
  }

  function render() {
    body.textContent = '';
    if (!channels.length) {
      body.appendChild(el('p', 'jellio-live-empty', t('live_no_channels')));
      count.textContent = '';
      return;
    }
    const visible = filterChannels(channels, search.value);
    count.textContent = t('live_channel_count', { count: visible.length });
    if (!visible.length) {
      body.appendChild(el('p', 'jellio-live-empty', t('live_no_results')));
      return;
    }
    const groups = arrangeChannels(visible);
    if (groups.favorites.length) {
      body.appendChild(el('h2', 'jellio-row-title', t('live_favorites')));
      const favGrid = el('div', 'jellio-live-grid');
      groups.favorites.forEach(function (channel) {
        favGrid.appendChild(buildChannelTile(channel, toggleFavorite));
      });
      body.appendChild(favGrid);
    }
    if (groups.others.length) {
      body.appendChild(el('h2', 'jellio-row-title', t('live_all')));
      const grid = el('div', 'jellio-live-grid');
      groups.others.forEach(function (channel) {
        grid.appendChild(buildChannelTile(channel, toggleFavorite));
      });
      body.appendChild(grid);
    }
    if (!restoredScroll) {
      restoredScroll = true;
      const y = readState().scrollY;
      if (typeof y === 'number') window.requestAnimationFrame(function () { window.scrollTo(0, y); });
    }
  }

  async function toggleFavorite(channel) {
    const next = !channel.favorite;
    channel.favorite = next;
    render();
    try {
      await setChannelFavorite(channel.id, next);
    } catch (err) {
      channel.favorite = !next;
      render();
    }
  }

  let searchTimer = null;
  search.addEventListener('input', function () {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      writeState({ filter: search.value });
      render();
    }, 120);
  });

  function onScroll() {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(function () {
      writeState({ scrollY: window.scrollY });
    }, 150);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  await load(false);
  // What is on now moves on; refresh the list each minute.
  refreshTimer = window.setInterval(function () {
    if (document.visibilityState === 'visible') load(true);
  }, 60000);

  return function cleanup() {
    window.clearInterval(refreshTimer);
    window.clearTimeout(searchTimer);
    window.clearTimeout(scrollTimer);
    window.removeEventListener('scroll', onScroll);
  };
}
