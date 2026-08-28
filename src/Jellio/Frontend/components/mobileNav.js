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
import { getCurrentUser } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { openAccountSwitcher } from './accountSwitcher.js';
import { openLibraryPicker } from './libraryPicker.js';

// getPrimaryNavLinks() always puts Home/Search/Watchlist first, in that
// fixed order, before any real library it found (components/navShared.js's
// own header documents the same real order); everything from this index
// on is a real library link.
const FIXED_LINK_COUNT = 3;

// Hysteresis rather than one shared threshold: a single cutoff flickers
// compact/expanded back and forth for a scroll position sitting right
// on it. Real feedback, twice over: every earlier real fix here
// touched how the transition itself renders (backdrop-filter, which
// layout property animates), never why it read as delayed in the
// first place. The actual real cause was these two numbers: 48px/12px
// is real scroll distance a reader has to travel before either state
// change fires at all, the code reacts instantly the moment it does,
// but that same real gap in between reads as "a noticeable delay
// before the label appears/disappears" regardless of how fast
// whatever finally plays after it is. Small enough now that either
// direction fires almost as soon as real scrolling starts, the
// hysteresis gap between them kept just wide enough to still stop a
// scroll position sitting right on the line from flickering.
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

// Real feedback: a phone's own pill bar has no real room for Movies/
// Shows/Anime/every other real library as separate buttons the way
// components/sidebar.js's own rail still shows them. One consolidated
// Library button stands in for all of them, opening components/
// libraryPicker.js's own real popover on tap rather than navigating
// straight there; its own real active state is "true for any of the
// real hashes it stands in for", stored as JSON on its own dataset
// rather than the single data-jellio-hash every other link uses,
// since no one real hash speaks for all of them.
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
  button.setAttribute('aria-label', 'Library');
  if (activeHash) button.setAttribute('aria-current', 'page');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(buildIconElement('library'));
  button.appendChild(iconWrap);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-mobile-nav-label';
  labelEl.textContent = 'Library';
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

// Real feedback: labelled "Profile" regardless of who was actually
// signed in, same real fix components/sidebar.js's own buildProfileButton
// already carries. cached('user:'+userId, ...) in runtime/api.js means
// this real fetch is a cache hit almost every time, the same one
// buildAvatarIconMount() below already triggers, not a second real
// network round trip.
async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-mobile-nav-link';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'jellio-mobile-nav-icon';
  iconWrap.appendChild(await buildAvatarIconMount());
  button.appendChild(iconWrap);

  let name = 'Profile';
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

  // Same real switch components/sidebar.js's own Profile button now
  // opens rather than #/account, that file's own header explains why:
  // Settings right beside this already reaches the account screen.
  button.addEventListener('click', function () {
    openAccountSwitcher();
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
  links.slice(0, FIXED_LINK_COUNT).forEach(function (link) {
    scroller.appendChild(buildLink(link));
  });

  const libraryLinks = links.slice(FIXED_LINK_COUNT);
  if (libraryLinks.length) {
    scroller.appendChild(buildLibraryButton(libraryLinks));
  }

  scroller.appendChild(buildLink(SETTINGS_LINK));
  // Real feedback: Profile as the very last item in the row, not
  // sitting ahead of Settings the way it used to.
  scroller.appendChild(await buildProfileButton());

  attachScrollCompact(container);
}
