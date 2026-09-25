// Persistent nav rail, rendered as part of Jellio's own shell whenever any
// custom screen is active on a tablet/desktop width viewport (CSS hides
// this in favour of components/mobileNav.js's own pill bar on a real
// phone width, see css/app.css's own breakpoint for the exact cutoff).
// Link set, icons and the profile avatar all come from
// components/navShared.js, the one real source both surfaces share.
import { getPrimaryNavLinks, isActive, buildIconElement, buildAvatarIconMount, SETTINGS_LINK, FIXED_NAV_LINKS } from './navShared.js';
import { navigateTo } from '../runtime/router.js';
import { toggleNowPlayingPanel, nowPlayingCount } from './nowPlaying.js';
import { toggleNotificationsPanel, notificationsUnreadCount } from './notifications.js';
import { openAccountSwitcher } from './accountSwitcher.js';
import { openGroupWatch } from './groupWatch.js';
import { getCurrentUser } from '../runtime/api.js';
import { loadAudiobookshelfSetting } from '../runtime/audiobookshelfSetting.js';

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
    // Real bug, found live: the collapsed rail only ever expands on
    // :hover/:focus-within, no JS state of its own at all, and a
    // clicked button keeps real browser focus after the click fires,
    // same as any other button. Moving the mouse off the rail right
    // after clicking a link left :focus-within still real true, the
    // whole rail staying expanded until some later, unrelated click
    // elsewhere finally moved focus off it. Blurring right here is the
    // one real place navigation and this rail's own focus state meet.
    button.blur();
    navigateTo(link.hash);
  });
  return button;
}

// A separate self-hosted service (Audiobookshelf), not one of this
// reader's own Jellyfin libraries - opened in a new tab rather than
// navigated to, since nothing here reskins it the way the rest of this
// rail's links reach a real screen inside this runtime.
function buildExternalLink(icon, label, url) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(buildIconElement(icon));

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = label;
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    button.blur();
    window.open(url, '_blank', 'noopener');
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
    button.blur();
    openGroupWatch();
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
    button.blur();
    toggleNowPlayingPanel();
  });
  return button;
}

// Same real shape buildNowPlayingButton() above already uses, a plain
// dot in place of its own numeric badge: real feedback specifically
// asked for "a red or yellow light/dot", not a count, and how many
// releases arrived today is a far less useful real number than "did
// anything new show up at all".
function buildNotificationsButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-notifications';
  button.title = 'Notifications';
  button.setAttribute('aria-label', 'Notifications');
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  if (notificationsUnreadCount() > 0) button.classList.add('jellio-sidebar-notifications-active');

  const icon = document.createElement('span');
  icon.className = 'material-icons notifications';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const dot = document.createElement('span');
  dot.className = 'jellio-sidebar-notifications-dot';
  dot.setAttribute('aria-hidden', 'true');
  button.appendChild(dot);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Notifications';
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    button.blur();
    toggleNotificationsPanel();
  });
  return button;
}

// Real feedback: labelled "Profile" regardless of who was actually
// signed in read as a placeholder that never got filled in, not a
// real account row. cached('user:'+userId, ...) in runtime/api.js
// means this real fetch is a cache hit almost every time, the same
// one buildAvatarIconMount() below already triggers, not a second
// real network round trip.
async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-profile';

  button.appendChild(await buildAvatarIconMount());

  let name = 'Profile';
  try {
    const user = await getCurrentUser();
    if (user && user.Name) name = user.Name;
  } catch (err) {
    // Falls back to the generic label, not fatal to the rest of the rail.
  }
  button.title = name;
  button.setAttribute('aria-label', name);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = name;
  button.appendChild(labelEl);

  // Opens components/accountSwitcher.js's own quick profile switcher
  // rather than navigating to #/account: that used to be this button's
  // only destination, indistinguishable from the separate Settings link
  // further down the rail opening the same screen, real feedback asked
  // for two buttons doing two real jobs instead of one doing both.
  // Settings (and the switcher's own Manage Account entry) still reach
  // that screen.
  //
  // Real bug, found live: Jellyfin Media Player's own desktop shell (a
  // native window around a QtWebEngine view, not a plain browser)
  // opened this overlay and then closed it again within the same
  // instant - real feedback described it as a flicker, no error either
  // side of it. components/mobileNav.js's own identical trigger never
  // called button.blur() the way this one did, the one real difference
  // between a working open there and a flickering one here: forcing
  // blur synchronously right before creating the overlay handed a
  // native focus-change event to whatever sits under the web content
  // in that shell, ahead of anything this runtime's own code could
  // control. Purely cosmetic to begin with (only ever cleared this
  // button's own focus ring after the click), not load-bearing for the
  // overlay to open correctly either way.
  button.addEventListener('click', function () {
    openAccountSwitcher();
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
  // The mount itself stays a plain flex item, css/app.css's own real
  // .jellio-sidebar-mount rule reserving the collapsed rail's real
  // width in .jellio-shell's own flex layout. The actual visible rail
  // is a real child of it instead of the same node wearing both classes
  // the way this used to work: that node is now position: fixed (so it
  // can overlay .jellio-content on hover rather than pushing it, that
  // file's own header explains why), and a fixed-position box takes no
  // real part in its own parent's flex layout at all, so the two real
  // jobs (reserving space, being the visible rail) need two real nodes
  // now, not one wearing both classes.
  container.className = 'jellio-sidebar-mount';

  const rail = document.createElement('div');
  rail.className = 'jellio-sidebar';
  container.appendChild(rail);

  // The reader's own libraries are the one real part of this rail that
  // grows with however many the server actually has; everything else
  // (Profile and Home/Search/Watchlist above, Group Watch/Now Playing/
  // Settings below) stays a fixed real height. Real feedback: Settings,
  // and on a server with several libraries Anime itself, used to sit
  // clipped past the bottom of a shorter viewport with no way to reach
  // them. Only this middle group scrolls now (css/app.css's own
  // .jellio-sidebar-scroll), so the bottom group always renders in
  // full regardless of library count.
  const scroll = document.createElement('div');
  scroll.className = 'jellio-sidebar-scroll';

  // Real feedback: this whole rail used to paint nothing at all, not
  // even Home/Search, until both Profile's own getCurrentUser() and
  // getPrimaryNavLinks()'s own /Views call had resolved, a real blank
  // rail for however long either fetch actually took. Neither one has
  // anything to do with FIXED_NAV_LINKS, Calendar, or the four buttons
  // at the bottom (navShared.js's own header on FIXED_NAV_LINKS
  // explains why), so all of that paints synchronously now, before
  // either real fetch has even started. Profile leads the rail still,
  // same real reason it always did (the one row that is "who", not
  // "where"), just as a real placeholder mount swapped for the actual
  // button the instant its own promise resolves rather than blocking
  // everything below it first.
  const profileMount = document.createElement('div');
  rail.appendChild(profileMount);
  const profileDivider = document.createElement('div');
  profileDivider.className = 'jellio-sidebar-divider';
  rail.appendChild(profileDivider);

  FIXED_NAV_LINKS.forEach(function (link) {
    rail.appendChild(buildLink(link));
  });
  // Calendar (desktop rail only for now, real feedback's own scope:
  // the mobile pill bar's own real link set comes from
  // getPrimaryNavLinks() below, shared with this rail, and stays
  // untouched, same real reason Group Watch/Now Playing below are
  // already this rail's own additions, not part of that shared list)
  // sits right after Feed, its own divider closing out this fixed
  // group before the reader's own libraries start.
  rail.appendChild(buildLink({ icon: 'calendar_month', label: 'Calendar', hash: '#/calendar' }));
  const divider = document.createElement('div');
  divider.className = 'jellio-sidebar-divider';
  rail.appendChild(divider);

  rail.appendChild(scroll);
  rail.appendChild(buildGroupWatchButton());
  rail.appendChild(buildNowPlayingButton());
  rail.appendChild(buildNotificationsButton());
  rail.appendChild(buildLink(SETTINGS_LINK));

  buildProfileButton()
    .then(function (button) {
      profileMount.replaceWith(button);
    })
    .catch(function (err) {
      console.warn('Jellio: sidebar profile button failed', err);
    });

  // FIXED_NAV_LINKS.length worth of entries at the front of this real
  // result are the exact same four already painted above; only
  // whatever getUserViews() actually found (the reader's own real
  // libraries) is new here.
  getPrimaryNavLinks()
    .then(function (links) {
      links.slice(FIXED_NAV_LINKS.length).forEach(function (link) {
        scroll.appendChild(buildLink(link));
      });
    })
    .catch(function (err) {
      console.warn('Jellio: sidebar library links failed', err);
    });

  // Configuration/PluginConfiguration.cs's own real AudiobookshelfUrl,
  // blank by default: this rail's own initial build only ever happens
  // once (container.dataset.jellioBuilt above), same real reason the
  // library links just above append asynchronously rather than
  // blocking this whole function on either fetch first.
  loadAudiobookshelfSetting()
    .then(function (url) {
      if (!url) return;
      scroll.appendChild(buildExternalLink('auto_stories', 'Books', url));
    })
    .catch(function (err) {
      console.warn('Jellio: sidebar Audiobookshelf link failed', err);
    });
}
