// This runtime's own login screen, a real replacement for native
// jellyfin-web's login page rather than an overlay injected on top of
// it. The original codebase's own version (js/loginProfiles.js, now
// removed there) had to inject into native's #loginPage DOM and finish
// with a full page reload so native's own ApiClient/ConnectionRequired
// boot cycle picked the new session up, and that reload is exactly what
// broke it: reload re-ran jellyfin-apiclient-javascript's own
// validateAuthentication(), which sends a bare legacy header a real
// deployment rejected, wiping the token and bouncing back to the very
// screen quick sign-in was meant to skip. This runtime has no such
// dependency: auth.js keeps its own session, independent of native
// ApiClient, so a successful sign in here only ever needs to call
// setSession and let app.js's own sync() pick it up, real endpoints
// only, no reload anywhere in the path.
import {
  authenticateByName,
  getRememberedUsers,
  forgetRememberedUser,
  quickSignIn,
  bypassLoginScreen,
} from '../runtime/auth.js';
import { getUserImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The one real completion signal this screen can give: navigate to
// #/home (a real route, so its own hashchange fires app.js's sync()),
// and also poke the same jellio:session-captured event app.js already
// listens for, in case the hash was already #/home and never changed
// (the common case on first load, before any route has a real value
// yet, when a bare hash assignment of the same string is a no-op).
function completeSignIn() {
  navigateTo('#/home');
  document.dispatchEvent(new CustomEvent('jellio:session-captured'));
}

// Quick Connect, a no-password public user grid and "forgot password"
// are all real native login page features this screen does not
// reimplement, so this stays reachable everywhere on the screen rather
// than only from the manual form: a remembered profile's own owner may
// still need one of those, not only someone with no profile saved yet.
function buildBypassLink() {
  const link = el('button', 'jellio-login-cancel', 'Use classic sign-in');
  link.type = 'button';
  link.addEventListener('click', function () {
    bypassLoginScreen();
    document.dispatchEvent(new CustomEvent('jellio:session-captured'));
  });
  return link;
}

function buildManualForm(options) {
  const opts = options || {};
  const form = document.createElement('form');
  form.className = 'jellio-login-form';

  const username = document.createElement('input');
  username.type = 'text';
  username.placeholder = 'Username';
  username.autocomplete = 'username';
  username.className = 'jellio-login-input';
  if (opts.username) username.value = opts.username;

  const password = document.createElement('input');
  password.type = 'password';
  password.placeholder = 'Password';
  password.autocomplete = 'current-password';
  password.className = 'jellio-login-input';

  const status = el('p', 'jellio-login-status', opts.message || '');

  const submit = el('button', 'jellio-login-submit', 'Sign in');
  submit.type = 'submit';

  form.appendChild(username);
  form.appendChild(password);
  form.appendChild(status);
  form.appendChild(submit);

  if (opts.onCancel) {
    const cancel = el('button', 'jellio-login-cancel', 'Back');
    cancel.type = 'button';
    cancel.addEventListener('click', opts.onCancel);
    form.appendChild(cancel);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!username.value || !password.value) {
      status.textContent = 'Enter a username and password.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Signing in…';
    authenticateByName(username.value, password.value)
      .then(function () {
        completeSignIn();
      })
      .catch(function (err) {
        console.warn('Jellio: sign in failed', err);
        status.textContent = err && err.status === 401 ? 'Wrong username or password.' : 'Could not sign in.';
        submit.disabled = false;
      });
  });

  window.requestAnimationFrame(function () {
    (opts.username ? password : username).focus();
  });

  return form;
}

function buildProfileTile(userId, entry, onForgotten, onFailed) {
  const wrap = el('div', 'jellio-login-profile');

  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar';
  avatar.setAttribute('aria-label', 'Sign in as ' + (entry.name || ''));

  if (entry.primaryImageTag) {
    avatar.style.backgroundImage = "url('" + getUserImageUrl(userId, entry.primaryImageTag, { maxWidth: 300 }) + "')";
  } else {
    const icon = el('span', 'material-icons person jellio-login-profile-icon');
    icon.setAttribute('aria-hidden', 'true');
    avatar.appendChild(icon);
  }

  avatar.addEventListener('click', function () {
    avatar.disabled = true;
    quickSignIn(userId)
      .then(function () {
        completeSignIn();
      })
      .catch(function (err) {
        console.warn('Jellio: quick sign-in failed', err);
        avatar.disabled = false;
        onFailed(entry.name || '');
      });
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'jellio-login-profile-remove';
  remove.setAttribute('aria-label', 'Forget this profile');
  remove.textContent = '×';
  remove.addEventListener('click', function (event) {
    event.stopPropagation();
    forgetRememberedUser(userId);
    onForgotten();
  });

  avatarWrap.appendChild(avatar);
  avatarWrap.appendChild(remove);

  const name = el('span', 'jellio-login-profile-name', entry.name || '');

  wrap.appendChild(avatarWrap);
  wrap.appendChild(name);
  return wrap;
}

function buildAddTile(onClick) {
  const wrap = el('div', 'jellio-login-profile');
  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar jellio-login-profile-avatar-add';
  avatar.setAttribute('aria-label', 'Sign in as another user');
  const icon = el('span', 'material-icons add');
  icon.setAttribute('aria-hidden', 'true');
  avatar.appendChild(icon);
  avatar.addEventListener('click', onClick);

  avatarWrap.appendChild(avatar);
  wrap.appendChild(avatarWrap);
  wrap.appendChild(el('span', 'jellio-login-profile-name', 'Other user'));
  return wrap;
}

function renderProfilePicker(container, remembered) {
  container.textContent = '';

  function showManual(prefillName, message) {
    container.textContent = '';
    container.appendChild(el('h1', 'jellio-login-heading', 'Sign in'));
    container.appendChild(
      buildManualForm({
        username: prefillName,
        message: message,
        onCancel: Object.keys(remembered).length
          ? function () {
              renderProfilePicker(container, getRememberedUsers());
            }
          : null,
      }),
    );
    container.appendChild(buildBypassLink());
  }

  const userIds = Object.keys(remembered);
  if (!userIds.length) {
    showManual('', '');
    return;
  }

  container.appendChild(el('h1', 'jellio-login-heading', 'Who’s watching?'));
  const grid = el('div', 'jellio-login-profile-grid');

  userIds.forEach(function (userId) {
    grid.appendChild(
      buildProfileTile(
        userId,
        remembered[userId],
        function () {
          renderProfilePicker(container, getRememberedUsers());
        },
        function (name) {
          showManual(name, 'That saved sign-in no longer works. Sign in again.');
        },
      ),
    );
  });

  grid.appendChild(
    buildAddTile(function () {
      showManual('', '');
    }),
  );

  container.appendChild(grid);
  container.appendChild(buildBypassLink());
}

export async function renderLogin(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-login';

  const screen = el('div', 'jellio-login-screen');
  root.appendChild(screen);

  renderProfilePicker(screen, getRememberedUsers());
}
