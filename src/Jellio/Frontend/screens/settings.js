// Settings, this runtime's own screen, the sidebar's Settings link's
// own real destination (components/navShared.js's own SETTINGS_LINK,
// #/account). A category sidebar (Account/Playback/Sessions/About)
// switches which of this file's own section builders below render into
// the content pane, one category at a time, real feedback that this
// page belonged in real defined groups on its own screen rather than
// one long flat column of every section stacked in a row (see
// buildAccountCategory's own header for why these four rather than a
// blind copy of some other real reference's own category names).
// Covers only what has a real, confirmed endpoint and a clear place in
// one of them, the same discipline every other screen in this codebase
// already follows. Remember my stream choice is the one real exception
// to "a confirmed endpoint": components/streamPicker.js's own
// preference has no server side concept at all, client only, same as
// screens/player.js's own subtitle style.
//
// Real feedback pass, second round: the original flat "label above a
// full width input, every section its own plain stack" layout read as
// a bare form, not a settings screen. Every card/row builder below
// (buildCard/buildRow/buildActionRow/buildToggleRow/buildSelectRow)
// exists so each real section becomes one grouped list card (Nuvio's
// own Settings reference, the same shape iOS/Android's own system
// settings already use) instead: an icon'd header naming the card,
// then one divided row per real control inside it. No behaviour here
// changed from the previous pass, only how it renders.
import {
  getCurrentUser,
  updateUserPassword,
  getSleepTimerStatus,
  cancelSleepTimer,
  updateLanguagePreferences,
  isQuickConnectEnabled,
  authorizeQuickConnect,
} from '../runtime/api.js';
import { logout } from '../runtime/auth.js';
import { openAvatarPicker } from '../components/avatarPicker.js';
import { refreshProfileAvatar } from '../components/navShared.js';
import { isRememberStreamEnabled, setRememberStreamEnabled } from '../components/streamPicker.js';
import { navigateTo } from '../runtime/router.js';
import { LANGUAGE_OPTIONS, languageName } from '../runtime/languages.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One grouped list card: an icon'd header (skipped entirely when
// no title is given, RemoveShow/Sign out's own bare single-row card)
// naming what the rows underneath it are, real .jellio-settings-row
// children appended by the caller onto the returned body rather than
// this helper guessing how many there will be or what kind.
function buildCard(iconName, title, description) {
  const card = el('div', 'jellio-settings-card');
  if (title) {
    const header = el('div', 'jellio-settings-card-header');
    header.appendChild(el('span', 'jellio-settings-card-icon material-icons ' + iconName));
    const heading = el('div', 'jellio-settings-card-heading');
    heading.appendChild(el('h2', 'jellio-settings-card-title', title));
    if (description) heading.appendChild(el('p', 'jellio-settings-card-description', description));
    header.appendChild(heading);
    card.appendChild(header);
  }
  const body = el('div', title ? 'jellio-settings-card-body' : '');
  card.appendChild(body);
  return { card: card, body: body };
}

// The three real row shapes every card below is built from: a plain
// info/control row, a whole-row button (Change avatar, Open admin
// dashboard, real chevron trailing it), and a leading icon + title/
// description column every one of them shares.
function buildRowShell(iconName, title, description) {
  const row = el('div', 'jellio-settings-row');
  if (iconName) row.appendChild(el('span', 'jellio-settings-row-icon material-icons ' + iconName));
  const text = el('div', 'jellio-settings-row-text');
  text.appendChild(el('span', 'jellio-settings-row-title', title));
  if (description) text.appendChild(el('span', 'jellio-settings-row-description', description));
  row.appendChild(text);
  return row;
}

function buildRow(iconName, title, description, control) {
  const row = buildRowShell(iconName, title, description);
  if (control) {
    const controlWrap = el('div', 'jellio-settings-row-control');
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);
  }
  return row;
}

// Change avatar/Open admin dashboard/Sign out: the entire row is the
// real button rather than a small button floating at a label's own
// end, same real "whole row is the hit target" convention every
// mobile/TV settings list already uses. danger flags Sign out's own
// real destructive colour (see .jellio-settings-row-danger's own CSS
// header for why that colour specifically).
function buildActionRow(iconName, title, description, onClick, danger) {
  const row = el('div', 'jellio-settings-row' + (danger ? ' jellio-settings-row-danger' : ''));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-settings-row-button';
  if (iconName) button.appendChild(el('span', 'jellio-settings-row-icon material-icons ' + iconName));
  const text = el('div', 'jellio-settings-row-text');
  text.appendChild(el('span', 'jellio-settings-row-title', title));
  if (description) text.appendChild(el('span', 'jellio-settings-row-description', description));
  button.appendChild(text);
  button.appendChild(el('span', 'jellio-settings-row-chevron material-icons', 'chevron_right'));
  button.addEventListener('click', onClick);
  row.appendChild(button);
  return row;
}

// Remember my stream choice: this codebase's own toggle switch, a
// plain hidden checkbox driving a styled sibling track/thumb (the
// standard accessible pattern for one rather than a div with a click
// handler pretending to be one), now the trailing control on a real
// settings row instead of its own top level section.
function buildToggleRow(iconName, title, description, checked, onChange) {
  const label = document.createElement('label');
  label.className = 'jellio-settings-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'jellio-settings-toggle-input';
  checkbox.checked = checked;
  checkbox.addEventListener('change', function () {
    onChange(checkbox.checked);
  });
  label.appendChild(checkbox);
  label.appendChild(el('span', 'jellio-settings-toggle-track'));
  return buildRow(iconName, title, description, label);
}

function buildSelectRow(iconName, title, description, options, value, onChange) {
  const select = document.createElement('select');
  select.className = 'jellio-settings-select';
  options.forEach(function (option) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  });
  select.value = value;
  const row = buildRow(iconName, title, description, select);
  // A real status line (Saving…, Saved…) belongs directly under this
  // row, full card width, not squeezed in as one more flex child of
  // the row itself: returned as a fragment so it lands as this row's
  // own next real sibling in the card body instead, the same real
  // adjacency .jellio-settings-card-body's own CSS keys its divider
  // borders off.
  const status = el('p', 'jellio-settings-row-status');
  select.addEventListener('change', function () {
    onChange(select.value, select, status);
  });
  const fragment = document.createDocumentFragment();
  fragment.appendChild(row);
  fragment.appendChild(status);
  return fragment;
}

function buildPasswordCard() {
  const { card, body } = buildCard('lock', 'Security', 'Change the password used to sign in to this account.');
  const wrap = el('div', 'jellio-settings-card-body-form');
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

  wrap.appendChild(form);
  body.appendChild(wrap);
  return card;
}

// components/streamPicker.js's own real gate: on, a picker with a
// remembered choice for that title skips straight to it instead of
// asking again; off, every title with real more than one source asks
// every time, same as before this setting existed. screens/detail.js's
// own Change Stream button is the way back in either case, real
// feedback asked for both together rather than only one.
function buildPlaybackCard() {
  const { card, body } = buildCard('play_circle', 'Playback');
  body.appendChild(
    buildToggleRow(
      null,
      'Remember my stream choice',
      'Skip the picker on a repeat play once you have chosen a stream for a title, remembered for 4 days. Use Change Stream on that title’s own page if a remembered one stops working.',
      isRememberStreamEnabled(),
      function (checked) {
        setRememberStreamEnabled(checked);
      },
    ),
  );
  return card;
}

// Real fields, UserDto.Configuration.AudioLanguagePreference/
// SubtitleLanguagePreference (confirmed against UserConfiguration.cs
// before writing this): Jellyfin's own PlaybackInfo negotiation
// already reads these server side to pick a MediaSource's own real
// DefaultAudioStreamIndex/DefaultSubtitleStreamIndex, so saving a
// choice here is the whole fix, nothing else in this codebase needs to
// change for it to take effect on the next real stream negotiated.
function buildLanguageCard(user) {
  const { card, body } = buildCard(
    'translate',
    'Language',
    'Used automatically when Jellyfin picks a stream’s default audio and subtitle track.',
  );

  const configuration = (user && user.Configuration) || {};
  const options = [{ value: '', label: 'No preference' }].concat(
    LANGUAGE_OPTIONS.map(function (option) {
      return { value: option.code, label: option.name };
    }),
  );

  // A saved code might be the alternate ISO form this canonical
  // option list does not itself carry (deu rather than ger, for a
  // preference set from some other real Jellyfin client): matched by
  // real name, the one thing both forms actually agree on, rather
  // than left looking unset.
  function resolveValue(currentCode) {
    const matched = LANGUAGE_OPTIONS.find(function (option) {
      return option.code === (currentCode || '').toLowerCase() || option.name === languageName(currentCode);
    });
    return matched ? matched.code : '';
  }

  let audioValue = resolveValue(configuration.AudioLanguagePreference);
  let subtitleValue = resolveValue(configuration.SubtitleLanguagePreference);

  function save(status) {
    status.textContent = 'Saving…';
    updateLanguagePreferences(audioValue, subtitleValue)
      .then(function () {
        status.textContent = 'Saved, takes effect the next time you start playback.';
      })
      .catch(function (err) {
        console.warn('Jellio: could not update language preferences', err);
        status.textContent = 'Could not save language preferences.';
      });
  }

  body.appendChild(
    buildSelectRow(null, 'Default audio language', null, options, audioValue, function (value, select, status) {
      audioValue = value;
      save(status);
    }),
  );
  body.appendChild(
    buildSelectRow(null, 'Default subtitle language', null, options, subtitleValue, function (value, select, status) {
      subtitleValue = value;
      save(status);
    }),
  );

  return card;
}

// Real endpoint pair, GET /QuickConnect/Enabled + POST /QuickConnect/
// Authorize: no card at all when the server admin has turned the
// whole real feature off, same reasoning every other self hiding
// card in this screen already uses (buildSleepTimerCard above
// included).
async function buildQuickConnectCard() {
  let enabled = false;
  try {
    enabled = await isQuickConnectEnabled();
  } catch (err) {
    console.warn('Jellio: could not check Quick Connect availability', err);
  }
  if (!enabled) return null;

  const { card, body } = buildCard('link', 'Quick Connect', 'Approve a sign in on another device with its own code.');
  const wrap = el('div', 'jellio-settings-card-body-form');
  const form = document.createElement('form');
  form.className = 'jellio-settings-form';

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.placeholder = 'Code shown on the other device';
  codeInput.autocomplete = 'off';
  codeInput.className = 'jellio-settings-input';
  codeInput.maxLength = 6;

  const status = el('p', 'jellio-settings-status');
  const submit = el('button', 'jellio-settings-button', 'Approve');
  submit.type = 'submit';

  form.appendChild(codeInput);
  form.appendChild(status);
  form.appendChild(submit);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    submit.disabled = true;
    status.textContent = 'Approving…';
    authorizeQuickConnect(code)
      .then(function (authorized) {
        status.textContent = authorized ? 'Device approved.' : 'That code was not recognized.';
        if (authorized) form.reset();
      })
      .catch(function (err) {
        console.warn('Jellio: could not authorize Quick Connect', err);
        status.textContent = 'Could not approve that code.';
      })
      .finally(function () {
        submit.disabled = false;
      });
  });

  wrap.appendChild(form);
  body.appendChild(wrap);
  return card;
}

async function buildSleepTimerCard() {
  const { card, body } = buildCard('bedtime', 'Sleep timer');
  const status = el('p', 'jellio-settings-status', 'No active playback session.');
  const wrap = el('div', 'jellio-settings-card-body-form');
  wrap.appendChild(status);
  body.appendChild(wrap);

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
      wrap.appendChild(cancel);
    } else {
      status.textContent = 'No sleep timer is running.';
    }
  } catch (err) {
    console.warn('Jellio: could not load sleep timer status', err);
  }
  return card;
}

// Real feedback: this whole screen used to be one flat column, every
// section (Profile, Playback, Language, Change password, Sleep timer,
// Quick Connect, Sign out) stacked in a row a reader had to scroll
// past everything else to reach. Nuvio's own real Settings screen
// (screenshot checked before writing this) groups the same kind of
// content behind a category sidebar instead, one category's own
// section(s) visible at a time. Categories below are this app's own
// real equivalent grouping, not a blind copy of Nuvio's own four
// (Account/General/About/Advanced): Nuvio's Content & Discovery,
// Downloads and Integrations categories describe real settings this
// app has no equivalent of at all (no addon management, no offline
// downloads here), nothing to port for those without inventing a
// feature to go with it.
function buildAccountCategory(user) {
  const wrap = el('div', 'jellio-settings-category');

  const { card: profileCard, body: profileBody } = buildCard(
    'person',
    'Profile',
    user ? 'Signed in as ' + user.Name : null,
  );
  profileBody.appendChild(
    buildActionRow('photo_camera', 'Change avatar', null, function () {
      // The sidebar's own avatar used to pick this up for free on the
      // next navigation's own full rebuild; it no longer rebuilds at
      // all past its first real render (components/sidebar.js's own
      // renderSidebar), so a changed avatar needs this live nudge or
      // it never appears until the next reload.
      openAvatarPicker(refreshProfileAvatar);
    }),
  );
  // Real Jellyfin's own UserDto.Policy.IsAdministrator (populated for
  // the signed in user's own real record, confirmed against
  // BaseItemDto before writing this) is the one real gate every
  // native admin link already uses, matched here rather than showing
  // this to every reader. #/dashboard has no entry in app.js's own
  // SCREENS table, so navigating there leaves native jellyfin-web
  // showing through unreskinned, the same real fallback discipline
  // every other unmigrated route already gets.
  if (user && user.Policy && user.Policy.IsAdministrator) {
    profileBody.appendChild(
      buildActionRow('admin_panel_settings', 'Open admin dashboard', null, function () {
        navigateTo('#/dashboard');
      }),
    );
  }
  wrap.appendChild(profileCard);

  wrap.appendChild(buildPasswordCard());

  const { card: signOutCard, body: signOutBody } = buildCard(null, null, null);
  signOutBody.appendChild(
    buildActionRow(
      'logout',
      'Sign out',
      null,
      function () {
        logout();
      },
      true,
    ),
  );
  wrap.appendChild(signOutCard);

  return wrap;
}

function buildPlaybackCategory(user) {
  const wrap = el('div', 'jellio-settings-category');
  wrap.appendChild(buildPlaybackCard());
  wrap.appendChild(buildLanguageCard(user));
  return wrap;
}

function buildSessionsCategory(sleepTimerCard, quickConnectCard) {
  const wrap = el('div', 'jellio-settings-category');
  wrap.appendChild(sleepTimerCard);
  if (quickConnectCard) wrap.appendChild(quickConnectCard);
  return wrap;
}

// app.js's own real script tag, the one IndexHtmlPatchService itself
// stamps a ?v= query string onto every release (confirmed against
// that file's own header, and against this exact query string live in
// this server's own served index.html): the one place this plugin's
// own real running version already lives on the page, read back here
// rather than adding a second endpoint just to ask the backend for
// what the page it already served says.
function jellioVersion() {
  const script = document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (!script) return '';
  try {
    return new URL(script.src, window.location.origin).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
}

function buildAboutCategory() {
  const wrap = el('div', 'jellio-settings-category');
  const version = jellioVersion();
  const { card } = buildCard('info', 'About', version ? 'Jellio ' + version : 'Jellio');
  wrap.appendChild(card);
  return wrap;
}

const CATEGORY_ICONS = {
  account: 'person',
  playback: 'play_circle',
  sessions: 'devices',
  about: 'info',
};

export async function renderSettings(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-settings';

  const header = el('header', 'jellio-settings-header');
  header.appendChild(el('h1', 'jellio-settings-title', 'Settings'));
  root.appendChild(header);

  // buildSleepTimerCard/buildQuickConnectCard each own real network
  // round trip and neither one depends on the signed in user's own
  // data at all, so all three fire together here instead of those two
  // cards each waiting on the user fetch to even start.
  const [userResult, sleepTimerCard, quickConnectCard] = await Promise.all([
    getCurrentUser().catch(function (err) {
      console.warn('Jellio: could not load current user', err);
      return null;
    }),
    buildSleepTimerCard(),
    buildQuickConnectCard(),
  ]);
  const user = userResult;

  const categories = [
    { id: 'account', label: 'Account', build: function () { return buildAccountCategory(user); } },
    { id: 'playback', label: 'Playback', build: function () { return buildPlaybackCategory(user); } },
    {
      id: 'sessions',
      label: 'Sessions',
      build: function () { return buildSessionsCategory(sleepTimerCard, quickConnectCard); },
    },
    { id: 'about', label: 'About', build: buildAboutCategory },
  ];

  const layout = el('div', 'jellio-settings-layout');
  const nav = el('nav', 'jellio-settings-nav');
  nav.setAttribute('role', 'tablist');
  const content = el('div', 'jellio-settings-content');
  layout.appendChild(nav);
  layout.appendChild(content);
  root.appendChild(layout);

  function selectCategory(category, button) {
    Array.prototype.forEach.call(nav.children, function (child) {
      child.classList.remove('jellio-settings-nav-item-active');
      child.setAttribute('aria-selected', 'false');
    });
    button.classList.add('jellio-settings-nav-item-active');
    button.setAttribute('aria-selected', 'true');
    content.textContent = '';
    content.appendChild(category.build());
  }

  categories.forEach(function (category, index) {
    const button = el('button', 'jellio-settings-nav-item');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.appendChild(el('span', 'material-icons jellio-settings-nav-icon ' + CATEGORY_ICONS[category.id]));
    button.appendChild(el('span', 'jellio-settings-nav-label', category.label));
    button.addEventListener('click', function () {
      selectCategory(category, button);
    });
    nav.appendChild(button);
    if (index === 0) selectCategory(category, button);
  });
}
