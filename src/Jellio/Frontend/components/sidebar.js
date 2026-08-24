// Persistent nav rail, rendered as part of Jellio's own shell whenever any
// custom screen is active. Icon path data (movies, shows, anime, search,
// library) ported verbatim from the original Jellio codebase's own
// persistentSidebar.js, this project's own already-licensed content
// (originally sourced from Harbor, harborstremio/harbor, MIT, and
// NuvioMobile's own real vector drawables, see that file's own header for
// the full provenance), not re-derived here.
import { getUserViews, getCurrentUser, getUserImageUrl } from '../runtime/api.js';
import { navigateTo, currentHash } from '../runtime/router.js';
import { openAvatarPicker } from './avatarPicker.js';

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

function isActive(hash) {
  const current = currentHash();
  if (hash === '#/home') return current === '#/home' || current === '#/' || current === '';
  return current.indexOf(hash) === 0;
}

function buildLink(icon, label, hash) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link' + (isActive(hash) ? ' jellio-sidebar-link-active' : '');
  button.title = label;
  button.setAttribute('aria-label', label);

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

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-profile';
  button.title = 'Profile';
  button.setAttribute('aria-label', 'Change avatar');

  const iconMount = document.createElement('span');
  iconMount.className = 'jellio-sidebar-avatar-mount';
  button.appendChild(iconMount);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = 'Profile';
  button.appendChild(labelEl);

  async function refreshAvatar() {
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

  await refreshAvatar();

  button.addEventListener('click', function () {
    openAvatarPicker(refreshAvatar);
  });

  return button;
}

export async function renderSidebar(container) {
  container.textContent = '';
  container.className = 'jellio-sidebar';

  container.appendChild(buildLink('home', 'Home', '#/home'));
  container.appendChild(buildLink('search', 'Search', '#/search'));
  container.appendChild(buildLink('favorite', 'Favorites', '#/home?tab=1'));

  const divider = document.createElement('div');
  divider.className = 'jellio-sidebar-divider';
  container.appendChild(divider);

  try {
    const views = await getUserViews();
    views.forEach(function (view) {
      const isKnown = view.CollectionType && LIBRARY_ROUTES[view.CollectionType];
      const icon =
        view.CollectionType === 'movies'
          ? 'movies'
          : view.CollectionType === 'tvshows'
            ? 'shows'
            : 'library';
      if (isKnown || view.CollectionType) {
        container.appendChild(buildLink(icon, view.Name, libraryHash(view)));
      }
    });
  } catch (err) {
    console.warn('Jellio: sidebar could not load libraries', err);
  }

  const spacer = document.createElement('div');
  spacer.className = 'jellio-sidebar-spacer';
  container.appendChild(spacer);

  container.appendChild(await buildProfileButton());
  container.appendChild(buildLink('settings', 'Settings', '#/mypreferencesmenu'));
}
