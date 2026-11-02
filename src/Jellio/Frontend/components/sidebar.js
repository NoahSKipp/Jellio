import { t } from '../runtime/i18n.js';
import { getPrimaryNavLinks, isActive, buildIconElement, buildAvatarIconMount, SETTINGS_LINK, FIXED_NAV_LINKS } from './navShared.js';
import { navigateTo } from '../runtime/router.js';
import { toggleNowPlayingPanel, nowPlayingCount } from './nowPlaying.js';
import { toggleNotificationsPanel, notificationsUnreadCount } from './notifications.js';
import { openAccountSwitcher } from './accountSwitcher.js';
import { getCurrentUser } from '../runtime/api.js';

const DOWNLOADS_LINK = { icon: 'download_for_offline', get label() { return t('nav_downloads'); }, hash: '#/downloads' };

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
    button.blur();
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

function buildGroupWatchButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-groupwatch';
  button.title = t('nav_group_watch');
  button.setAttribute('aria-label', t('nav_group_watch'));

  const icon = document.createElement('span');
  icon.className = 'material-icons groups';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const labelEl = document.createElement('span');
  labelEl.className = 'jellio-sidebar-label';
  labelEl.textContent = t('nav_group_watch');
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    button.blur();
    import('./groupWatch.js').then(function (module) {
      module.openGroupWatch();
    });
  });

  return button;
}

function buildNowPlayingButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-now-playing';
  button.title = t('nav_now_playing');
  button.setAttribute('aria-label', t('nav_now_playing'));
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
  labelEl.textContent = t('nav_now_playing');
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    button.blur();
    toggleNowPlayingPanel();
  });
  return button;
}

function buildNotificationsButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-notifications';
  button.title = t('nav_notifications');
  button.setAttribute('aria-label', t('nav_notifications'));
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
  labelEl.textContent = t('nav_notifications');
  button.appendChild(labelEl);

  button.addEventListener('click', function () {
    button.blur();
    toggleNotificationsPanel();
  });
  return button;
}

async function buildProfileButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-sidebar-link jellio-sidebar-profile';

  button.appendChild(await buildAvatarIconMount());

  let name = t('nav_profile');
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

  button.addEventListener('click', function () {
    openAccountSwitcher();
  });

  return button;
}

export async function renderSidebar(container) {
  if (container.dataset.jellioBuilt === '1') {
    updateActiveLinks(container);
    return;
  }
  container.dataset.jellioBuilt = '1';
  container.textContent = '';
  container.className = 'jellio-sidebar-mount';

  const rail = document.createElement('div');
  rail.className = 'jellio-sidebar';
  container.appendChild(rail);

  const scroll = document.createElement('div');
  scroll.className = 'jellio-sidebar-scroll';

  const profileMount = document.createElement('div');
  rail.appendChild(profileMount);
  const profileDivider = document.createElement('div');
  profileDivider.className = 'jellio-sidebar-divider';
  rail.appendChild(profileDivider);

  FIXED_NAV_LINKS.forEach(function (link) {
    rail.appendChild(buildLink(link));
  });
  // A divider closes this fixed group before the reader's own libraries.
  const divider = document.createElement('div');
  divider.className = 'jellio-sidebar-divider';
  rail.appendChild(divider);

  rail.appendChild(scroll);
  rail.appendChild(buildLink(DOWNLOADS_LINK));
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

  getPrimaryNavLinks()
    .then(function (links) {
      // Video libraries, then a divider, then Books/Audiobooks/Manga.
      let readingDividerAdded = false;
      const libraryLinks = links.slice(FIXED_NAV_LINKS.length).filter((link) => link.hash !== DOWNLOADS_LINK.hash);
      const hasVideo = libraryLinks.some((link) => link.group !== 'reading');
      libraryLinks
        .slice()
        .sort((a, b) => (a.group === 'reading' ? 1 : 0) - (b.group === 'reading' ? 1 : 0))
        .forEach(function (link) {
          if (link.group === 'reading' && !readingDividerAdded && hasVideo) {
            readingDividerAdded = true;
            const readingDivider = document.createElement('div');
            readingDivider.className = 'jellio-sidebar-divider';
            scroll.appendChild(readingDivider);
          }
          scroll.appendChild(buildLink(link));
        });
    })
    .catch(function (err) {
      console.warn('Jellio: sidebar library links failed', err);
    });
}
