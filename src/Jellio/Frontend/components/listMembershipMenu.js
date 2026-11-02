import { t } from '../runtime/i18n.js';
import { toggleWatchlist } from './cardOptionsMenu.js';
import { ensureGrouplistIdsLoaded, isOnGrouplistSync, toggleGrouplist } from '../runtime/grouplistMembership.js';
import { el } from '../runtime/dom.js';

const MENU_ID = 'jellioListMembershipMenu';

export function isInsideListMembershipMenu(target) {
  const menu = document.getElementById(MENU_ID);
  if (!menu) return false;
  if (menu.contains(target)) return true;
  return menu.contains(document.activeElement);
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
  if (!document.getElementById(MENU_ID)) return;
  if (isInsideListMembershipMenu(event.target)) return;
  closeMenu();
}

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
    grouplistRow.appendChild(el('span', 'jellio-list-membership-row-label', t('settings_grouplist_label')));
  });

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeydown);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}
