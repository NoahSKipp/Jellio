// Small popover listing the reader's own real libraries, opened from
// components/mobileNav.js's own single consolidated Library button: a
// phone's own pill bar has no real room for Movies/Shows/Anime/every
// other real library as separate buttons the way components/sidebar.js's
// own rail still shows them, real feedback asked for one icon there
// instead, tapping into this same real link set rather than a second,
// narrower one. Reuses components/cardOptionsMenu.js's own real popover
// chrome (.jellio-card-options-menu/-item), the same glass sheet shape
// already established for a small anchored choice list, not a second
// one invented here.
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

// Anchored above the tapped button and centred on it, not below like
// components/cardOptionsMenu.js's own real anchor: that one opens off a
// card sitting in the middle of the page, this one opens off a button
// pinned to the real bottom of the screen, downward would run straight
// off the real viewport.
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
  // One tick late and capturing, same real reasoning components/
  // cardOptionsMenu.js's own header documents: the same pointerdown
  // that just opened this menu should not immediately close it again
  // on its own way through document.
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}
