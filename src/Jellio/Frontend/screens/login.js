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
  getPublicUsers,
  requestPasswordReset,
  redeemPasswordResetPin,
} from '../runtime/auth.js';
import { getUserImageUrl, updateUserPassword } from '../runtime/api.js';
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

// Quick Connect is still a real native login page feature this screen
// does not reimplement (the public user grid and forgot password
// below both are, real feedback asked for each directly), so this
// stays reachable everywhere on the screen rather than only from the
// manual form: a remembered or public profile's own owner may still
// need it, not only someone with no profile visible at all.
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

  if (opts.onForgotPassword) {
    const forgot = el('button', 'jellio-login-forgot', 'Forgot password?');
    forgot.type = 'button';
    forgot.addEventListener('click', function () {
      opts.onForgotPassword(username.value);
    });
    form.appendChild(forgot);
  }

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

// Step 1 of 2: a real username, POSTed to /Users/ForgotPassword
// (runtime/auth.js's own requestPasswordReset, real endpoint, not
// guessed at). The server's own real response is deliberately the
// same regardless of whether that username exists at all (that
// file's own header explains why, straight from Jellyfin's own real
// source), so the message here has to stay exactly as generic, or it
// would hand back out the one thing the server itself stopped
// leaking. jfa-go (already configured server side by whoever runs
// this server, not something this runtime talks to directly) is what
// actually turns a real reset into a real email from here.
function buildForgotUsernameForm(prefillUsername, onRequested, onCancel) {
  const form = document.createElement('form');
  form.className = 'jellio-login-form';

  const username = document.createElement('input');
  username.type = 'text';
  username.placeholder = 'Username';
  username.autocomplete = 'username';
  username.className = 'jellio-login-input';
  if (prefillUsername) username.value = prefillUsername;

  const status = el('p', 'jellio-login-status', '');

  const submit = el('button', 'jellio-login-submit', 'Send reset code');
  submit.type = 'submit';

  form.appendChild(username);
  form.appendChild(status);
  form.appendChild(submit);

  const cancel = el('button', 'jellio-login-cancel', 'Back');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  form.appendChild(cancel);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!username.value) {
      status.textContent = 'Enter your username.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Sending…';
    requestPasswordReset(username.value)
      .then(function () {
        onRequested(username.value);
      })
      .catch(function (err) {
        console.warn('Jellio: could not request a password reset', err);
        status.textContent = 'Could not request a reset code. Try again later.';
        submit.disabled = false;
      });
  });

  window.requestAnimationFrame(function () {
    username.focus();
  });

  return form;
}

// Step 2 of 2: the code the reader's own inbox just received, plus
// the real new password to end on. A real successful redeem clears
// the account's own password server side rather than setting the one
// asked for here, real Jellyfin behaviour (PinRedeemResult, real
// source, only a bare Success boolean, nothing about a chosen
// password at all), so this signs back in with a blank one the
// moment that succeeds and immediately calls updateUserPassword with
// the real new one, the same two real calls the stock profile page's
// own equivalent flow already makes for the same reason, before
// finally completing sign in.
function buildForgotPinForm(username, onCancel) {
  const form = document.createElement('form');
  form.className = 'jellio-login-form';

  const pin = document.createElement('input');
  pin.type = 'text';
  pin.placeholder = 'Reset code';
  pin.autocomplete = 'one-time-code';
  pin.className = 'jellio-login-input';

  const newPassword = document.createElement('input');
  newPassword.type = 'password';
  newPassword.placeholder = 'New password';
  newPassword.autocomplete = 'new-password';
  newPassword.className = 'jellio-login-input';

  const confirmPassword = document.createElement('input');
  confirmPassword.type = 'password';
  confirmPassword.placeholder = 'Confirm new password';
  confirmPassword.autocomplete = 'new-password';
  confirmPassword.className = 'jellio-login-input';

  const status = el(
    'p',
    'jellio-login-status',
    'If that account exists, a reset code has been emailed to it. Enter it below with a new password.',
  );

  const submit = el('button', 'jellio-login-submit', 'Reset password');
  submit.type = 'submit';

  form.appendChild(pin);
  form.appendChild(newPassword);
  form.appendChild(confirmPassword);
  form.appendChild(status);
  form.appendChild(submit);

  const cancel = el('button', 'jellio-login-cancel', 'Back');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  form.appendChild(cancel);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!pin.value || !newPassword.value) {
      status.textContent = 'Enter the reset code and a new password.';
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      status.textContent = 'New passwords do not match.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Resetting…';
    redeemPasswordResetPin(pin.value)
      .then(function (result) {
        if (!result || !result.Success) {
          status.textContent = 'That reset code is invalid or has expired.';
          submit.disabled = false;
          return;
        }
        return authenticateByName(username, '')
          .then(function () {
            return updateUserPassword('', newPassword.value);
          })
          .then(function () {
            completeSignIn();
          });
      })
      .catch(function (err) {
        console.warn('Jellio: could not reset password', err);
        status.textContent = 'Could not reset the password. Try again.';
        submit.disabled = false;
      });
  });

  window.requestAnimationFrame(function () {
    pin.focus();
  });

  return form;
}

function renderForgotPassword(container, prefillUsername, onCancel) {
  container.textContent = '';
  container.appendChild(el('h1', 'jellio-login-heading', 'Reset password'));
  container.appendChild(
    buildForgotUsernameForm(
      prefillUsername,
      function (username) {
        container.textContent = '';
        container.appendChild(el('h1', 'jellio-login-heading', 'Reset password'));
        container.appendChild(buildForgotPinForm(username, onCancel));
      },
      onCancel,
    ),
  );
}

// Real feedback asked for the profile tiles to enter one after another
// rather than all at once, "like in the Nuvio app". Nuvio's own real
// source was not reachable to confirm the exact timing (checked
// NuvioWeb, the project's own primary reference per the project's architecture; its
// "who's watching" screen, js/core/profile/profileSelectionScreen.js,
// carries no such per tile stagger to port), so this is a standard
// staggered grid entrance built directly rather than a port, index
// order matching left to right, top to bottom reading order, capped
// (STAGGER_STEP_MS * STAGGER_MAX below) so a long remembered list does
// not leave the last tile waiting a full second to appear.
const STAGGER_STEP_MS = 55;
const STAGGER_MAX = 10;

function applyStagger(wrap, index) {
  wrap.style.setProperty('--jellio-stagger-delay', Math.min(index, STAGGER_MAX) * STAGGER_STEP_MS + 'ms');
}

function buildProfileTile(userId, entry, index, onForgotten, onFailed) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);

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

// A user visible here has never necessarily signed in on this device
// before (getPublicUsers() in runtime/auth.js only mirrors a real
// admin's own "Display this user on the login screen" toggle, server
// side), so there is no remembered AccessToken to reuse the way
// quickSignIn() does for a tile in the other list. HasPassword is a
// real, if formally obsolete, UserDto field jellyfin-web's own login
// page still checks the same way before deciding whether a password
// is even worth asking for; AuthenticateByName with an empty Pw is
// the same real request a passwordless account's own native sign in
// already sends. Either path ends by calling setSession, which
// rememberUser()s this same profile on the way, so the very next
// visit finds it in the other list instead, with a real quick sign-in
// token this time.
function buildPublicUserTile(user, index, onNeedsPassword) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);

  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar';
  avatar.setAttribute('aria-label', 'Sign in as ' + (user.Name || ''));

  if (user.PrimaryImageTag) {
    avatar.style.backgroundImage =
      "url('" + getUserImageUrl(user.Id, user.PrimaryImageTag, { maxWidth: 300 }) + "')";
  } else {
    const icon = el('span', 'material-icons person jellio-login-profile-icon');
    icon.setAttribute('aria-hidden', 'true');
    avatar.appendChild(icon);
  }

  const hasPassword = user.HasPassword !== false && user.HasConfiguredPassword !== false;

  avatar.addEventListener('click', function () {
    if (!hasPassword) {
      avatar.disabled = true;
      authenticateByName(user.Name || '', '')
        .then(function () {
          completeSignIn();
        })
        .catch(function () {
          avatar.disabled = false;
          onNeedsPassword(user.Name || '');
        });
      return;
    }
    onNeedsPassword(user.Name || '');
  });

  avatarWrap.appendChild(avatar);

  const name = el('span', 'jellio-login-profile-name', user.Name || '');

  wrap.appendChild(avatarWrap);
  wrap.appendChild(name);
  return wrap;
}

function buildAddTile(index, onClick) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);
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

// Remembered wins on overlap: that entry carries a real AccessToken
// (quickSignIn, one click, no password redone), where a public-only
// listing for the same real user has never signed in on this device
// and could only ever offer the slower authenticateByName path below.
function publicOnlyUsers(remembered, publicUsers) {
  return publicUsers.filter(function (user) {
    return user && user.Id && !remembered[user.Id];
  });
}

function renderProfilePicker(container, remembered, publicUsers) {
  container.textContent = '';

  function rerender() {
    renderProfilePicker(container, getRememberedUsers(), publicUsers);
  }

  function showManual(prefillName, message) {
    container.textContent = '';
    container.appendChild(el('h1', 'jellio-login-heading', 'Sign in'));
    container.appendChild(
      buildManualForm({
        username: prefillName,
        message: message,
        onCancel: Object.keys(remembered).length || publicOnly.length ? rerender : null,
        onForgotPassword: function (typedUsername) {
          renderForgotPassword(container, typedUsername, function () {
            showManual(typedUsername, '');
          });
        },
      }),
    );
    container.appendChild(buildBypassLink());
  }

  const rememberedIds = Object.keys(remembered);
  const publicOnly = publicOnlyUsers(remembered, publicUsers);

  if (!rememberedIds.length && !publicOnly.length) {
    showManual('', '');
    return;
  }

  container.appendChild(el('h1', 'jellio-login-heading', 'Who’s watching?'));
  const grid = el('div', 'jellio-login-profile-grid');
  let index = 0;

  rememberedIds.forEach(function (userId) {
    grid.appendChild(
      buildProfileTile(
        userId,
        remembered[userId],
        index++,
        rerender,
        function (name) {
          showManual(name, 'That saved sign-in no longer works. Sign in again.');
        },
      ),
    );
  });

  publicOnly.forEach(function (user) {
    grid.appendChild(
      buildPublicUserTile(user, index++, function (name) {
        showManual(name, '');
      }),
    );
  });

  grid.appendChild(
    buildAddTile(index, function () {
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

  let publicUsers = [];
  try {
    publicUsers = await getPublicUsers();
  } catch (err) {
    // A device that has signed in here before still gets the
    // remembered list, real endpoint or not.
  }

  renderProfilePicker(screen, getRememberedUsers(), publicUsers);
}
