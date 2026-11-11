import { t } from '../runtime/i18n.js';
import { loadFriends, addToFriendsWatchlists } from '../runtime/api.js';
import { resultMessageKey, resultTone, friendMatches } from '../runtime/friendsHelpers.js';
import { buildFriendAvatar } from './friendAvatar.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioFriendPicker';
const SEARCH_THRESHOLD = 8;
const MAX_RECIPIENTS = 20;
const TONE_ICON = { ok: 'check_circle', info: 'info', warn: 'error_outline' };

let returnFocus = null;

function close() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', onKey, true);
  if (returnFocus && returnFocus.focus && returnFocus.isConnected) returnFocus.focus();
  returnFocus = null;
}

function onKey(event) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(overlay.querySelectorAll('button, input, [tabindex="0"]')).filter(function (n) {
    return !n.disabled && n.offsetParent !== null;
  });
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// The dialog for sending a Movie or Series to friends' watchlists.
export function openFriendPicker(item, trigger) {
  close();
  returnFocus = trigger || document.activeElement;

  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('friends_picker_title'));
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  const panel = el('div', 'jellio-avatar-picker-panel jellio-friend-picker');
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', t('friends_picker_title')));
  panel.appendChild(el('p', 'jellio-friend-picker-item', item.Name || ''));
  const body = el('div', 'jellio-friend-picker-body');
  panel.appendChild(body);
  const footer = el('div', 'jellio-friend-confirm-actions');
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);

  const closeButton = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('friends_picker_close'));
  closeButton.type = 'button';
  closeButton.addEventListener('click', close);
  footer.appendChild(closeButton);
  body.appendChild(el('div', 'jellio-screen-spinner'));

  loadFriends().then(
    function (data) {
      if (!overlay.isConnected) return;
      if (!data.Friends.length) {
        paintNoFriends();
        return;
      }
      paintSelect(data.Friends);
    },
    function () {
      if (!overlay.isConnected) return;
      body.textContent = '';
      body.appendChild(el('p', 'jellio-friend-picker-note', t('friends_error_generic')));
    },
  );

  function paintNoFriends() {
    body.textContent = '';
    body.appendChild(el('p', 'jellio-friend-picker-note', t('friends_picker_none')));
    const find = el('button', 'jellio-settings-button', t('friends_find_link'));
    find.type = 'button';
    find.addEventListener('click', function () {
      returnFocus = null;
      close();
      navigateTo('#/people?tab=find');
    });
    footer.insertBefore(find, closeButton);
    find.focus();
  }

  function paintSelect(friends) {
    body.textContent = '';
    const selected = new Set();
    let filter = '';

    const send = el('button', 'jellio-settings-button', t('friends_picker_send'));
    send.type = 'button';
    send.disabled = true;
    footer.insertBefore(send, closeButton);

    let search = null;
    if (friends.length > SEARCH_THRESHOLD) {
      search = el('input', 'jellio-settings-input jellio-friend-picker-search');
      search.type = 'search';
      search.placeholder = t('friends_search_friends');
      search.setAttribute('aria-label', t('friends_search_friends'));
      search.autocomplete = 'off';
      body.appendChild(search);
    }
    const list = el('ul', 'jellio-friend-picker-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', t('friends_picker_title'));
    body.appendChild(list);
    const empty = el('p', 'jellio-friend-picker-note', t('friends_find_none_title'));
    empty.hidden = true;
    body.appendChild(empty);

    function updateSend() {
      send.disabled = selected.size === 0;
      send.textContent = selected.size ? t('friends_picker_send_count', { count: selected.size }) : t('friends_picker_send');
    }

    const rows = friends.map(function (friend) {
      const li = el('li', 'jellio-friend-picker-row');
      const label = el('label', 'jellio-friend-picker-label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'jellio-friend-picker-check';
      box.addEventListener('change', function () {
        if (box.checked && selected.size >= MAX_RECIPIENTS) {
          box.checked = false;
          return;
        }
        if (box.checked) selected.add(friend.UserId);
        else selected.delete(friend.UserId);
        li.classList.toggle('jellio-friend-picker-row-on', box.checked);
        updateSend();
      });
      label.appendChild(box);
      label.appendChild(buildFriendAvatar(friend, 'jellio-people-avatar', 96));
      label.appendChild(el('span', 'jellio-people-name', friend.UserName || ''));
      li.appendChild(label);
      list.appendChild(li);
      return { friend: friend, li: li };
    });

    if (search) {
      search.addEventListener('input', function () {
        filter = search.value;
        let shown = 0;
        rows.forEach(function (r) {
          const match = friendMatches(r.friend, filter);
          r.li.hidden = !match;
          if (match) shown++;
        });
        empty.hidden = shown !== 0;
      });
      search.focus();
    } else {
      const firstBox = list.querySelector('input');
      if (firstBox) firstBox.focus();
    }

    send.addEventListener('click', function () {
      const ids = Array.from(selected);
      send.disabled = true;
      send.textContent = t('status_loading');
      addToFriendsWatchlists(item.Id, ids).then(
        function (results) {
          if (!overlay.isConnected) return;
          paintResults(friends, results);
          send.remove();
        },
        function (err) {
          console.warn('Jellio: could not send to friends', err);
          updateSend();
          let note = body.querySelector('.jellio-friend-picker-error');
          if (!note) {
            note = el('p', 'jellio-friend-picker-note jellio-friend-picker-error');
            note.setAttribute('role', 'alert');
            body.appendChild(note);
          }
          note.textContent = t(err && err.status === 429 ? 'friends_result_limit' : 'friends_error_generic');
        },
      );
    });
  }

  function paintResults(friends, results) {
    body.textContent = '';
    const byId = new Map(
      friends.map(function (f) {
        return [String(f.UserId).toLowerCase(), f];
      }),
    );
    const list = el('ul', 'jellio-friend-picker-list jellio-friend-picker-results');
    list.setAttribute('aria-live', 'polite');
    results.forEach(function (entry) {
      const friend = byId.get(String(entry.UserId).toLowerCase()) || { UserId: entry.UserId, UserName: '' };
      const tone = resultTone(entry.Result);
      const li = el('li', 'jellio-friend-picker-row jellio-friend-picker-result jellio-friend-picker-result-' + tone);
      li.appendChild(buildFriendAvatar(friend, 'jellio-people-avatar', 96));
      const text = el('span', 'jellio-people-text');
      text.appendChild(el('span', 'jellio-people-name', friend.UserName || ''));
      text.appendChild(el('span', 'jellio-people-sub', t(resultMessageKey(entry.Result))));
      li.appendChild(text);
      li.appendChild(el('span', 'material-icons jellio-friend-picker-result-icon', TONE_ICON[tone]));
      list.appendChild(li);
    });
    body.appendChild(list);
    closeButton.textContent = t('friends_picker_done');
    closeButton.classList.remove('jellio-settings-button-secondary');
    closeButton.focus();
  }
}
