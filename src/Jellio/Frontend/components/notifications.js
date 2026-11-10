import { t } from '../runtime/i18n.js';
import { getNotifications, markNotificationsRead, deleteNotification, clearAllNotifications, getImageUrl } from '../runtime/api.js';
import { getStreamCoverUrl } from '../runtime/apiBooks.js';
import { isAuthenticated, getServerAddress, getAccessToken } from '../runtime/auth.js';
import { navigateTo } from '../runtime/router.js';
import { getMangaShelfHash } from './navShared.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';
import { LATEST_BIG_CHANGELOG_VERSION, markLatestChangelogSeen, shouldShowChangelogNotification } from '../runtime/changelogState.js';
// The release history is large: it loads only when its notification is due.
let changelogModule = null;
function loadChangelog() {
  if (!changelogModule) changelogModule = import('../runtime/changelog.js');
  return changelogModule;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const HOVER_CLOSE_DELAY_MS = 200;

let panel = null;
let started = false;
let lastUnreadCount = 0;
let currentItems = [];
let hoverCloseTimer = null;
let knownIds = null;

function partyWhen(n) {
  const date = new Date(n.Date);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function messageFor(n) {
  if (n.Kind === 'party_scheduled') {
    return t('party_notice_scheduled', { host: n.Detail || 'Someone', name: n.Name, when: partyWhen(n) });
  }
  if (n.Kind === 'party_starting') {
    return t('party_notice_starting', { name: n.Name });
  }
  if (n.Kind === 'streamlink') {
    return t('live_link_dead_notice', { name: n.Name });
  }
  if (n.Kind === 'streamlink_removed') {
    return t('live_link_removed_notice', { name: n.Name, days: n.Detail || '' });
  }
  if (n.Kind === 'whatsnew') {
    return n.Name;
  }
  if (n.Kind === 'announcement') {
    return n.Name;
  }
  if (n.Kind === 'manga') {
    return n.Name + ': ' + (n.Detail || 'a new chapter');
  }
  if (n.Kind === 'episode') {
    return n.Name + (n.Detail ? ' ' + n.Detail : '') + ' is out now';
  }
  return n.Name + ' is available to watch';
}

function subtitleFor(n) {
  if (n.Kind === 'party_scheduled' || n.Kind === 'party_starting') return t('party_notice_sub');
  if (n.Kind === 'streamlink') return t('live_link_dead_sub');
  if (n.Kind === 'streamlink_removed') return t('live_link_section');
  if (n.Kind === 'whatsnew') return n.Detail || "What's new in Jellio";
  if (n.Kind === 'announcement') return 'From the server';
  if (n.Kind === 'manga') return n.Detail || 'New chapter';
  return n.Kind === 'episode' ? 'New episode' : 'Now streaming';
}

function openItem(n) {
  if (n.Kind === 'announcement' || n.Kind === 'whatsnew') return;
  hideNotificationsPanel();
  if (n.Kind === 'streamlink' || n.Kind === 'streamlink_removed') {
    navigateTo('#/livetv');
    return;
  }
  if (n.Kind === 'party_scheduled' || n.Kind === 'party_starting') {
    import('./groupWatch.js').then(function (m) {
      m.openGroupWatch();
    });
    return;
  }
  if (n.Kind === 'manga') {
    getMangaShelfHash().then(function (hash) {
      if (hash) navigateTo(hash + '&series=' + encodeURIComponent(String(n.SeriesKey || '').replace(/^s:/, '')));
    });
    return;
  }
  navigateTo('#/item?id=' + n.ItemId);
}

// An announcement's picture, shrunk server side; the token rides in the
// URL since an <img> can't send headers.
function announcementImageUrl(n) {
  if (!n.ImageId) return null;
  return getServerAddress() + '/Jellio/notifications/image/' + encodeURIComponent(n.ImageId) + '?ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

function buildRow(n) {
  const isAnnouncement = n.Kind === 'announcement';
  const isWhatsNew = n.Kind === 'whatsnew';
  const row = el(
    'div',
    'jellio-notifications-row' +
      (isAnnouncement ? ' jellio-notifications-row-announcement' : '') +
      (isWhatsNew ? ' jellio-notifications-row-whatsnew' : ''),
  );
  if (!isAnnouncement && !isWhatsNew) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', t('action_go_to', { name: n.Name || '' }));
  } else if (isWhatsNew) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', t('notifications_toggle_highlights'));
  }

  const poster = el('div', 'jellio-notifications-row-poster');
  if (isAnnouncement) {
    const icon = el('span', 'material-icons jellio-notifications-row-poster-icon campaign');
    icon.setAttribute('aria-hidden', 'true');
    poster.appendChild(icon);
  } else if (isWhatsNew) {
    const icon = el('span', 'material-icons jellio-notifications-row-poster-icon auto_awesome');
    icon.setAttribute('aria-hidden', 'true');
    poster.appendChild(icon);
  } else if (n.Kind === 'party_scheduled' || n.Kind === 'party_starting') {
    const icon = el('span', 'material-icons jellio-notifications-row-poster-icon celebration');
    icon.setAttribute('aria-hidden', 'true');
    poster.appendChild(icon);
  } else if (n.Kind === 'streamlink' || n.Kind === 'streamlink_removed') {
    const icon = el('span', 'material-icons jellio-notifications-row-poster-icon link_off');
    icon.setAttribute('aria-hidden', 'true');
    poster.appendChild(icon);
  } else {
    poster.style.backgroundImage =
      'url(' + (n.Kind === 'manga' && n.MangaId ? getStreamCoverUrl(n.MangaId) : getImageUrl(n.ItemId, 'Primary', { maxWidth: 200 })) + ')';
  }
  row.appendChild(poster);

  const text = el('div', 'jellio-notifications-row-text');
  text.appendChild(el('p', 'jellio-notifications-row-title', n.Name || ''));
  text.appendChild(el('p', 'jellio-notifications-row-meta', subtitleFor(n)));
  if (isWhatsNew && n.Highlights && n.Highlights.length) {
    const highlightsWrap = el('div', 'jellio-notifications-highlights');
    n.Highlights.forEach(function (h) {
      const item = el('div', 'jellio-notifications-highlight-item');
      item.appendChild(el('strong', 'jellio-notifications-highlight-title', h.title));
      item.appendChild(el('span', 'jellio-notifications-highlight-desc', ': ' + h.description));
      highlightsWrap.appendChild(item);
    });
    text.appendChild(highlightsWrap);
  }
  const imageUrl = isAnnouncement ? announcementImageUrl(n) : null;
  if (imageUrl) {
    const img = document.createElement('img');
    img.className = 'jellio-notifications-row-image';
    img.alt = '';
    img.loading = 'lazy';
    img.src = imageUrl;
    img.addEventListener('error', () => img.remove());
    text.appendChild(img);
  }
  row.appendChild(text);

  const deleteButton = el('button', 'jellio-notifications-row-delete');
  deleteButton.type = 'button';
  deleteButton.setAttribute('aria-label', t('notifications_dismiss'));
  const deleteIcon = el('span', 'material-icons close');
  deleteIcon.setAttribute('aria-hidden', 'true');
  deleteButton.appendChild(deleteIcon);
  deleteButton.addEventListener('click', function (event) {
    event.stopPropagation();
    removeOne(n.Id);
  });
  row.appendChild(deleteButton);

  if (!isAnnouncement && !isWhatsNew) {
    row.addEventListener('click', function () {
      openItem(n);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openItem(n);
      }
    });
  }

  return row;
}

function updateBadge() {
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.classList.toggle('jellio-sidebar-notifications-active', lastUnreadCount > 0);
}

function cancelHoverClose() {
  if (hoverCloseTimer) {
    window.clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
}

function scheduleHoverClose() {
  cancelHoverClose();
  hoverCloseTimer = window.setTimeout(hideNotificationsPanel, HOVER_CLOSE_DELAY_MS);
}

function showNotificationsPanel() {
  if (!panel) return;
  cancelHoverClose();
  panel.classList.add('jellio-notifications-panel-visible');
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.setAttribute('aria-expanded', 'true');
}

function render(items) {
  currentItems = items;
  lastUnreadCount = items.filter(function (n) {
    return !n.Read;
  }).length;
  updateBadge();

  if (!panel) return;

  const trigger = document.querySelector('.jellio-sidebar-notifications');
  if (trigger && !trigger.dataset.jellioNotificationsHoverBound) {
    trigger.dataset.jellioNotificationsHoverBound = '1';
    trigger.addEventListener('mouseenter', showNotificationsPanel);
    trigger.addEventListener('mouseleave', scheduleHoverClose);
  }

  panel.textContent = '';

  const header = el('div', 'jellio-notifications-header');
  header.appendChild(el('span', 'jellio-notifications-header-title', t('notifications_title')));
  if (items.length) {
    const clearButton = el('button', 'jellio-notifications-clear', t('notifications_clear_all'));
    clearButton.type = 'button';
    clearButton.addEventListener('click', clearAll);
    header.appendChild(clearButton);
  }
  panel.appendChild(header);

  if (!items.length) {
    panel.appendChild(el('div', 'jellio-notifications-empty', t('notifications_nothing_new')));
    return;
  }

  items.forEach(function (n) {
    panel.appendChild(buildRow(n));
  });
}

function removeOne(id) {
  if (id.startsWith('changelog:')) {
    markLatestChangelogSeen();
  }
  render(currentItems.filter(function (n) {
    return n.Id !== id;
  }));
  if (!id.startsWith('changelog:')) {
    deleteNotification(id).catch(function (err) {
      console.warn('Jellio: could not dismiss notification', err);
    });
  }
}

function clearAll() {
  markLatestChangelogSeen();
  render([]);
  clearAllNotifications().catch(function (err) {
    console.warn('Jellio: could not clear notifications', err);
  });
}

function poll() {
  Promise.all([getNotifications(), shouldShowChangelogNotification() ? loadChangelog() : null])
    .then(function (results) {
      const items = results[0];
      const changelog = results[1];
      // Clear out any previous or stale changelog notifications from the list
      let merged = items
        ? items.filter(function (n) {
            return !n.Id || !n.Id.startsWith('changelog:');
          })
        : [];
      if (changelog && shouldShowChangelogNotification()) {
        merged.unshift(changelog.getChangelogNotification());
      }
      if (knownIds) {
        // Clear any previous changelog IDs from knownIds so that an update with a new big release
        // changelog triggers a toast cleanly instead of being masked.
        for (const id of Array.from(knownIds)) {
          if (id.startsWith('changelog:') && id !== ('changelog:' + LATEST_BIG_CHANGELOG_VERSION)) {
            knownIds.delete(id);
          }
        }
        merged.forEach(function (n) {
          if (!knownIds.has(n.Id)) {
            showToast(
              messageFor(n),
              n.Kind === 'announcement' || n.Kind === 'whatsnew'
                ? undefined
                : function () {
                    openItem(n);
                  },
              { imageUrl: n.Kind === 'announcement' ? announcementImageUrl(n) : null },
            );
          }
        });
      }
      knownIds = new Set(
        merged.map(function (n) {
          return n.Id;
        }),
      );
      render(merged);
    })
    .catch(function () {
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

function createPanel() {
  panel = el('div', 'jellio-notifications-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', t('notifications_title'));
  panel.addEventListener('mouseenter', showNotificationsPanel);
  panel.addEventListener('mouseleave', scheduleHoverClose);
  document.body.appendChild(panel);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.classList.contains('jellio-notifications-panel-visible')) {
      hideNotificationsPanel();
      const trigger = document.querySelector('.jellio-sidebar-notifications');
      if (trigger) trigger.focus();
    }
  });
}

export function toggleNotificationsPanel() {
  if (!panel) return;
  cancelHoverClose();
  const visible = panel.classList.toggle('jellio-notifications-panel-visible');
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.setAttribute('aria-expanded', String(visible));
  if (visible && lastUnreadCount > 0) {
    lastUnreadCount = 0;
    updateBadge();
    markNotificationsRead().catch(function (err) {
      console.warn('Jellio: could not mark notifications read', err);
    });
  }
}

function hideNotificationsPanel() {
  cancelHoverClose();
  if (!panel) return;
  panel.classList.remove('jellio-notifications-panel-visible');
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.setAttribute('aria-expanded', 'false');
}

export function startNotifications() {
  if (started || !isAuthenticated()) return;
  started = true;
  createPanel();
  poll();
}

export function notificationsUnreadCount() {
  return lastUnreadCount;
}
