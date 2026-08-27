// Watchlist release notifications: Jellio's own NotificationsController,
// one real notification the first day a Watchlist entry's own release
// date actually arrives (a movie's digital release, an episode's own air
// date), persisted per user server side the same way components/
// nowPlaying.js's own sessions are polled rather than pushed. Self
// starting, module level singleton (an ES module only ever runs once),
// same real reason that file's own header already gives for its own poll
// loop and panel existing for the life of the page rather than being
// rebuilt on every sidebar render.
import { getNotifications, markNotificationsRead, deleteNotification, clearAllNotifications, getImageUrl } from '../runtime/api.js';
import { isAuthenticated } from '../runtime/auth.js';
import { navigateTo } from '../runtime/router.js';
import { showToast } from './toast.js';

// A release date changes once a day at most, real reason this polls far
// less often than components/nowPlaying.js's own 10s (a live session can
// genuinely change every few seconds, this cannot).
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let panel = null;
let started = false;
let lastUnreadCount = 0;
let currentItems = [];
// null until the first real poll resolves: every notification already
// sitting there on a fresh page load is not "new" the reader has not
// seen, it is history, and toasting the reader's own entire backlog the
// instant the app opens would read as broken, not helpful.
let knownIds = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function messageFor(n) {
  if (n.Kind === 'episode') {
    return n.Name + (n.Detail ? ' ' + n.Detail : '') + ' is out now';
  }
  return n.Name + ' is available to watch';
}

function subtitleFor(n) {
  return n.Kind === 'episode' ? 'New episode' : 'Now streaming';
}

function openItem(n) {
  hideNotificationsPanel();
  navigateTo('#/item?id=' + n.ItemId);
}

function buildRow(n) {
  const row = el('div', 'jellio-notifications-row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', 'Go to ' + (n.Name || 'title'));

  const poster = el('div', 'jellio-notifications-row-poster');
  poster.style.backgroundImage = 'url(' + getImageUrl(n.ItemId, 'Primary', { maxWidth: 200 }) + ')';
  row.appendChild(poster);

  const text = el('div', 'jellio-notifications-row-text');
  text.appendChild(el('p', 'jellio-notifications-row-title', n.Name || ''));
  text.appendChild(el('p', 'jellio-notifications-row-meta', subtitleFor(n)));
  row.appendChild(text);

  const deleteButton = el('button', 'jellio-notifications-row-delete');
  deleteButton.type = 'button';
  deleteButton.setAttribute('aria-label', 'Dismiss this notification');
  const deleteIcon = el('span', 'material-icons close');
  deleteIcon.setAttribute('aria-hidden', 'true');
  deleteButton.appendChild(deleteIcon);
  // stopPropagation rather than a separate real element outside the
  // row: the row's own click already navigates, and a reader dismissing
  // one notification almost never also means "and take me to that title".
  deleteButton.addEventListener('click', function (event) {
    event.stopPropagation();
    removeOne(n.Id);
  });
  row.appendChild(deleteButton);

  row.addEventListener('click', function () {
    openItem(n);
  });
  row.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openItem(n);
    }
  });

  return row;
}

function updateBadge() {
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.classList.toggle('jellio-sidebar-notifications-active', lastUnreadCount > 0);
}

function render(items) {
  currentItems = items;
  lastUnreadCount = items.filter(function (n) {
    return !n.Read;
  }).length;
  updateBadge();

  if (!panel) return;
  panel.textContent = '';

  const header = el('div', 'jellio-notifications-header');
  header.appendChild(el('span', 'jellio-notifications-header-title', 'Notifications'));
  if (items.length) {
    const clearButton = el('button', 'jellio-notifications-clear', 'Clear all');
    clearButton.type = 'button';
    clearButton.addEventListener('click', clearAll);
    header.appendChild(clearButton);
  }
  panel.appendChild(header);

  if (!items.length) {
    panel.appendChild(el('div', 'jellio-notifications-empty', 'Nothing new'));
    return;
  }

  items.forEach(function (n) {
    panel.appendChild(buildRow(n));
  });
}

// Removed from the list on click, same optimistic-then-reconcile shape
// components/cardOptionsMenu.js's own watchlist/watched toggles already
// use, rather than waiting on the real round trip to update anything a
// reader can see.
function removeOne(id) {
  render(currentItems.filter(function (n) {
    return n.Id !== id;
  }));
  deleteNotification(id).catch(function (err) {
    console.warn('Jellio: could not dismiss notification', err);
  });
}

function clearAll() {
  render([]);
  clearAllNotifications().catch(function (err) {
    console.warn('Jellio: could not clear notifications', err);
  });
}

function poll() {
  getNotifications()
    .then(function (items) {
      if (knownIds) {
        items.forEach(function (n) {
          if (!knownIds.has(n.Id)) {
            showToast(messageFor(n), function () {
              openItem(n);
            });
          }
        });
      }
      knownIds = new Set(
        items.map(function (n) {
          return n.Id;
        }),
      );
      render(items);
    })
    .catch(function () {
      // Leave whatever was last shown, same real tolerance
      // components/nowPlaying.js's own poll() already has for a failed
      // request: it will try again on the next tick.
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

function createPanel() {
  panel = el('div', 'jellio-notifications-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(panel);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.classList.contains('jellio-notifications-panel-visible')) {
      hideNotificationsPanel();
      const trigger = document.querySelector('.jellio-sidebar-notifications');
      if (trigger) trigger.focus();
    }
  });
}

// Real feedback's own explicit ask: the unread marker disappears the
// instant this panel opens, not once a round trip to actually persist
// that confirms it. markNotificationsRead() still fires so the next
// poll (and the next real session on another device) agrees, but
// nothing here waits on it.
export function toggleNotificationsPanel() {
  if (!panel) return;
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

export function hideNotificationsPanel() {
  if (!panel) return;
  panel.classList.remove('jellio-notifications-panel-visible');
  const button = document.querySelector('.jellio-sidebar-notifications');
  if (button) button.setAttribute('aria-expanded', 'false');
}

// Called from app.js's own sync() once a session is confirmed
// authenticated, not at module load, same real reason components/
// nowPlaying.js's own startNowPlaying() already waits for that too.
export function startNotifications() {
  if (started || !isAuthenticated()) return;
  started = true;
  createPanel();
  poll();
}

export function notificationsUnreadCount() {
  return lastUnreadCount;
}
