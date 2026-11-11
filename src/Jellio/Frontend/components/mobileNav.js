import { t } from '../runtime/i18n.js';
import { getPrimaryNavLinks, isActive, buildIconElement, buildAvatarIconMount, SETTINGS_LINK, FIXED_NAV_LINKS } from './navShared.js';
import { getCurrentUser, friendsSupported, friendsIncomingCount } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { openAccountSwitcher } from './accountSwitcher.js';
import { openLibraryPicker } from './libraryPicker.js';

const COMPACT_SCROLL_TOP = 16;
const EXPAND_SCROLL_TOP = 4;

function buildLink(link) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.jellioHash = link.hash;
  const active = isActive(link.hash);
  button.className = 'jellio-mobile-nav-link' + (active ? ' jellio-mobile-nav-link-active' : '');
  button.setAttribute('aria-label', link.label);
  if (active) button.setAttribute('aria-current', 'page');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(buildIconElement(link.icon));
  button.appendChild(iconWrap);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-mobile-nav-label';
  labelEl.textContent = link.label;
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    navigateTo(link.hash);
  });
  return button;
}

function buildLibraryButton(links) {
  const button = document.createElement('button');
  button.type = 'button';
  const activeHash = links.filter(function (link) {
    return isActive(link.hash);
  })[0];
  button.dataset.jellioHashGroup = JSON.stringify(
    links.map(function (link) {
      return link.hash;
    }),
  );
  button.className = 'jellio-mobile-nav-link' + (activeHash ? ' jellio-mobile-nav-link-active' : '');
  button.setAttribute('aria-label', t('nav_library'));
  if (activeHash) button.setAttribute('aria-current', 'page');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(buildIconElement('library'));
  button.appendChild(iconWrap);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-mobile-nav-label';
  labelEl.textContent = t('nav_library');
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    openLibraryPicker(links, button.getBoundingClientRect());
  });
  return button;
}

function updateActiveLinks(container) {
  container.querySelectorAll('[data-jellio-hash]').forEach(function (link) {
    const active = isActive(link.dataset.jellioHash);
    link.classList.toggle('jellio-mobile-nav-link-active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  container.querySelectorAll('[data-jellio-hash-group]').forEach(function (link) {
    const hashes = JSON.parse(link.dataset.jellioHashGroup);
    const active = hashes.some(isActive);
    link.classList.toggle('jellio-mobile-nav-link-active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-mobile-nav-link';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(await buildAvatarIconMount());
  button.appendChild(iconWrap);

  let name = t('nav_profile');
  try {
    const user = await getCurrentUser();
    if (user && user.Name) name = user.Name;
  } catch (err) {
    // Falls back to the generic label, not fatal to the rest of the pill.
  }
  button.setAttribute('aria-label', name);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-mobile-nav-label';
  labelEl.textContent = name;
  button.appendChild(labelEl);

  // A dot when friend requests wait; People itself sits in this menu.
  const dot = document.createElement('span');
  dot.className = 'jellio-mobile-nav-dot';
  dot.setAttribute('aria-hidden', 'true');
  iconWrap.appendChild(dot);
  function syncDot() {
    button.classList.toggle('jellio-has-requests', friendsIncomingCount() > 0 && friendsSupported() === true);
  }
  syncDot();
  document.addEventListener('jellio:friends-changed', syncDot);

  button.addEventListener('click', function () {
    openAccountSwitcher();
  });
  return button;
}

let scrollTarget = null;
let scrollHandler = null;
let scrollTicking = false;

function attachScrollCompact(nav) {
  const content = document.querySelector('.jellio-content');
  if (!content || content === scrollTarget) return;

  if (scrollTarget && scrollHandler) {
    scrollTarget.removeEventListener('scroll', scrollHandler);
  }

  scrollTarget = content;
  scrollHandler = function () {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(function () {
      scrollTicking = false;
      const top = content.scrollTop;
      if (top > COMPACT_SCROLL_TOP) {
        nav.classList.add('jellio-mobile-nav-compact');
      } else if (top < EXPAND_SCROLL_TOP) {
        nav.classList.remove('jellio-mobile-nav-compact');
      }
    });
  };
  content.addEventListener('scroll', scrollHandler, { passive: true });
}

export async function renderMobileNav(container) {
  if (container.dataset.jellioBuilt === '1') {
    container.classList.remove('jellio-mobile-nav-compact');
    updateActiveLinks(container);
    attachScrollCompact(container);
    return;
  }
  container.dataset.jellioBuilt = '1';
  container.textContent = '';
  container.className = 'jellio-mobile-nav-mount jellio-mobile-nav';

  const scroller = document.createElement('div');
  scroller.className = 'jellio-mobile-nav-scroll';
  container.appendChild(scroller);

  FIXED_NAV_LINKS.forEach(function (link) {
    scroller.appendChild(buildLink(link));
  });

  const settingsLink = buildLink(SETTINGS_LINK);
  scroller.appendChild(settingsLink);

  getPrimaryNavLinks()
    .then(function (links) {
      const libraryLinks = links.slice(FIXED_NAV_LINKS.length);
      if (libraryLinks.length) {
        scroller.insertBefore(buildLibraryButton(libraryLinks), settingsLink);
      }
    })
    .catch(function (err) {
      console.warn('Jellio: mobile nav library links failed', err);
    });

  buildProfileButton()
    .then(function (button) {
      scroller.appendChild(button);
    })
    .catch(function (err) {
      console.warn('Jellio: mobile nav profile button failed', err);
    });

  attachScrollCompact(container);
}
