import { t } from '../runtime/i18n.js';
import { setFriendMuted, removeFriend } from '../runtime/api.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

const MENU_ID = 'jellioFriendMenu';
const CONFIRM_ID = 'jellioFriendConfirm';

function closeMenu() {
  const existing = document.getElementById(MENU_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onMenuKey);
  document.removeEventListener('pointerdown', onOutside, true);
}

function onMenuKey(event) {
  if (event.key === 'Escape') closeMenu();
}

function onOutside(event) {
  const menu = document.getElementById(MENU_ID);
  if (menu && !menu.contains(event.target)) closeMenu();
}

function closeConfirm(restoreFocus) {
  const existing = document.getElementById(CONFIRM_ID);
  if (existing) existing.remove();
  if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
}

// Resolves true when the reader confirms removing the friend.
export function confirmRemoveFriend(name, returnFocus) {
  closeConfirm();
  return new Promise(function (resolve) {
    const overlay = el('div', 'jellio-avatar-picker-overlay');
    overlay.id = CONFIRM_ID;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('friends_remove_title', { name }));
    const panel = el('div', 'jellio-avatar-picker-panel jellio-friend-confirm');
    panel.appendChild(el('h2', 'jellio-avatar-picker-title', t('friends_remove_title', { name })));
    panel.appendChild(el('p', 'jellio-friend-confirm-text', t('friends_remove_body')));
    const actions = el('div', 'jellio-friend-confirm-actions');
    const cancel = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('profile_cancel'));
    cancel.type = 'button';
    const confirm = el('button', 'jellio-settings-button', t('friends_remove'));
    confirm.type = 'button';
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      closeConfirm(returnFocus);
      resolve(value);
    }
    cancel.addEventListener('click', function () { done(false); });
    confirm.addEventListener('click', function () { done(true); });
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) done(false);
    });
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') done(false);
    });
    cancel.focus();
  });
}

// The small Mute / Remove menu for a friend. `friend` needs UserId,
// UserName and Muted; callbacks get the new state after the server agrees.
export function openFriendMenu(friend, anchor, callbacks) {
  closeMenu();
  const cb = callbacks || {};
  const menu = el('div', 'jellio-card-options-menu jellio-friend-menu');
  menu.id = MENU_ID;
  menu.setAttribute('role', 'menu');

  function option(label, icon, onClick, danger) {
    const button = el('button', 'jellio-card-options-item' + (danger ? ' jellio-card-options-item-danger' : ''));
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.appendChild(el('span', 'jellio-card-options-item-label', label));
    button.appendChild(el('span', 'material-icons jellio-card-options-item-icon ' + icon));
    button.addEventListener('click', function () {
      closeMenu();
      onClick();
    });
    return button;
  }

  menu.appendChild(
    option(friend.Muted ? t('friends_unmute') : t('friends_mute'), friend.Muted ? 'notifications_active' : 'notifications_off', function () {
      const next = !friend.Muted;
      setFriendMuted(friend.UserId, next).then(
        function () {
          friend.Muted = next;
          if (cb.onMuted) cb.onMuted(next);
          showToast(next ? t('friends_muted_toast', { name: friend.UserName }) : t('friends_unmuted_toast', { name: friend.UserName }));
        },
        function (err) {
          console.warn('Jellio: could not change mute', err);
          showToast(t('friends_error_generic'));
        },
      );
    }),
  );
  menu.appendChild(
    option(t('friends_remove'), 'person_remove', function () {
      confirmRemoveFriend(friend.UserName, anchor).then(function (ok) {
        if (!ok) return;
        removeFriend(friend.UserId).then(
          function () {
            if (cb.onRemoved) cb.onRemoved();
          },
          function (err) {
            console.warn('Jellio: could not remove friend', err);
            showToast(t('friends_error_generic'));
          },
        );
      });
    }, true),
  );

  const rect = anchor.getBoundingClientRect();
  const width = 220;
  let left = rect.right - width;
  if (left < 16) left = 16;
  if (left + width > window.innerWidth - 16) left = window.innerWidth - width - 16;
  menu.style.left = left + 'px';
  menu.style.top = rect.bottom + 6 + 'px';
  menu.style.minWidth = width + 'px';
  document.body.appendChild(menu);
  document.addEventListener('keydown', onMenuKey);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', onOutside, true);
  }, 0);
  const first = menu.querySelector('button');
  if (first) first.focus();
}
