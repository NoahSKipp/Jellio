// Only ever opens once runtime/grouplistSettings.js's own
// isGrouplistEnabled() is on: components/card.js's own watchlist
// button and screens/detail.js's own version of it both call this
// instead of toggling Watchlist directly the instant that setting is
// on, real feedback's own explicit ask for a way to add to either or
// both without two separate real actions. Off, both buttons keep
// their own plain instant toggle, unchanged, real feedback's own
// explicit ask too: a reader who never turns Grouplist on should see
// nothing different at all.
import { toggleWatchlist } from './cardOptionsMenu.js';
import { ensureGrouplistIdsLoaded, isOnGrouplistSync, toggleGrouplist } from '../runtime/grouplistMembership.js';

const MENU_ID = 'jellioListMembershipMenu';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function closeMenu() {
  const existing = document.getElementById(MENU_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('pointerdown', handleOutsideClick, true);
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeMenu();
}

function handleOutsideClick(event) {
  const menu = document.getElementById(MENU_ID);
  if (menu && !menu.contains(event.target)) closeMenu();
}

// Same real clamp-to-viewport shape components/cardOptionsMenu.js's
// own positionMenu already uses, short enough not to share rather than
// import a private helper across files for eight lines.
function positionMenu(menu, anchorRect) {
  const menuWidth = 220;
  let left = anchorRect.left;
  if (left + menuWidth > window.innerWidth - 16) {
    left = window.innerWidth - menuWidth - 16;
  }
  const top = anchorRect.bottom + 6;
  menu.style.left = Math.max(16, left) + 'px';
  menu.style.top = top + 'px';
}

// Stays open after a click, real reason a menu of one-shot actions
// (components/cardOptionsMenu.js's own) closes on click and this does
// not: checking Watchlist should not need reopening this to also
// check Grouplist.
function buildToggleOption(label, checked, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-list-membership-row';
  button.setAttribute('role', 'menuitemcheckbox');
  button.setAttribute('aria-checked', String(checked));

  function paint(isChecked) {
    button.setAttribute('aria-checked', String(isChecked));
    button.textContent = '';
    button.appendChild(el('span', 'material-icons ' + (isChecked ? 'check_box' : 'check_box_outline_blank')));
    button.appendChild(el('span', 'jellio-list-membership-row-label', label));
  }
  paint(checked);

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    button.disabled = true;
    onToggle()
      .then(function (nowChecked) {
        paint(nowChecked);
      })
      .catch(function (err) {
        console.warn('Jellio: could not update list membership', err);
      })
      .finally(function () {
        button.disabled = false;
      });
  });

  return button;
}

export function openListMembershipMenu(item, anchorRect, onChanged) {
  closeMenu();

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  // Same real floating card shell components/cardOptionsMenu.js's own
  // menu already uses, css/app.css has no reason to draw it twice.
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionMenu(menu, anchorRect);

  menu.appendChild(
    buildToggleOption(
      'Watchlist',
      !!(item.UserData && item.UserData.IsFavorite),
      function () {
        return toggleWatchlist(item, onChanged).then(function () {
          return !!(item.UserData && item.UserData.IsFavorite);
        });
      },
    ),
  );

  // Painted false until ensureGrouplistIdsLoaded() below actually
  // resolves (a reader opening this for the very first time this
  // session), repainted the moment it does rather than making every
  // click wait on that real round trip first.
  const grouplistRow = buildToggleOption(
    'Grouplist',
    isOnGrouplistSync(item.Id),
    function () {
      return toggleGrouplist(item.Id).then(function () {
        return isOnGrouplistSync(item.Id);
      });
    },
  );
  menu.appendChild(grouplistRow);
  ensureGrouplistIdsLoaded().then(function () {
    if (!grouplistRow.isConnected) return;
    grouplistRow.setAttribute('aria-checked', String(isOnGrouplistSync(item.Id)));
    grouplistRow.textContent = '';
    grouplistRow.appendChild(el('span', 'material-icons ' + (isOnGrouplistSync(item.Id) ? 'check_box' : 'check_box_outline_blank')));
    grouplistRow.appendChild(el('span', 'jellio-list-membership-row-label', 'Grouplist'));
  });

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeydown);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}
