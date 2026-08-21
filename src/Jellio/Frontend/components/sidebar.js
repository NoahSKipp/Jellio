// Persistent nav rail, rendered as part of Jellio's own shell whenever any
// custom screen is active. Icon path data (movies, shows, anime, search,
// library) ported verbatim from the original Jellio codebase's own
// persistentSidebar.js, this project's own already-licensed content
// (originally sourced from Harbor, harborstremio/harbor, MIT, and
// NuvioMobile's own real vector drawables, see that file's own header for
// the full provenance), not re-derived here.
import { getUserViews, getCollections, getCurrentUser, getUserImageUrl } from '../runtime/api.js';
import { navigateTo, currentHash } from '../runtime/router.js';
import { toggleNowPlayingPanel, nowPlayingCount } from './nowPlaying.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const SVG_ICONS = {
  movies: {
    viewBox: '0 0 24 24',
    stroke: true,
    markup:
      '<rect x="3" y="11" width="18" height="10" rx="1.6"/><path d="M7 16L17 16" opacity="0.4"/><rect x="3" y="6" width="18" height="5" rx="0.9" style="fill:currentColor;fill-opacity:.14"/><path d="M5.5 11L8.5 6M11 11L14 6M16.5 11L19.5 6"/>',
  },
  shows: {
    viewBox: '0 0 24 24',
    stroke: true,
    markup: '<path d="M8.5 3L11.5 8M15.5 3L12.5 8"/><rect x="3" y="8" width="18" height="13" rx="2"/>',
  },
  anime: {
    viewBox: '0 0 24 24',
    stroke: true,
    markup:
      '<path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 11 0 5.5-2.5 10-10 10S0 19.5 0 14c0-4 1.82-10.42 3.42-11 1.39-.58 4.64.26 6.42 2.26C10.65 5.09 11.33 5 12 5z"/><path d="M8 14v.5M16 14v.5"/>',
  },
  search: {
    viewBox: '0 0 20 20',
    markup:
      '<path fill-rule="evenodd" d="M4 9a5 5 0 1110 0A5 5 0 014 9zm5-7a7 7 0 104.2 12.6.999.999 0 00.093.107l3 3a1 1 0 001.414-1.414l-3-3a.999.999 0 00-.107-.093A7 7 0 009 2z"/>',
  },
  library: {
    viewBox: '0 0 24 24',
    markup:
      '<path d="M8.50989 2.00001H15.49C15.7225 1.99995 15.9007 1.99991 16.0565 2.01515C17.1643 2.12352 18.0711 2.78958 18.4556 3.68678H5.54428C5.92879 2.78958 6.83555 2.12352 7.94337 2.01515C8.09917 1.99991 8.27741 1.99995 8.50989 2.00001Z"/><path d="M6.31052 4.72312C4.91989 4.72312 3.77963 5.56287 3.3991 6.67691C3.39117 6.70013 3.38356 6.72348 3.37629 6.74693C3.77444 6.62636 4.18881 6.54759 4.60827 6.49382C5.68865 6.35531 7.05399 6.35538 8.64002 6.35547L8.75846 6.35547L15.5321 6.35547C17.1181 6.35538 18.4835 6.35531 19.5639 6.49382C19.9833 6.54759 20.3977 6.62636 20.7958 6.74693C20.7886 6.72348 20.781 6.70013 20.773 6.67691C20.3925 5.56287 19.2522 4.72312 17.8616 4.72312H6.31052Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.67239 7.54204H15.3276C18.7024 7.54204 20.3898 7.54204 21.3377 8.52887C22.2855 9.5157 22.0625 11.0403 21.6165 14.0896L21.1935 16.9811C20.8437 19.3724 20.6689 20.568 19.7717 21.284C18.8745 22 17.5512 22 14.9046 22H9.09536C6.44881 22 5.12553 22 4.22834 21.284C3.33115 20.568 3.15626 19.3724 2.80648 16.9811L2.38351 14.0896C1.93748 11.0403 1.71447 9.5157 2.66232 8.52887C3.61017 7.54204 5.29758 7.54204 8.67239 7.54204ZM8 18.0001C8 17.5859 8.3731 17.2501 8.83333 17.2501H15.1667C15.6269 17.2501 16 17.5859 16 18.0001C16 18.4144 15.6269 18.7502 15.1667 18.7502H8.83333C8.3731 18.7502 8 18.4144 8 18.0001Z"/>',
  },
};

const LIBRARY_ROUTES = {
  movies: 'movies',
  tvshows: 'tv',
  music: 'music',
  books: 'books',
  homevideos: 'homevideos',
  musicvideos: 'musicvideos',
};

function libraryHash(view) {
  const route = view.CollectionType && LIBRARY_ROUTES[view.CollectionType];
  if (route) {
    return '#/' + route + '?topParentId=' + view.Id + '&collectionType=' + view.CollectionType;
  }
  return '#/list?parentId=' + view.Id;
}

// Anime's own link is Shows' own hash with '&jellioKind=anime' appended
// (libraryHash() + that marker), so Shows' hash is a literal string
// prefix of Anime's. A plain prefix check lit up both buttons the
// moment Anime was the active route, reported live. Requiring the same
// jellioKind presence on both sides before trusting a prefix keeps the
// two apart without needing every caller to change what it passes in.
function isActive(hash) {
  const current = currentHash();
  if (hash === '#/home') return current === '#/home' || current === '#/' || current === '';
  if (current === hash) return true;
  if (current.indexOf(hash) !== 0) return false;
  const rest = current.slice(hash.length);
  if (rest && rest[0] !== '&' && rest[0] !== '?') return false;
  const hashHasKind = hash.indexOf('jellioKind=') !== -1;
  const currentHasKind = current.indexOf('jellioKind=') !== -1;
  return hashHasKind === currentHasKind;
}

// Tagged with its own hash so updateActiveLinks() can find it again
// without rebuilding it: real feedback was that the whole rail
// visibly flickered on every navigation, traced to renderSidebar
// destroying and rebuilding every icon on every single call, cache
// warm or not, awaiting getUserViews/getCollections/getCurrentUser in
// between meant at least one empty or half built frame paints every
// time. The set of links a session sees rarely changes at all, so
// only the active one moving needs a per navigation cost, not the
// whole rail.
function buildLink(icon, label, hash) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.jellioHash = hash;
  const active = isActive(hash);
  button.className = 'jellio-sidebar-link' + (active ? ' jellio-sidebar-link-active' : '');
  button.title = label;
  button.setAttribute('aria-label', label);
  if (active) button.setAttribute('aria-current', 'page');

  const svgDef = SVG_ICONS[icon];
  let iconEl;
  if (svgDef) {
    iconEl = document.createElementNS(SVG_NS, 'svg');
    iconEl.setAttribute('class', 'jellio-sidebar-icon-svg' + (svgDef.stroke ? ' jellio-sidebar-icon-svg-stroke' : ''));
    iconEl.setAttribute('viewBox', svgDef.viewBox);
    iconEl.setAttribute('focusable', 'false');
    iconEl.innerHTML = svgDef.markup;
  } else {
    iconEl = document.createElement('span');
    iconEl.className = 'material-icons ' + icon;
  }
  iconEl.setAttribute('aria-hidden', 'true');
  button.appendChild(iconEl);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = label;
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    navigateTo(hash);
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

async function paintAvatar(iconMount) {
  iconMount.textContent = '';
  let user = null;
  try {
    user = await getCurrentUser();
  } catch (err) {
    console.warn('Jellio: sidebar could not load current user', err);
  }

  const imageTag = user && user.PrimaryImageTag;
  if (user && imageTag) {
    const img = document.createElement('img');
    img.className = 'jellio-sidebar-avatar';
    img.src = getUserImageUrl(user.Id, imageTag, { maxWidth: 80 });
    img.alt = '';
    iconMount.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'material-icons account_circle';
    icon.setAttribute('aria-hidden', 'true');
    iconMount.appendChild(icon);
  }
}

// renderSidebar() below only paints the rail once per real session now
// (see its own header), so a changed avatar has no future rebuild left
// to pick it up on its own. components/avatarPicker.js's own onChanged
// callback calls this directly instead, the same live requery pattern
// nowPlaying.js already uses for its own badge rather than something
// that waits on a rebuild that no longer routinely happens.
export function refreshProfileAvatar() {
  const mount = document.querySelector('.jellio-sidebar-avatar-mount');
  if (mount) paintAvatar(mount);
}

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-profile';
  button.title = 'Profile';
  button.setAttribute('aria-label', 'Profile');

  const iconMount = document.createElement('span');
  iconMount.className = 'jellio-sidebar-avatar-mount';
  button.appendChild(iconMount);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Profile';
  button.appendChild(labelEl);

  await paintAvatar(iconMount);

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
// refreshProfileAvatar() above.
export async function renderSidebar(container) {
  if (container.dataset.jellioBuilt === '1') {
    updateActiveLinks(container);
    return;
  }
  container.dataset.jellioBuilt = '1';
  container.textContent = '';
  container.className = 'jellio-sidebar';

  container.appendChild(buildLink('home', 'Home', '#/home'));
  container.appendChild(buildLink('search', 'Search', '#/search'));
  container.appendChild(buildLink('favorite', 'Favorites', '#/home?tab=1'));

  const divider = document.createElement('div');
  divider.className = 'jellio-sidebar-divider';
  container.appendChild(divider);

  let views = [];
  try {
    views = await getUserViews();
  } catch (err) {
    console.warn('Jellio: sidebar could not load libraries', err);
  }

  const moviesView = views.filter(function (view) {
    return view.CollectionType === 'movies';
  })[0];
  const tvView = views.filter(function (view) {
    return view.CollectionType === 'tvshows';
  })[0];
  const realAnimeView = views.filter(function (view) {
    return /anime/i.test(view.Name || '');
  })[0];

  if (moviesView) container.appendChild(buildLink('movies', 'Movies', libraryHash(moviesView)));
  if (tvView) container.appendChild(buildLink('shows', 'Shows', libraryHash(tvView)));

  // Anime has no real Jellyfin library of its own: Gelato resolves one
  // global SeriesPath for every series import (GelatoManager.TryGetSeriesFolder),
  // so AniList titles physically live in the TV library. A real Anime view
  // wins if one was made by hand; otherwise fall back to the TV library
  // tagged with &jellioKind=anime, the same marker screens/library.js
  // reads, and only when there is really something to show behind it (a
  // real anime/anilist catalog among the user's own collections). Ported
  // from the original codebase's own persistentSidebar.js, not
  // re-derived.
  if (realAnimeView) {
    container.appendChild(buildLink('anime', 'Anime', libraryHash(realAnimeView)));
  } else if (tvView) {
    try {
      const collections = await getCollections();
      const hasAnimeCatalogs = collections.some(function (item) {
        return /anime|anilist/i.test(item.Name || '');
      });
      if (hasAnimeCatalogs) {
        container.appendChild(buildLink('anime', 'Anime', libraryHash(tvView) + '&jellioKind=anime'));
      }
    } catch (err) {
      // No anime entry without a confirmed catalog behind it, not fatal
      // to the rest of the rail.
    }
  }

  views.forEach(function (view) {
    if (view === moviesView || view === tvView || view === realAnimeView) return;
    if (!view.CollectionType) return;
    container.appendChild(buildLink('library', view.Name, libraryHash(view)));
  });

  const spacer = document.createElement('div');
  spacer.className = 'jellio-sidebar-spacer';
  container.appendChild(spacer);

  container.appendChild(buildGroupWatchButton());
  container.appendChild(buildNowPlayingButton());
  container.appendChild(await buildProfileButton());
  container.appendChild(buildLink('settings', 'Settings', '#/mypreferencesmenu'));
}
