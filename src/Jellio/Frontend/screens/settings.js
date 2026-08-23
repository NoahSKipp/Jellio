// Account settings, this runtime's own screen. Additive alongside the
// sidebar's existing Settings link to native's real #/mypreferencesmenu
// (Display, Home, Playback, Subtitles and the rest stay there, out of
// scope here), the same native fallback discipline every other screen in
// this codebase already follows: this covers only what has a real,
// confirmed endpoint and a clear place in a small account page.
import { getCurrentUser, updateUserPassword, getSleepTimerStatus, cancelSleepTimer } from '../runtime/api.js';
import { logout } from '../runtime/auth.js';
import { openAvatarPicker } from '../components/avatarPicker.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildPasswordSection() {
  const section = el('section', 'jellio-settings-section');
  section.appendChild(el('h2', 'jellio-settings-section-title', 'Change password'));

  const form = document.createElement('form');
  form.className = 'jellio-settings-form';

  const current = document.createElement('input');
  current.type = 'password';
  current.placeholder = 'Current password';
  current.autocomplete = 'current-password';
  current.className = 'jellio-settings-input';

  const next = document.createElement('input');
  next.type = 'password';
  next.placeholder = 'New password';
  next.autocomplete = 'new-password';
  next.className = 'jellio-settings-input';

  const confirm = document.createElement('input');
  confirm.type = 'password';
  confirm.placeholder = 'Confirm new password';
  confirm.autocomplete = 'new-password';
  confirm.className = 'jellio-settings-input';

  const status = el('p', 'jellio-settings-status');

  const submit = el('button', 'jellio-settings-button', 'Update password');
  submit.type = 'submit';

  form.appendChild(current);
  form.appendChild(next);
  form.appendChild(confirm);
  form.appendChild(status);
  form.appendChild(submit);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!next.value || next.value !== confirm.value) {
      status.textContent = 'New passwords do not match.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Updating…';
    updateUserPassword(current.value, next.value)
      .then(function () {
        status.textContent = 'Password updated.';
        form.reset();
      })
      .catch(function (err) {
        console.warn('Jellio: could not update password', err);
        status.textContent = 'Could not update password. Check your current password.';
      })
      .finally(function () {
        submit.disabled = false;
      });
  });

  section.appendChild(form);
  return section;
}

async function buildSleepTimerSection() {
  const section = el('section', 'jellio-settings-section');
  section.appendChild(el('h2', 'jellio-settings-section-title', 'Sleep timer'));
  const status = el('p', 'jellio-settings-status', 'No active playback session.');
  section.appendChild(status);

  try {
    const result = await getSleepTimerStatus();
    if (result && result.Active) {
      status.textContent = 'A sleep timer is running.';
      const cancel = el('button', 'jellio-settings-button', 'Cancel timer');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        cancelSleepTimer()
          .then(function () {
            status.textContent = 'Sleep timer cancelled.';
            cancel.remove();
          })
          .catch(function (err) {
            console.warn('Jellio: could not cancel sleep timer', err);
            cancel.disabled = false;
          });
      });
      section.appendChild(cancel);
    } else {
      status.textContent = 'No sleep timer is running.';
    }
  } catch (err) {
    console.warn('Jellio: could not load sleep timer status', err);
  }
  return section;
}

export async function renderSettings(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-settings';

  const header = el('header', 'jellio-settings-header');
  header.appendChild(el('h1', 'jellio-settings-title', 'Account'));
  root.appendChild(header);

  const profile = el('section', 'jellio-settings-section');
  profile.appendChild(el('h2', 'jellio-settings-section-title', 'Profile'));

  let user = null;
  try {
    user = await getCurrentUser();
  } catch (err) {
    console.warn('Jellio: could not load current user', err);
  }
  if (user) {
    profile.appendChild(el('p', 'jellio-settings-status', 'Signed in as ' + user.Name));
  }

  const avatarButton = el('button', 'jellio-settings-button', 'Change avatar');
  avatarButton.type = 'button';
  avatarButton.addEventListener('click', function () {
    openAvatarPicker(function () {});
  });
  profile.appendChild(avatarButton);
  root.appendChild(profile);

  root.appendChild(buildPasswordSection());
  root.appendChild(await buildSleepTimerSection());

  const account = el('section', 'jellio-settings-section');
  const logoutButton = el('button', 'jellio-settings-button jellio-settings-button-danger', 'Sign out');
  logoutButton.type = 'button';
  logoutButton.addEventListener('click', function () {
    logout();
  });
  account.appendChild(logoutButton);
  root.appendChild(account);
}
