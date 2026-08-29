// Quick profile switcher, opened from the sidebar/mobile nav's own Profile
// button. Real feedback: Profile and Settings both just navigated to the
// same #/account screen, no real second job of its own. Real reference,
// per the project's architecture: JMSFusion/MonWUI's own account switcher.
// screens/login.js already builds this exact "who's watching" grid (remembered
// users, public users, add tile) for the signed-out case; this overlay reuses
// its same real CSS (.jellio-login-profile*) rather than a second visual
// language, laid out as a small floating panel instead of a full screen since
// switching mid-browse should not need leaving the page first.
import {
  getCurrentUser as getSessionUser,
  getRememberedUsers,
  getPublicUsers,
  pruneHiddenRememberedUsers,
  quickSignIn,
  authenticateByName,
  logout,
} from '../runtime/auth.js';
import { getUserImageUrl, clearCache, getOnlineUserIds } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

const OVERLAY_ID = 'jellioAccountSwitcher';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeAccountSwitcher();
}

function handleOutsideClick(event) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay && event.target === overlay) closeAccountSwitcher();
}

export function closeAccountSwitcher() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

// Real bug, found live: this used to call window.location.reload()
// here, on the real assumption a full reload was the simplest way to
// get every screen's own already-fetched state onto the newly signed
// in user. Real feedback (a real repro): that reload landed straight
// back on a real sign-in screen instead, every time. runtime/auth.js's
// own header already documents exactly why: a full reload re-runs
// native jellyfin-web's own boot sequence, ConnectionManager
// construction included, and that is the one real path this whole
// architecture was built to stay off (that file's own words: "the
// exact mechanism that later got pulled", a bare legacy header a real
// deployment rejected, wiping the token and bouncing back to the very
// screen quick sign-in was meant to skip). setSession's own real
// syncNativeApiClientState call already keeps native's own in-memory
// ApiClient state correct with no reload at all, screens/login.js's
// own completeSignIn() already proves that path out live for a fresh
// sign in, and this now does exactly what that function does instead:
// a soft real navigation plus the same jellio:session-captured event
// app.js's own sync() already listens for, no reload anywhere.
// clearCache() covers the one real gap that path does not: several of
// runtime/api.js's own cache keys (a plain item lookup chief among
// them) carry no userId at all, real data that is still fresh, just
// for the wrong real reader the instant this switches accounts.
// Rebuilding the sidebar/mobile nav from scratch is the other real
// gap, both rails' own "build once" real fast path (components/
// sidebar.js's own header explains why it exists) has no live update
// path for an entirely different signed in user, only for that same
// user's own avatar or active link changing.
function switchToUser(button, promiseFactory, status) {
  button.disabled = true;
  promiseFactory()
    .then(function () {
      clearCache();
      document.querySelectorAll('.jellio-sidebar-mount, .jellio-mobile-nav-mount').forEach(function (mount) {
        delete mount.dataset.jellioBuilt;
      });
      closeAccountSwitcher();
      navigateTo('#/home');
      document.dispatchEvent(new CustomEvent('jellio:session-captured'));
    })
    .catch(function (err) {
      console.warn('Jellio: could not switch profile', err);
      button.disabled = false;
      if (status) status.textContent = 'Could not switch to that profile.';
    });
}

// quick marks a tile whose own onClick actually completes the switch
// right here (a remembered token, or a real passwordless public user):
// real feedback asked for a way to tell those apart from a tile that
// only looks the same but actually just signs the reader out to a
// full real sign-in screen underneath (a public user Jellyfin itself
// says needs a real password, this file's own openAccountSwitcher()
// already treats differently, just invisibly until now).
function buildProfileTile(userId, name, imageTag, onClick, quick, online) {
  const wrap = el('div', 'jellio-login-profile');
  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar';
  avatar.setAttribute('aria-label', (quick ? 'Quick sign in as ' : 'Switch to ') + (name || ''));
  if (imageTag) {
    avatar.style.backgroundImage = "url('" + getUserImageUrl(userId, imageTag, { maxWidth: 300 }) + "')";
  } else {
    const icon = el('span', 'material-icons person jellio-login-profile-icon');
    icon.setAttribute('aria-hidden', 'true');
    avatar.appendChild(icon);
  }
  avatar.addEventListener('click', function () {
    onClick(avatar);
  });

  avatarWrap.appendChild(avatar);

  // Top left, real feedback: no way to look at another user's own
  // profile (badges, activity) without actually switching into their
  // own session first. A plain button here instead, stopping
  // propagation so it never also fires avatar's own click above,
  // closes this overlay and hands off to #/profile?id=X, the same
  // real profile page Settings' own "View profile" row already opens
  // for the signed in reader's own id.
  const viewProfile = document.createElement('button');
  viewProfile.type = 'button';
  viewProfile.className = 'jellio-account-switcher-view-profile';
  viewProfile.setAttribute('aria-label', "View " + (name || 'this user') + "'s profile");
  const eyeIcon = el('span', 'material-icons visibility');
  eyeIcon.setAttribute('aria-hidden', 'true');
  viewProfile.appendChild(eyeIcon);
  viewProfile.addEventListener('click', function (event) {
    event.stopPropagation();
    closeAccountSwitcher();
    navigateTo('#/profile?id=' + userId);
  });
  avatarWrap.appendChild(viewProfile);

  if (quick) {
    const badge = el('span', 'jellio-account-switcher-quick-badge material-icons bolt');
    badge.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(badge);
  }

  // Top right, the quick sign-in badge's own bottom right mirrored: a
  // real active ISessionManager session for this user right now
  // (runtime/api.js's own getOnlineUserIds), not anything this device
  // remembers, so it stays correct switching between two remembered
  // profiles that are not actually the reader currently signed in
  // somewhere else.
  if (online) {
    const dot = el('span', 'jellio-account-switcher-online-dot');
    dot.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(dot);
  }

  wrap.appendChild(avatarWrap);
  wrap.appendChild(el('span', 'jellio-login-profile-name', name || ''));
  if (quick) wrap.appendChild(el('span', 'jellio-account-switcher-quick-label', 'Quick sign-in'));
  return wrap;
}

function buildAddTile() {
  const wrap = el('div', 'jellio-login-profile');
  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar jellio-login-profile-avatar-add';
  avatar.setAttribute('aria-label', 'Sign in as another user');
  const icon = el('span', 'material-icons add');
  icon.setAttribute('aria-hidden', 'true');
  avatar.appendChild(icon);
  // No manual credential form lives in this overlay: screens/login.js's
  // own picker already has one, and reaching it needs signing the
  // current profile out first regardless (the login screen only ever
  // renders while unauthenticated, app.js's own real route guard), same
  // as picking "add account" on most every other real client.
  avatar.addEventListener('click', function () {
    closeAccountSwitcher();
    logout();
  });

  avatarWrap.appendChild(avatar);
  wrap.appendChild(avatarWrap);
  wrap.appendChild(el('span', 'jellio-login-profile-name', 'Other user'));
  return wrap;
}

export async function openAccountSwitcher() {
  closeAccountSwitcher();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'jellio-avatar-picker-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Switch profile');
  overlay.addEventListener('click', handleOutsideClick);
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel';

  const current = getSessionUser();
  const currentId = current && current.Id;

  const header = el('div', 'jellio-account-switcher-current');
  const currentAvatar = el('div', 'jellio-account-switcher-avatar');
  if (current && current.PrimaryImageTag) {
    currentAvatar.style.backgroundImage =
      "url('" + getUserImageUrl(current.Id, current.PrimaryImageTag, { maxWidth: 200 }) + "')";
  } else {
    const icon = el('span', 'material-icons person');
    icon.setAttribute('aria-hidden', 'true');
    currentAvatar.appendChild(icon);
  }
  header.appendChild(currentAvatar);

  const info = el('div', 'jellio-account-switcher-current-info');
  info.appendChild(el('div', 'jellio-account-switcher-current-name', (current && current.Name) || 'Signed in'));
  const actions = el('div', 'jellio-account-switcher-current-actions');
  // Real feedback: reaching one's own profile used to live only in
  // Settings, one real click most readers never make on the way there.
  // Same real destination buildProfileTile's own viewProfile button
  // already opens for every OTHER tile in this exact panel, just for
  // the signed in reader's own id instead, sitting here above the
  // grid rather than inside it since there is no tile of its own to
  // anchor to.
  const viewProfile = el('button', 'jellio-settings-button', 'View Profile');
  viewProfile.type = 'button';
  viewProfile.addEventListener('click', function () {
    closeAccountSwitcher();
    navigateTo('#/profile?id=' + currentId);
  });
  actions.appendChild(viewProfile);
  const manage = el('button', 'jellio-settings-button', 'Manage Account');
  manage.type = 'button';
  manage.addEventListener('click', function () {
    closeAccountSwitcher();
    navigateTo('#/account');
  });
  actions.appendChild(manage);
  const signOut = el('button', 'jellio-settings-button jellio-settings-button-danger', 'Sign out');
  signOut.type = 'button';
  signOut.addEventListener('click', function () {
    logout();
  });
  actions.appendChild(signOut);
  info.appendChild(actions);
  header.appendChild(info);
  panel.appendChild(header);

  panel.appendChild(el('h2', 'jellio-avatar-picker-title', 'Switch Profile'));

  const grid = el('div', 'jellio-login-profile-grid');
  panel.appendChild(grid);

  const status = el('p', 'jellio-avatar-picker-status', '');
  panel.appendChild(status);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Neither real fetch depends on the other's result, but used to be
  // awaited one after the other regardless, the whole grid waiting on
  // the sum of both round trips instead of just the slower one.
  // allSettled rather than Promise.all: each already tolerates its own
  // failure independently below, the same non-fatal shape neither
  // should lose just because it now starts alongside the other.
  const [publicUsersResult, onlineIdsResult] = await Promise.allSettled([getPublicUsers(), getOnlineUserIds()]);

  let publicUsers = [];
  if (publicUsersResult.status === 'fulfilled') {
    publicUsers = publicUsersResult.value;
    // Real fix: drops a remembered tile for a user later hidden or
    // deleted server side, see this function's own header in
    // runtime/auth.js. Only reached once the fetch above actually
    // succeeded, same real guard that file's own header explains.
    pruneHiddenRememberedUsers(publicUsers);
  }
  // Read fresh rather than earlier: the call above can have just
  // pruned it.
  const remembered = getRememberedUsers();

  // A missing/failed fetch just means no tile shows an online dot this
  // open, same non-fatal shape as publicUsers above, not worth blocking
  // the rest of this overlay over.
  const onlineIds = new Set(onlineIdsResult.status === 'fulfilled' ? onlineIdsResult.value : []);

  Object.keys(remembered).forEach(function (userId) {
    if (userId === currentId) return;
    const entry = remembered[userId];
    grid.appendChild(
      buildProfileTile(
        userId,
        entry.name,
        entry.primaryImageTag,
        function (button) {
          switchToUser(
            button,
            function () {
              return quickSignIn(userId);
            },
            status,
          );
        },
        true,
        onlineIds.has(userId),
      ),
    );
  });

  publicUsers
    .filter(function (user) {
      return user && user.Id && user.Id !== currentId && !remembered[user.Id];
    })
    .forEach(function (user) {
      const hasPassword = user.HasPassword !== false && user.HasConfiguredPassword !== false;
      grid.appendChild(
        buildProfileTile(
          user.Id,
          user.Name,
          user.PrimaryImageTag,
          function (button) {
            if (hasPassword) {
              closeAccountSwitcher();
              logout();
              return;
            }
            switchToUser(
              button,
              function () {
                return authenticateByName(user.Name || '', '');
              },
              status,
            );
          },
          !hasPassword,
          onlineIds.has(user.Id),
        ),
      );
    });

  grid.appendChild(buildAddTile());

  const first = grid.querySelector('button');
  if (first) first.focus();
}
