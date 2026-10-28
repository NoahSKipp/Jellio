// Live TV: every channel with what is on now, favourites first, a search
// box, and a 24 hour guide per channel. Streams the user added by link sit
// on top as My streams. Picking a channel opens the live player
// (screens/livePlayer.js).
import { t, getDisplayLanguage } from '../runtime/i18n.js';
import { el } from '../runtime/dom.js';
import { navigateTo } from '../runtime/router.js';
import {
  getLiveChannels,
  getLiveHealth,
  getLivePrograms,
  getImageUrl,
  setChannelFavorite,
  getStreamLinks,
  addStreamLink,
  removeStreamLink,
  refreshStreamLink,
  removeStreamLinkEntry,
} from '../runtime/api.js';
import { flattenStreamLinks, groupStreamLinks, streamLinkErrorKey, PLAYLIST_PREVIEW } from '../runtime/streamLinks.js';
import { mapChannels, filterChannels, arrangeChannels, guideWindow, languageFacets, applyHealth, GUIDE_HOURS } from '../runtime/liveTv.js';
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

const LANGUAGE_CODES = {
  English: 'en', German: 'de', French: 'fr', Spanish: 'es', Portuguese: 'pt', Italian: 'it',
  Dutch: 'nl', Polish: 'pl', Turkish: 'tr', Arabic: 'ar', Greek: 'el',
};

function languageName(language) {
  const code = LANGUAGE_CODES[language];
  if (!code || typeof Intl === 'undefined' || !Intl.DisplayNames) return language;
  try {
    return new Intl.DisplayNames([getDisplayLanguage()], { type: 'language' }).of(code) || language;
  } catch (err) {
    return language;
  }
}

export function liveFilters() {
  const state = readState();
  return { kind: state.kind || null, language: state.language || null };
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
  const src = channel.imageTag
    ? getImageUrl(channel.id, 'Primary', { tag: channel.imageTag, maxWidth: size || 160 })
    : channel.logoUrl && /^https:/i.test(channel.logoUrl)
      ? channel.logoUrl
      : null;
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
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
  if (channel.failing) {
    tile.classList.add('jellio-live-tile-failing');
    const nameRow = el('div', 'jellio-live-tile-name-row');
    nameRow.appendChild(el('div', 'jellio-live-tile-name', channel.name));
    nameRow.appendChild(failingBadge());
    text.appendChild(nameRow);
  } else {
    text.appendChild(el('div', 'jellio-live-tile-name', channel.name));
  }
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

function failingBadge() {
  const badge = el('span', 'jellio-live-badge jellio-live-badge-failing', t('live_link_failing'));
  badge.title = t('live_link_failing_hint');
  return badge;
}

// actions: { remove, removeLabel, check }
function buildUserTile(channel, actions) {
  const tile = el('div', 'jellio-live-tile' + (channel.failing ? ' jellio-live-tile-failing' : ''));
  const main = el('button', 'jellio-live-tile-main');
  main.type = 'button';
  main.setAttribute('aria-label', channel.name);
  main.addEventListener('click', function () {
    openChannel(channel);
  });
  main.appendChild(buildChannelLogo(channel));
  const text = el('div', 'jellio-live-tile-text');
  const nameRow = el('div', 'jellio-live-tile-name-row');
  nameRow.appendChild(el('div', 'jellio-live-tile-name', channel.name));
  if (channel.quality) nameRow.appendChild(el('span', 'jellio-live-badge', channel.quality));
  if (channel.failing && channel.entry == null) nameRow.appendChild(failingBadge());
  text.appendChild(nameRow);
  if (channel.description) text.appendChild(el('div', 'jellio-live-tile-description', channel.description));
  if (channel.group) text.appendChild(el('div', 'jellio-live-tile-now jellio-live-tile-idle', channel.group));
  main.appendChild(text);
  tile.appendChild(main);
  const a = actions || {};
  if (a.remove || a.check) {
    const side = el('div', 'jellio-live-tile-actions');
    if (a.check) side.appendChild(checkButton(a.check));
    if (a.remove) side.appendChild(confirmButton('delete', a.removeLabel || t('live_link_remove'), a.remove));
    tile.appendChild(side);
  }
  return tile;
}

// Tries the link again now instead of waiting for the next check.
function checkButton(onCheck) {
  const button = el('button', 'jellio-live-icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', t('live_link_check'));
  button.title = t('live_link_check');
  button.appendChild(el('span', 'material-icons', 'refresh'));
  button.addEventListener('click', async function () {
    button.disabled = true;
    try {
      await onCheck();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

// Removing asks for a second press within a few seconds instead of a dialog.
function confirmButton(icon, label, onConfirm) {
  const button = el('button', 'jellio-live-icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  const glyph = el('span', 'material-icons', icon);
  button.appendChild(glyph);
  let armed = null;
  button.addEventListener('click', function () {
    if (armed) {
      window.clearTimeout(armed);
      armed = null;
      onConfirm();
      return;
    }
    button.classList.add('jellio-live-icon-button-armed');
    glyph.textContent = 'delete_forever';
    button.title = t('live_link_remove_confirm');
    button.setAttribute('aria-label', t('live_link_remove_confirm'));
    armed = window.setTimeout(function () {
      armed = null;
      button.classList.remove('jellio-live-icon-button-armed');
      glyph.textContent = icon;
      button.title = label;
      button.setAttribute('aria-label', label);
    }, 4000);
  });
  return button;
}

// A link to a stream, an M3U list or a page with a player; the server
// finds the stream and saves it for this user.
function openAddSheet(onAdded) {
  const overlay = el('div', 'jellio-live-guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const panel = el('form', 'jellio-live-guide jellio-live-add');
  panel.noValidate = true;
  const header = el('div', 'jellio-live-guide-header');
  const titles = el('div', 'jellio-live-guide-titles');
  titles.appendChild(el('div', 'jellio-live-guide-channel', t('live_link_add_title')));
  titles.appendChild(el('div', 'jellio-live-guide-sub', t('live_link_add_intro')));
  header.appendChild(titles);
  const closeButton = el('button', 'jellio-settings-button', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.addEventListener('click', close);
  header.appendChild(closeButton);
  panel.appendChild(header);

  function field(labelText, input) {
    const label = el('label', 'jellio-live-add-field');
    label.appendChild(el('span', 'jellio-live-add-label', labelText));
    label.appendChild(input);
    return label;
  }
  const url = document.createElement('input');
  url.type = 'url';
  url.inputMode = 'url';
  url.autocomplete = 'off';
  url.placeholder = 'https://';
  url.className = 'jellio-search-input';
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 80;
  name.autocomplete = 'off';
  name.className = 'jellio-search-input';
  panel.appendChild(field(t('live_link_url'), url));
  panel.appendChild(field(t('live_link_name'), name));
  const submit = el('button', 'jellio-settings-button jellio-live-add-submit', t('live_link_add'));
  submit.type = 'submit';
  panel.appendChild(submit);
  const status = el('p', 'jellio-live-add-status', '');
  status.setAttribute('role', 'status');
  panel.appendChild(status);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  url.focus();

  let busy = false;
  panel.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    const value = url.value.trim();
    if (!/^https?:\/\//i.test(value)) {
      status.textContent = t('live_link_error_invalid');
      url.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    status.textContent = t('live_link_adding');
    try {
      const link = await addStreamLink(value, name.value.trim());
      close();
      onAdded(link);
    } catch (err) {
      status.textContent = t(streamLinkErrorKey(err && err.code));
      submit.disabled = false;
      busy = false;
    }
  });

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
}

export async function renderLiveTv(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-livetv';

  const header = el('header', 'jellio-live-header');
  header.appendChild(el('h1', 'jellio-settings-title', t('nav_live_tv')));
  const count = el('div', 'jellio-live-count', '');
  header.appendChild(count);
  const addButton = el('button', 'jellio-settings-button jellio-live-add-button');
  addButton.type = 'button';
  addButton.appendChild(el('span', 'material-icons', 'add_link'));
  addButton.appendChild(el('span', '', t('live_link_add_title')));
  addButton.addEventListener('click', function () {
    openAddSheet(function () {
      loadLinks().then(render);
    });
  });
  header.appendChild(addButton);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'jellio-search-input jellio-live-search';
  search.placeholder = t('live_search');
  search.setAttribute('aria-label', t('live_search'));
  const state = readState();
  search.value = state.filter || '';
  header.appendChild(search);
  root.appendChild(header);

  const filterBar = el('div', 'jellio-live-filters');
  root.appendChild(filterBar);

  const body = el('div', 'jellio-live-body');
  root.appendChild(body);
  renderLoading(body);

  let channels = [];
  let brokenOpen = false;
  let links = [];
  let userChannels = [];
  let refreshTimer = null;
  let scrollTimer = null;
  let restoredScroll = false;

  // My streams failing to load never hides the server's channels.
  function loadLinks() {
    return getStreamLinks().then(function (result) {
      links = result;
      userChannels = flattenStreamLinks(links);
    }).catch(function () {});
  }

  async function load(fresh) {
    const linksLoaded = loadLinks();
    try {
      const health = getLiveHealth({ fresh: fresh });
      channels = applyHealth(mapChannels(await getLiveChannels({ fresh: fresh }), Date.now()), await health);
    } catch (err) {
      await linksLoaded;
      if (!links.length) {
        renderRetry(body, describeNetworkFailure(err), function () {
          renderLoading(body);
          load(true);
        });
        return;
      }
      channels = [];
    }
    await linksLoaded;
    render();
  }

  async function checkLink(link) {
    try {
      await refreshStreamLink(link.Id);
    } catch (err) {}
    await loadLinks();
    render();
  }

  async function removeEntry(link, index) {
    try {
      await removeStreamLinkEntry(link.Id, index);
    } catch (err) {}
    await loadLinks();
    render();
  }

  async function removeLink(link) {
    try {
      await removeStreamLink(link.Id);
    } catch (err) {}
    await loadLinks();
    render();
  }

  function renderMyStreams(visibleUser) {
    if (!links.length) return;
    const narrowed = !!search.value.trim() || !!liveFilters().kind || !!liveFilters().language;
    const groups = groupStreamLinks(links, narrowed ? visibleUser.map(function (c) { return c.id; }) : null);
    if (!groups.singles.length && !groups.playlists.some(function (p) { return p.channels.length; })) return;
    body.appendChild(el('h2', 'jellio-row-title', t('live_link_section')));
    if (groups.singles.length) {
      const grid = el('div', 'jellio-live-grid');
      groups.singles.forEach(function (single) {
        grid.appendChild(buildUserTile(single.channel, {
          remove: function () {
            removeLink(single.link);
          },
          check: single.channel.failing ? function () {
            return checkLink(single.link);
          } : null,
        }));
      });
      body.appendChild(grid);
    }
    groups.playlists.forEach(function (playlist) {
      if (!playlist.channels.length && narrowed) return;
      const head = el('div', 'jellio-live-playlist-head');
      head.appendChild(el('h3', 'jellio-live-playlist-title', playlist.link.Name));
      if (playlist.link.Health === 'failing') head.appendChild(failingBadge());
      head.appendChild(el('span', 'jellio-live-count', t('live_channel_count', { count: playlist.channels.length })));
      const refresh = el('button', 'jellio-live-icon-button');
      refresh.type = 'button';
      refresh.setAttribute('aria-label', t('live_link_refresh'));
      refresh.title = t('live_link_refresh');
      refresh.appendChild(el('span', 'material-icons', 'refresh'));
      refresh.addEventListener('click', async function () {
        refresh.disabled = true;
        try {
          await refreshStreamLink(playlist.link.Id);
        } catch (err) {}
        await loadLinks();
        render();
      });
      head.appendChild(refresh);
      head.appendChild(confirmButton('delete', t('live_link_remove'), function () {
        removeLink(playlist.link);
      }));
      body.appendChild(head);
      const grid = el('div', 'jellio-live-grid');
      playlist.channels.slice(0, PLAYLIST_PREVIEW).forEach(function (channel) {
        grid.appendChild(buildUserTile(channel, {
          removeLabel: t('live_link_remove_channel'),
          remove: function () {
            removeEntry(playlist.link, channel.entry);
          },
        }));
      });
      body.appendChild(grid);
      if (playlist.channels.length > PLAYLIST_PREVIEW) {
        body.appendChild(el('p', 'jellio-live-empty', t('live_link_more', { count: playlist.channels.length - PLAYLIST_PREVIEW })));
      }
    });
  }

  function render() {
    body.textContent = '';
    if (!channels.length && !links.length) {
      body.appendChild(el('p', 'jellio-live-empty', t('live_no_channels')));
      count.textContent = '';
      return;
    }
    renderFilters();
    const visible = filterChannels(channels, search.value, liveFilters());
    const visibleUser = filterChannels(userChannels, search.value, liveFilters());
    count.textContent = t('live_channel_count', { count: visible.length + visibleUser.length });
    if (!visible.length && !visibleUser.length) {
      body.appendChild(el('p', 'jellio-live-empty', t('live_no_results')));
      return;
    }
    renderMyStreams(visibleUser);
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
    // Channels that failed to start recently, folded away at the bottom.
    if (groups.broken.length) {
      const toggle = el('button', 'jellio-live-broken-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', brokenOpen ? 'true' : 'false');
      toggle.appendChild(el('span', 'material-icons', brokenOpen ? 'expand_less' : 'expand_more'));
      toggle.appendChild(el('span', '', t('live_broken_section', { count: groups.broken.length })));
      toggle.addEventListener('click', function () {
        brokenOpen = !brokenOpen;
        render();
      });
      body.appendChild(toggle);
      if (brokenOpen) {
        body.appendChild(el('p', 'jellio-live-broken-hint', t('live_broken_hint')));
        const grid = el('div', 'jellio-live-grid');
        groups.broken.forEach(function (channel) {
          grid.appendChild(buildChannelTile(channel, toggleFavorite));
        });
        body.appendChild(grid);
      }
    }
    if (!restoredScroll) {
      restoredScroll = true;
      const y = readState().scrollY;
      if (typeof y === 'number') window.requestAnimationFrame(function () { window.scrollTo(0, y); });
    }
  }

  function chip(label, active, onClick) {
    const button = el('button', 'jellio-service-chip' + (active ? ' jellio-service-chip-active' : ''), label);
    button.type = 'button';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.addEventListener('click', onClick);
    return button;
  }

  // Type, then the languages present, most channels first.
  function renderFilters() {
    const focusedLabel = filterBar.contains(document.activeElement) ? document.activeElement.textContent : null;
    const current = liveFilters();
    filterBar.textContent = '';
    const types = el('div', 'jellio-service-chips');
    [[null, t('live_type_all')], ['sports', t('live_type_sports')], ['tv', t('live_type_tv')]].forEach(function (entry) {
      types.appendChild(chip(entry[1], current.kind === entry[0], function () {
        writeState({ kind: entry[0] });
        render();
      }));
    });
    filterBar.appendChild(types);
    const facets = languageFacets(channels.concat(userChannels));
    if (facets.length > 1) {
      const languages = el('div', 'jellio-service-chips');
      languages.appendChild(chip(t('live_language_all'), !current.language, function () {
        writeState({ language: null });
        render();
      }));
      facets.forEach(function (facet) {
        languages.appendChild(chip(languageName(facet.language) + ' · ' + facet.count, current.language === facet.language, function () {
          writeState({ language: current.language === facet.language ? null : facet.language });
          render();
        }));
      });
      filterBar.appendChild(languages);
    }
    if (focusedLabel) {
      const again = Array.from(filterBar.querySelectorAll('button')).find(function (b) {
        return b.textContent === focusedLabel;
      });
      if (again) again.focus();
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
