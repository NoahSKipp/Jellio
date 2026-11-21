import { t } from '../runtime/i18n.js';
import {
  addToReadingList,
  removeFromReadingList,
  loadReadingListKeys,
  isOnReadingList,
  readingListSupported,
  friendsSupported,
  getFriendsSnapshot,
  loadFriends,
} from '../runtime/api.js';
import { readingErrorKey } from '../runtime/readingListHelpers.js';
import { navigateTo } from '../runtime/router.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

// Warms the key set so toggles know their state; resolves false when the
// server has no reading list.
export function ensureReadingListKeys() {
  return loadReadingListKeys().then(
    function () {
      return true;
    },
    function () {
      return readingListSupported() !== false;
    },
  );
}

// Adds or removes and says so; resolves with the new state (true = on the
// list). A refusal shows its message and rejects.
export function toggleReadingList(target) {
  const on = isOnReadingList(target.Key);
  const request = on ? removeFromReadingList(target.Key) : addToReadingList(target);
  return request.then(
    function () {
      showToast(t(on ? 'reading_toast_removed' : 'reading_toast_added'));
      return !on;
    },
    function (err) {
      console.warn('Jellio: could not update the reading list', err);
      showToast(t(readingErrorKey(err)));
      throw err;
    },
  );
}

// Opens the friend picker for a reading item (components/friendPicker.js);
// with no friends yet it leads to finding some instead.
export function shareReadingTarget(target, trigger) {
  const snapshot = getFriendsSnapshot();
  if (snapshot && !snapshot.Friends.length) {
    navigateTo('#/people?tab=find');
    return Promise.resolve();
  }
  return import('./friendPicker.js').then(function (m) {
    m.openFriendPicker({ Name: target.Title, Reading: target }, trigger);
  });
}

function listenForChanges(button, repaint) {
  function onChange() {
    if (!button.isConnected) {
      document.removeEventListener('jellio:readinglist-changed', onChange);
      return;
    }
    repaint();
  }
  document.addEventListener('jellio:readinglist-changed', onChange);
}

// The add/remove control for a detail page or a Discover card. `getTarget`
// returns the target from readingListHelpers (or null while unknown);
// `activeClass` marks it as on the list.
export function buildReadingToggle(getTarget, className, activeClass) {
  const button = el('button', className);
  button.type = 'button';
  button.hidden = true;
  const icon = el('span', 'material-icons');
  button.appendChild(icon);

  function paint() {
    const target = getTarget();
    const on = !!(target && isOnReadingList(target.Key));
    icon.className = 'material-icons ' + (on ? 'bookmark_added' : 'bookmark_add');
    const label = t(on ? 'reading_remove' : 'reading_add');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (activeClass) button.classList.toggle(activeClass, on);
  }

  let pending = false;
  button.addEventListener('click', function (event) {
    event.stopPropagation();
    const target = getTarget();
    if (!target || pending) return;
    pending = true;
    toggleReadingList(target)
      .catch(function () {})
      .finally(function () {
        pending = false;
        paint();
      });
  });

  ensureReadingListKeys().then(function (ok) {
    button.hidden = !ok;
    paint();
  });
  listenForChanges(button, paint);
  return button;
}

// "Add to a friend's reading list"; hidden until friends are known to work.
export function buildReadingFriendButton(getTarget, className) {
  const button = el('button', className);
  button.type = 'button';
  button.hidden = true;
  const icon = el('span', 'material-icons');
  button.appendChild(icon);

  function paint() {
    const snapshot = getFriendsSnapshot();
    button.hidden = friendsSupported() === false || !snapshot || readingListSupported() === false;
    if (button.hidden) return;
    const hasFriends = snapshot.Friends.length > 0;
    const label = hasFriends ? t('reading_menu_add_to_friend') : t('friends_menu_find');
    button.title = label;
    button.setAttribute('aria-label', label);
    icon.className = 'material-icons ' + (hasFriends ? 'person_add' : 'group_add');
  }

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    const target = getTarget();
    if (!target) return;
    shareReadingTarget(target, button).catch(function (err) {
      console.warn('Jellio: could not open the friend picker', err);
    });
  });

  loadFriends().then(paint, function () {});
  paint();
  listenForChanges(button, paint);
  document.addEventListener('jellio:friends-changed', function onFriends() {
    if (!button.isConnected) {
      document.removeEventListener('jellio:friends-changed', onFriends);
      return;
    }
    paint();
  });
  return button;
}

// Menu entries for a card: the toggle, and the friend entry once friends
// have loaded. `target` may be null (nothing to offer then).
export function readingMenuOptions(target) {
  if (!target || readingListSupported() === false) return [];
  ensureReadingListKeys();
  const on = isOnReadingList(target.Key);
  const options = [
    {
      label: t(on ? 'reading_remove' : 'reading_add'),
      icon: on ? 'bookmark_added' : 'bookmark_add',
      onClick: function () {
        toggleReadingList(target).catch(function () {});
      },
    },
  ];
  if (friendsSupported() !== false) {
    const friends = getFriendsSnapshot();
    if (!friends) {
      loadFriends().catch(function () {});
    } else {
      options.push({
        label: friends.Friends.length ? t('reading_menu_add_to_friend') : t('friends_menu_find'),
        icon: friends.Friends.length ? 'person_add' : 'group_add',
        onClick: function () {
          shareReadingTarget(target).catch(function (err) {
            console.warn('Jellio: could not open the friend picker', err);
          });
        },
      });
    }
  }
  return options;
}

// The two small buttons over a Discover cover: add to the reading list and
// add to a friend's list. Hidden while unknown or unsupported.
export function buildDiscoverActions(getTarget) {
  const wrap = el('div', 'jellio-discover-card-actions');
  wrap.appendChild(buildReadingToggle(getTarget, 'jellio-discover-card-action', 'jellio-discover-card-action-active'));
  wrap.appendChild(buildReadingFriendButton(getTarget, 'jellio-discover-card-action'));
  return wrap;
}
