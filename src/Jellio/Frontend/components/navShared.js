import { t } from '../runtime/i18n.js';
// Shared between components/sidebar.js (desktop/tablet rail) and
// components/mobileNav.js (phone pill bar): which links exist, what
// their icons look like, which one is active, and the profile avatar,
// exactly one real source for all of it rather than two copies that
// can drift. Icon path data (movies, shows, anime, search, library)
// ported verbatim from the original Jellio codebase's own
// persistentSidebar.js, this project's own already-licensed content
// (originally sourced from Harbor, harborstremio/harbor, MIT, and
// NuvioMobile's own real vector drawables, see that file's own header
// for the full provenance), not re-derived here.
import { getUserViews, getCollections, getCurrentUser, getUserImageUrl, friendsSupported, friendsIncomingCount } from '../runtime/api.js';
import { currentHash } from '../runtime/router.js';

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

export const SETTINGS_LINK = { icon: 'settings', get label() { return t('nav_settings'); }, hash: '#/account' };

export const PEOPLE_LINK = { icon: 'contacts', get label() { return t('nav_people'); }, hash: '#/people' };

// Keeps a People entry in step with the friends state: hidden unless the
// server has friends, with a counter for pending requests in `badge`.
export function bindFriendsBadge(host, badge) {
  function sync() {
    const count = friendsIncomingCount();
    host.hidden = friendsSupported() !== true;
    if (badge) {
      badge.textContent = count > 99 ? '99+' : String(count);
      host.classList.toggle('jellio-has-requests', count > 0);
    }
  }
  sync();
  document.addEventListener('jellio:friends-changed', sync);
}

export const FIXED_NAV_LINKS = [
  { icon: 'home', get label() { return t('nav_home'); }, hash: '#/home' },
  { icon: 'search', get label() { return t('nav_search'); }, hash: '#/search' },
  { icon: 'bookmark_add', get label() { return t('nav_watchlist'); }, hash: '#/home?tab=1' },
  { icon: 'dynamic_feed', get label() { return t('nav_feed'); }, hash: '#/feed' },
];

const MANGA_LIBRARY = /manga|comic|manhwa|webtoon/i;

function libraryHash(view) {
  const route = view.CollectionType && LIBRARY_ROUTES[view.CollectionType];
  if (route) {
    return '#/' + route + '?topParentId=' + view.Id + '&collectionType=' + view.CollectionType;
  }
  return '#/list?parentId=' + view.Id;
}

export function isActive(hash) {
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

// The Manga shelf's address (the same library getPrimaryNavLinks links
// to), for opening a series from elsewhere; null without one.
export async function getMangaShelfHash() {
  const views = await getUserViews().catch(() => []);
  const mangaView = views.find((view) => view.CollectionType === 'books' && MANGA_LIBRARY.test(view.Name || ''));
  const source = mangaView || views.find((view) => view.CollectionType === 'books');
  return source ? libraryHash(source) + '&bookKind=manga' + (mangaView ? '&mangaLibrary=1' : '') : null;
}

export async function getPrimaryNavLinks() {
  const links = FIXED_NAV_LINKS.slice();

  getCollections().catch(function () {
    return [];
  });

  let views = [];
  try {
    views = await getUserViews();
  } catch (err) {
    console.warn('Jellio: nav could not load libraries', err);
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

  if (moviesView) links.push({ icon: 'movies', label: t('nav_movies'), hash: libraryHash(moviesView) });
  if (tvView) links.push({ icon: 'shows', label: t('nav_shows'), hash: libraryHash(tvView) });

  if (realAnimeView) {
    links.push({ icon: 'anime', label: t('nav_anime'), hash: libraryHash(realAnimeView) });
  } else if (tvView) {
    links.push({ icon: 'anime', label: t('nav_anime'), hash: libraryHash(tvView) + '&jellioKind=anime' });
  }

  // Manga always has a shelf of its own: a dedicated manga/comics library
  // when there is one, otherwise the comic files in the Books library.
  const mangaView = views.filter(function (view) {
    return view.CollectionType === 'books' && MANGA_LIBRARY.test(view.Name || '');
  })[0];
  const booksView = views.filter(function (view) {
    return view.CollectionType === 'books' && view !== mangaView;
  })[0];
  let mangaLinkAdded = false;
  function pushMangaLink() {
    if (mangaLinkAdded) return;
    mangaLinkAdded = true;
    const source = mangaView || booksView;
    if (!source) return;
    links.push({
      icon: 'collections_bookmark',
      label: t('nav_manga'),
      hash: libraryHash(source) + '&bookKind=manga' + (mangaView ? '&mangaLibrary=1' : ''),
      group: 'reading',
    });
  }

  views.forEach(function (view) {
    if (view === moviesView || view === tvView || view === realAnimeView) return;
    if (!view.CollectionType) return;
    if (view.CollectionType === 'boxsets') return;
    if (view.CollectionType === 'livetv') {
      links.push({ icon: 'live_tv', label: t('nav_live_tv'), hash: '#/livetv' });
      return;
    }
    if (view.CollectionType === 'books') {
      if (view === mangaView) return;
      links.push({ icon: 'auto_stories', label: t('nav_books'), hash: libraryHash(view) + '&bookKind=ebook', group: 'reading' });
      links.push({ icon: 'headphones', label: t('nav_audiobooks'), hash: libraryHash(view) + '&bookKind=audiobook', group: 'reading' });
      if (view === booksView) pushMangaLink();
      return;
    }
    links.push({ icon: 'library', label: view.Name, hash: libraryHash(view) });
  });

  // A manga library with no other Books library still gets its entry.
  pushMangaLink();
  // What's kept on this device (screens/downloads.js), the one link that
  // still works offline.
  links.push({ icon: 'download_for_offline', label: t('nav_downloads'), hash: '#/downloads', group: 'reading' });
  return links;
}

export function buildIconElement(icon) {
  const svgDef = SVG_ICONS[icon];
  let iconEl;
  if (svgDef) {
    iconEl = document.createElementNS(SVG_NS, 'svg');
    iconEl.setAttribute('class', 'jellio-nav-icon-svg' + (svgDef.stroke ? ' jellio-nav-icon-svg-stroke' : ''));
    iconEl.setAttribute('viewBox', svgDef.viewBox);
    iconEl.setAttribute('focusable', 'false');
    iconEl.innerHTML = svgDef.markup;
  } else {
    iconEl = document.createElement('span');
    iconEl.className = 'material-icons ' + icon;
  }
  iconEl.setAttribute('aria-hidden', 'true');
  return iconEl;
}

async function paintAvatar(iconMount) {
  iconMount.textContent = '';
  let user = null;
  try {
    user = await getCurrentUser();
  } catch (err) {
    console.warn('Jellio: nav could not load current user', err);
  }

  const imageTag = user && user.PrimaryImageTag;
  if (user && imageTag) {
    const img = document.createElement('img');
    img.className = 'jellio-nav-avatar';
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

export function refreshProfileAvatar() {
  document.querySelectorAll('.jellio-nav-avatar-mount').forEach(function (mount) {
    paintAvatar(mount);
  });
}

export async function buildAvatarIconMount() {
  const iconMount = document.createElement('span');
  iconMount.className = 'jellio-nav-avatar-mount';
  await paintAvatar(iconMount);
  return iconMount;
}
