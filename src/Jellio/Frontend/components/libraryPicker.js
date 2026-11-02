import { buildIconElement } from './navShared.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const MENU_ID = 'jellioLibraryPickerMenu';

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

function positionMenu(menu, anchorRect) {
  const menuWidth = 200;
  let left = anchorRect.left + anchorRect.width / 2 - menuWidth / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - menuWidth - 16));
  menu.style.left = left + 'px';
  menu.style.bottom = window.innerHeight - anchorRect.top + 10 + 'px';
  menu.style.width = menuWidth + 'px';
}

export function openLibraryPicker(links, anchorRect) {
  closeMenu();
  if (!links || !links.length) return;

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionMenu(menu, anchorRect);

  links.forEach(function (link) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jellio-card-options-item';
    button.appendChild(el('span', 'jellio-card-options-item-label', link.label));
    button.appendChild(buildIconElement(link.icon));
    button.addEventListener('click', function () {
      closeMenu();
      navigateTo(link.hash);
    });
    menu.appendChild(button);
  });

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeydown);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}
