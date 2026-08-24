// Floating pill nav for a real phone width (css/app.css's own
// breakpoint hides this in favour of components/sidebar.js's own rail
// above it; a tablet keeps the rail, real feedback asked for the pill
// specifically on "mobile", not just any narrow window). Link set,
// icons and the profile avatar all come from components/navShared.js,
// the one real source components/sidebar.js also builds from. Group
// Watch and Now Playing are deliberately not here: real feedback asked
// for both gone on a phone specifically, screen space neither buys
// enough use to spend here. The sidebar rail still carries both.
import { getPrimaryNavLinks, isActive, buildIconElement, buildAvatarIconMount, SETTINGS_LINK } from './navShared.js';
import { navigateTo } from '../runtime/router.js';

// Hysteresis rather than one shared threshold: a single cutoff flickers
// compact/expanded back and forth for a scroll position sitting right
// on it, real feedback wanted this "fast reactive", not jittery.
const COMPACT_SCROLL_TOP = 48;
const EXPAND_SCROLL_TOP = 12;

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
}

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-mobile-nav-link';
  button.setAttribute('aria-label', 'Profile');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(await buildAvatarIconMount());
  button.appendChild(iconWrap);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-mobile-nav-label';
  labelEl.textContent = 'Profile';
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    navigateTo('#/account');
  });
  return button;
}

// .jellio-content is the real scroll container this whole app scrolls
// inside (its own overflow-y: auto, not the window), so that is what a
// scroll driven compact state has to listen on. That element is a
// long lived node reused across navigations (only a real self-heal
// rebuild in app.js's own getRoot() ever replaces it), so this only
// needs to run again when it actually has: the identity check below
// skips every ordinary call.
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

// Built once per real container and left alone after that, the same
// real reasoning components/sidebar.js's own header documents: a
// dataset marker tells a real rebuild (the mount was genuinely
// missing) apart from the ordinary case (the same container coming
// back on ever navigation), and everything that can change after the
// first build (which link is active, the profile avatar) already has
// its own live update path. Reset to expanded on every real call
// rather than only the first: a fresh screen starts scrolled to its
// own top, so the pill should too, rather than staying compact from
// wherever the reader scrolled to on the last one.
export async function renderMobileNav(container) {
  if (container.dataset.jellioBuilt === '1') {
    container.classList.remove('jellio-mobile-nav-compact');
    updateActiveLinks(container);
    attachScrollCompact(container);
    return;
  }
  container.dataset.jellioBuilt = '1';
  container.textContent = '';
  // Keeps 'jellio-mobile-nav-mount' alongside the visual class rather
  // than overwriting className outright: components/sidebar.js's own
  // real bug (see its header) was exactly this, on the sidebar mount
  // instead of this one, and it defeated the same "build once" fast
  // path above by making app.js's own getRoot() self-heal check stop
  // finding this real mount the instant this ran once, rebuilding the
  // whole shell fresh on every navigation after that.
  container.className = 'jellio-mobile-nav-mount jellio-mobile-nav';

  const scroller = document.createElement('div');
  scroller.className = 'jellio-mobile-nav-scroll';
  container.appendChild(scroller);

  const links = await getPrimaryNavLinks();
  links.forEach(function (link) {
    scroller.appendChild(buildLink(link));
  });

  scroller.appendChild(await buildProfileButton());
  scroller.appendChild(buildLink(SETTINGS_LINK));

  attachScrollCompact(container);
}
