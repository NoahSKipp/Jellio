import { t } from '../runtime/i18n.js';
import {
  authenticateByName,
  getRememberedUsers,
  forgetRememberedUser,
  quickSignIn,
  bypassLoginScreen,
  getPublicUsers,
  pruneHiddenRememberedUsers,
  requestPasswordReset,
  redeemPasswordResetPin,
} from '../runtime/auth.js';
import { getUserImageUrl, updateUserPassword, getOnlineUserIds } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const landingHash = /^#\/(item|books|read|listen)\b/.test(window.location.hash) ? window.location.hash : null;

function completeSignIn() {
  navigateTo(landingHash || '#/home');
  document.dispatchEvent(new CustomEvent('jellio:session-captured'));
}

function buildBypassLink() {
  const link = el('button', 'jellio-login-cancel', t('auth_classic_signin'));
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
  username.placeholder = t('auth_username');
  username.autocomplete = 'username';
  username.className = 'jellio-login-input';
  if (opts.username) username.value = opts.username;

  const password = document.createElement('input');
  password.type = 'password';
  password.placeholder = t('auth_password');
  password.autocomplete = 'current-password';
  password.className = 'jellio-login-input';

  const status = el('p', 'jellio-login-status', opts.message || '');

  const submit = el('button', 'jellio-login-submit', t('action_sign_in'));
  submit.type = 'submit';

  form.appendChild(username);
  form.appendChild(password);
  form.appendChild(status);
  form.appendChild(submit);

  if (opts.onForgotPassword) {
    const forgot = el('button', 'jellio-login-forgot', t('auth_forgot_password'));
    forgot.type = 'button';
    forgot.addEventListener('click', function () {
      opts.onForgotPassword(username.value);
    });
    form.appendChild(forgot);
  }

  if (opts.onCancel) {
    const cancel = el('button', 'jellio-login-cancel', t('nav_back'));
    cancel.type = 'button';
    cancel.addEventListener('click', opts.onCancel);
    form.appendChild(cancel);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!username.value || !password.value) {
      status.textContent = t('auth_enter_credentials');
      return;
    }
    submit.disabled = true;
    status.textContent = t('auth_signing_in');
    authenticateByName(username.value, password.value)
      .then(function () {
        completeSignIn();
      })
      .catch(function (err) {
        console.warn('Jellio: sign in failed', err);
        status.textContent = err && err.status === 401 ? t('auth_invalid_credentials') : t('auth_failed');
        submit.disabled = false;
      });
  });

  window.requestAnimationFrame(function () {
    (opts.username ? password : username).focus();
  });

  return form;
}

function buildForgotUsernameForm(prefillUsername, onRequested, onCancel) {
  const form = document.createElement('form');
  form.className = 'jellio-login-form';

  const username = document.createElement('input');
  username.type = 'text';
  username.placeholder = t('auth_username');
  username.autocomplete = 'username';
  username.className = 'jellio-login-input';
  if (prefillUsername) username.value = prefillUsername;

  const status = el('p', 'jellio-login-status', '');

  const submit = el('button', 'jellio-login-submit', t('auth_send_reset_code'));
  submit.type = 'submit';

  form.appendChild(username);
  form.appendChild(status);
  form.appendChild(submit);

  const cancel = el('button', 'jellio-login-cancel', t('nav_back'));
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  form.appendChild(cancel);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!username.value) {
      status.textContent = t('auth_enter_username');
      return;
    }
    submit.disabled = true;
    status.textContent = t('auth_sending');
    requestPasswordReset(username.value)
      .then(function () {
        onRequested(username.value);
      })
      .catch(function (err) {
        console.warn('Jellio: could not request a password reset', err);
        status.textContent = t('toast_request_reset_error');
        submit.disabled = false;
      });
  });

  window.requestAnimationFrame(function () {
    username.focus();
  });

  return form;
}

function buildForgotPinForm(username, onCancel) {
  const form = document.createElement('form');
  form.className = 'jellio-login-form';

  const pin = document.createElement('input');
  pin.type = 'text';
  pin.placeholder = t('auth_reset_code');
  pin.autocomplete = 'one-time-code';
  pin.className = 'jellio-login-input';

  const newPassword = document.createElement('input');
  newPassword.type = 'password';
  newPassword.placeholder = t('settings_new_password');
  newPassword.autocomplete = 'new-password';
  newPassword.className = 'jellio-login-input';

  const confirmPassword = document.createElement('input');
  confirmPassword.type = 'password';
  confirmPassword.placeholder = t('settings_confirm_password');
  confirmPassword.autocomplete = 'new-password';
  confirmPassword.className = 'jellio-login-input';

  const status = el(
    'p',
    'jellio-login-status',
    t('auth_reset_requested_desc'),
  );

  const submit = el('button', 'jellio-login-submit', t('auth_reset_password'));
  submit.type = 'submit';

  form.appendChild(pin);
  form.appendChild(newPassword);
  form.appendChild(confirmPassword);
  form.appendChild(status);
  form.appendChild(submit);

  const cancel = el('button', 'jellio-login-cancel', t('nav_back'));
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  form.appendChild(cancel);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!pin.value || !newPassword.value) {
      status.textContent = t('auth_enter_pin_password');
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      status.textContent = t('auth_passwords_mismatch');
      return;
    }
    submit.disabled = true;
    status.textContent = t('auth_resetting');
    redeemPasswordResetPin(pin.value)
      .then(function (result) {
        if (!result || !result.Success) {
          status.textContent = t('auth_pin_expired');
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
        status.textContent = t('toast_reset_password_error');
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
  container.appendChild(el('h1', 'jellio-login-heading', t('auth_reset_password')));
  container.appendChild(
    buildForgotUsernameForm(
      prefillUsername,
      function (username) {
        container.textContent = '';
        container.appendChild(el('h1', 'jellio-login-heading', t('auth_reset_password')));
        container.appendChild(buildForgotPinForm(username, onCancel));
      },
      onCancel,
    ),
  );
}

const STAGGER_STEP_MS = 55;
const STAGGER_MAX = 10;

function applyStagger(wrap, index) {
  wrap.style.setProperty('--jellio-stagger-delay', Math.min(index, STAGGER_MAX) * STAGGER_STEP_MS + 'ms');
}

function buildProfileTile(userId, entry, index, onForgotten, onFailed, online) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);

  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar';
  avatar.setAttribute('aria-label', t('auth_quick_sign_in', { name: entry.name || '' }));

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
  remove.setAttribute('aria-label', t('action_forget_profile'));
  remove.textContent = '×';
  remove.addEventListener('click', function (event) {
    event.stopPropagation();
    forgetRememberedUser(userId);
    onForgotten();
  });

  avatarWrap.appendChild(avatar);
  avatarWrap.appendChild(remove);

  const badge = el('span', 'jellio-account-switcher-quick-badge material-icons bolt');
  badge.setAttribute('aria-hidden', 'true');
  avatarWrap.appendChild(badge);

  if (online) {
    const dot = el('span', 'jellio-account-switcher-online-dot');
    dot.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(dot);
  }

  const name = el('span', 'jellio-login-profile-name', entry.name || '');

  wrap.appendChild(avatarWrap);
  wrap.appendChild(name);
  wrap.appendChild(el('span', 'jellio-account-switcher-quick-label', t('auth_quick_signin')));
  return wrap;
}

function buildPublicUserTile(user, index, onNeedsPassword, online) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);

  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const hasPassword = user.HasPassword !== false && user.HasConfiguredPassword !== false;

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar';
  avatar.setAttribute('aria-label', (hasPassword ? 'Sign in as ' : 'Quick sign in as ') + (user.Name || ''));

  if (user.PrimaryImageTag) {
    avatar.style.backgroundImage =
      "url('" + getUserImageUrl(user.Id, user.PrimaryImageTag, { maxWidth: 300 }) + "')";
  } else {
    const icon = el('span', 'material-icons person jellio-login-profile-icon');
    icon.setAttribute('aria-hidden', 'true');
    avatar.appendChild(icon);
  }

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

  if (!hasPassword) {
    const badge = el('span', 'jellio-account-switcher-quick-badge material-icons bolt');
    badge.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(badge);
  }

  if (online) {
    const dot = el('span', 'jellio-account-switcher-online-dot');
    dot.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(dot);
  }

  const name = el('span', 'jellio-login-profile-name', user.Name || '');

  wrap.appendChild(avatarWrap);
  wrap.appendChild(name);
  if (!hasPassword) wrap.appendChild(el('span', 'jellio-account-switcher-quick-label', t('auth_quick_signin')));
  return wrap;
}

function buildAddTile(index, onClick) {
  const wrap = el('div', 'jellio-login-profile');
  applyStagger(wrap, index);
  const avatarWrap = el('div', 'jellio-login-profile-avatar-wrap');

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'jellio-login-profile-avatar jellio-login-profile-avatar-add';
  avatar.setAttribute('aria-label', t('auth_other_user'));
  const icon = el('span', 'material-icons add');
  icon.setAttribute('aria-hidden', 'true');
  avatar.appendChild(icon);
  avatar.addEventListener('click', onClick);

  avatarWrap.appendChild(avatar);
  wrap.appendChild(avatarWrap);
  wrap.appendChild(el('span', 'jellio-login-profile-name', t('auth_other_user')));
  return wrap;
}

function publicOnlyUsers(remembered, publicUsers) {
  return publicUsers.filter(function (user) {
    return user && user.Id && !remembered[user.Id];
  });
}

function renderProfilePicker(container, remembered, publicUsers, onlineIds) {
  container.textContent = '';

  function rerender() {
    renderProfilePicker(container, getRememberedUsers(), publicUsers, onlineIds);
  }

  function showManual(prefillName, message) {
    container.textContent = '';
    container.appendChild(el('h1', 'jellio-login-heading', t('action_sign_in')));
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

  container.appendChild(el('h1', 'jellio-login-heading', t('auth_whos_watching')));
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
          showManual(name, t('auth_saved_login_expired'));
        },
        onlineIds.has(userId),
      ),
    );
  });

  publicOnly.forEach(function (user) {
    grid.appendChild(
      buildPublicUserTile(
        user,
        index++,
        function (name) {
          showManual(name, '');
        },
        onlineIds.has(user.Id),
      ),
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

  const [publicUsersResult, onlineIdsResult] = await Promise.allSettled([getPublicUsers(), getOnlineUserIds()]);

  let publicUsers = [];
  if (publicUsersResult.status === 'fulfilled') {
    publicUsers = publicUsersResult.value;
    pruneHiddenRememberedUsers(publicUsers);
  }

  const onlineIds = new Set(onlineIdsResult.status === 'fulfilled' ? onlineIdsResult.value : []);

  renderProfilePicker(screen, getRememberedUsers(), publicUsers, onlineIds);
}
