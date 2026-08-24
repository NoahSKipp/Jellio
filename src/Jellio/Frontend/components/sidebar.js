// Persistent nav rail, rendered as part of Jellio's own shell whenever any
// custom screen is active on a tablet/desktop width viewport (CSS hides
// this in favour of components/mobileNav.js's own pill bar on a real
// phone width, see css/app.css's own breakpoint for the exact cutoff).
// Link set, icons and the profile avatar all come from
// components/navShared.js, the one real source both surfaces share.
import { getPrimaryNavLinks, isActive, buildIconElement, buildAvatarIconMount, SETTINGS_LINK } from './navShared.js';
import { navigateTo } from '../runtime/router.js';
import { toggleNowPlayingPanel, nowPlayingCount } from './nowPlaying.js';

// Tagged with its own hash so updateActiveLinks() can find it again
// without rebuilding it: real feedback was that the whole rail
// visibly flickered on every navigation, traced to renderSidebar
// destroying and rebuilding every icon on every single call, cache
// warm or not, awaiting getUserViews/getCollections/getCurrentUser in
// between meant at least one empty or half built frame paints every
// time. The set of links a session sees rarely changes at all, so
// only the active one moving needs a per navigation cost, not the
// whole rail.
function buildLink(link) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.jellioHash = link.hash;
  const active = isActive(link.hash);
  button.className = 'jellio-sidebar-link' + (active ? ' jellio-sidebar-link-active' : '');
  button.title = link.label;
  button.setAttribute('aria-label', link.label);
  if (active) button.setAttribute('aria-current', 'page');

  button.appendChild(buildIconElement(link.icon));

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
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
    link.classList.toggle('jellio-sidebar-link-active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

// Native jellyfin-web keeps running underneath this runtime's own
// overlay, unaware (app.js's own getRoot() only ever covers it, never
// removes it), so its classic-skin header buttons are still real,
// still bound and still clickable, just painted under display:none.
// libraryMenu.js's own .headerSyncButton already opens the real
// groupSelectionMenu (onSyncButtonClicked), so Group Watch is a
// forwarded click rather than a UI this runtime has to build itself,
// same technique the original codebase's own persistentSidebar.js
// uses for the same button.
function clickNative(selector) {
  const el = document.querySelector(selector);
  if (el) el.click();
  return Boolean(el);
}

function buildGroupWatchButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-groupwatch';
  button.title = 'Group Watch';
  button.setAttribute('aria-label', 'Group Watch');

  const icon = document.createElement('span');
  icon.className = 'material-icons groups';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Group Watch';
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    if (!clickNative('.headerSyncButton')) {
      console.warn('Jellio: .headerSyncButton not found, native SyncPlay menu could not open');
    }
  });

  return button;
}

// Labelled "Playing" rather than "Now playing": every other row on the
// rail is a single word, matching the original codebase's own real
// feedback based reasoning for the same button.
function buildNowPlayingButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-now-playing';
  button.title = 'Playing';
  button.setAttribute('aria-label', 'Now playing');
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  if (nowPlayingCount() > 0) button.classList.add('jellio-sidebar-now-playing-active');

  const icon = document.createElement('span');
  icon.className = 'material-icons play_circle';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const badge = document.createElement('span');
  badge.className = 'jellio-sidebar-now-playing-badge';
  badge.textContent = String(nowPlayingCount());
  button.appendChild(badge);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Playing';
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    toggleNowPlayingPanel();
  });
  return button;
}

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-profile';
  button.title = 'Profile';
  button.setAttribute('aria-label', 'Profile');

  button.appendChild(await buildAvatarIconMount());

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Profile';
  button.appendChild(labelEl);

  // Opens the real account screen (password, sleep timer, avatar, sign
  // out, screens/settings.js) rather than the avatar picker directly.
  // The picker used to be this button's only destination, indistinguishable
  // from the separate Account nav link that opened the same screen, real
  // feedback asked for one button doing a real job instead of two doing
  // an overlapping one. The picker is still one click away from there.
  button.addEventListener('click', function () {
    navigateTo('#/account');
  });

  return button;
}

// Built once per real container and left alone after that, rather than
// destroyed and rebuilt on every navigation: this and app.js's own
// getRoot() (which used to unconditionally rebuild the shell, sidebar
// mount included, on every call) were together the real cause of the
// icons visibly flickering on every click, reported live. app.js now
// only hands this a fresh container when the mount was genuinely
// missing (its own self-heal case), so the same container coming back
// on the very next navigation is the normal case, not the rare one,
// and a dataset marker is enough to tell the two apart. Everything
// that can change after the initial build without a full rebuild
// (which link is active, the now playing badge, the profile avatar)
// already has, or now has, its own live update path instead of relying
// on one: updateActiveLinks() below, nowPlaying.js's own render(), and
// navShared.js's own refreshProfileAvatar().
export async function renderSidebar(container) {
  if (container.dataset.jellioBuilt === '1') {
    updateActiveLinks(container);
    return;
  }
  container.dataset.jellioBuilt = '1';
  container.textContent = '';
  // Real bug caught here: overwriting className to just 'jellio-sidebar'
  // dropped 'jellio-sidebar-mount' from this same node, so app.js's own
  // getRoot() self-heal check (shell.querySelector('.jellio-sidebar-
  // mount')) stopped finding it the instant this function's own first
  // real call finished, on every session, and rebuilt the whole shell
  // from scratch on every single navigation after that as a result,
  // defeating this function's own "build once" fast path above before
  // it ever got a real second call to skip on. A fresh mount recreated
  // by that rebuild starts its own flex-basis layout over from nothing
  // before css/app.css's own classes finish resolving on it, a real,
  // visible size change on every navigation, not the moving CSS unit
  // fixed earlier. Keeping both classes on the same node is enough:
  // self-heal keeps finding the real mount it already has, and this
  // function's own fast path above finally gets to run for real.
  container.className = 'jellio-sidebar-mount jellio-sidebar';

  const links = await getPrimaryNavLinks();
  links.forEach(function (link, index) {
    container.appendChild(buildLink(link));
    // Only the three links every session always has (Home, Search,
    // Watchlist) sit above the divider; the reader's own libraries
    // start right after it, same grouping the rail always had.
    if (index === 2) {
      const divider = document.createElement('div');
      divider.className = 'jellio-sidebar-divider';
      container.appendChild(divider);
    }
  });

  const spacer = document.createElement('div');
  spacer.className = 'jellio-sidebar-spacer';
  container.appendChild(spacer);

  container.appendChild(buildGroupWatchButton());
  container.appendChild(buildNowPlayingButton());
  container.appendChild(await buildProfileButton());
  container.appendChild(buildLink(SETTINGS_LINK));
}
