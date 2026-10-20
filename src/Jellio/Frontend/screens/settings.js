// Settings, this runtime's own screen, the sidebar's Settings link's
// own real destination (components/navShared.js's own SETTINGS_LINK,
// #/account). A category sidebar (Account/Playback/Reading/Sessions/
// Display/About)
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
import { PREBUFFER_OPTIONS, getPrebufferLevel, setPrebufferLevel } from '../runtime/bufferSettings.js';
import {
  getCurrentUser,
  saveServerDisplayLanguage,
  updateUserPassword,
  getSleepTimerStatus,
  cancelSleepTimer,
  updateLanguagePreferences,
  isQuickConnectEnabled,
  authorizeQuickConnect,
  getProfileSettings,
  setProfilePrivacy,
  setGrouplistEnabled,
  getJellioConfig,
  startMangaImport,
  getMangaImportStatus,
  clearCachedRows,
  isHomeRowCacheEnabled,
  getCommunityUsers,
  getAllGenres,
  getUserImageUrl,
} from '../runtime/api.js';
import {
  isCommunityRowEnabled,
  setCommunityRowEnabled,
  getCommunityExcludedUsers,
  toggleCommunityExcludedUser,
  getSelectedGenres,
  toggleSelectedGenre,
  setSelectedGenres,
} from '../runtime/recommendationSettings.js';
import { LATEST_CHANGELOG, CHANGELOG_RELEASES, MACOS_CHANGELOG_RELEASES } from '../runtime/changelog.js';
import { invalidateAllHomeSections } from './home.js';

import { logout } from '../runtime/auth.js';
import { setGrouplistEnabledLocal } from '../runtime/grouplistSettings.js';
import { openAvatarPicker } from '../components/avatarPicker.js';
import { refreshProfileAvatar } from '../components/navShared.js';
import { isRememberStreamEnabled, setRememberStreamEnabled } from '../components/streamPicker.js';
import { isAutoPipEnabled, setAutoPipEnabled } from '../runtime/pipSettings.js';
import { MOTION_OPTIONS, getMotionPreference, setMotionPreference } from '../runtime/motionSettings.js';
import {
  UPNEXT_COUNTDOWN_OPTIONS,
  getUpNextCountdownSeconds,
  setUpNextCountdownSeconds,
} from '../runtime/upNextSettings.js';
import {
  isAutoDeleteWatchedEnabled,
  setAutoDeleteWatchedEnabled,
  isAutoDeleteReadEnabled,
  setAutoDeleteReadEnabled,
} from '../runtime/offline.js';
import { getDefaultAudiobookSpeed, setDefaultAudiobookSpeed } from '../components/audioMiniPlayer.js';
import { navigateTo } from '../runtime/router.js';
import { LANGUAGE_OPTIONS, languageName } from '../runtime/languages.js';
import { DISPLAY_LANGUAGES, getDisplayLanguage, setDisplayLanguage, t } from '../runtime/i18n.js';
import {
  LANGUAGES,
  languageLabel,
  readTargetLanguage,
  writeTargetLanguage,
  readDefaultBookLanguage,
  writeDefaultBookLanguage,
} from '../components/readerStudy.js';
import { el } from '../runtime/dom.js';
import { openOnboardingModal } from '../components/onboardingModal.js';

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

function buildExpandableCard(iconName, title, description, initialExpanded) {
  const isExpanded = Boolean(initialExpanded);
  const card = el('div', 'jellio-settings-card' + (isExpanded ? ' jellio-settings-card-open' : ''));
  const headerBtn = document.createElement('button');
  headerBtn.type = 'button';
  headerBtn.className = 'jellio-settings-card-header jellio-settings-card-header-clickable';
  headerBtn.setAttribute('aria-expanded', String(isExpanded));

  if (iconName) {
    headerBtn.appendChild(el('span', 'jellio-settings-card-icon material-icons ' + iconName));
  }
  const heading = el('div', 'jellio-settings-card-heading');
  heading.appendChild(el('h2', 'jellio-settings-card-title', title));
  if (description) heading.appendChild(el('p', 'jellio-settings-card-description', description));
  headerBtn.appendChild(heading);

  const chevron = el('span', 'jellio-settings-expand-arrow material-icons', 'keyboard_arrow_down');
  headerBtn.appendChild(chevron);
  card.appendChild(headerBtn);

  const body = el('div', 'jellio-settings-card-body');
  if (!isExpanded) {
    body.style.display = 'none';
  }
  card.appendChild(body);

  headerBtn.addEventListener('click', function () {
    const currentlyExpanded = headerBtn.getAttribute('aria-expanded') === 'true';
    const nextState = !currentlyExpanded;
    headerBtn.setAttribute('aria-expanded', String(nextState));
    if (nextState) {
      body.style.display = '';
      card.classList.add('jellio-settings-card-open');
    } else {
      body.style.display = 'none';
      card.classList.remove('jellio-settings-card-open');
    }
  });

  return { card: card, body: body, headerBtn: headerBtn };
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
  const row = el('div', 'jellio-settings-row jellio-settings-row-action' + (danger ? ' jellio-settings-row-danger' : ''));
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
  const { card, body } = buildCard('lock', t('settings_security_title'), t('settings_security_desc'));
  const wrap = el('div', 'jellio-settings-card-body-form');
  const form = document.createElement('form');
  form.className = 'jellio-settings-form';

  const current = document.createElement('input');
  current.type = 'password';
  current.placeholder = t('settings_current_password');
  current.autocomplete = 'current-password';
  current.className = 'jellio-settings-input';

  const next = document.createElement('input');
  next.type = 'password';
  next.placeholder = t('settings_new_password');
  next.autocomplete = 'new-password';
  next.className = 'jellio-settings-input';

  const confirm = document.createElement('input');
  confirm.type = 'password';
  confirm.placeholder = t('settings_confirm_password');
  confirm.autocomplete = 'new-password';
  confirm.className = 'jellio-settings-input';

  const status = el('p', 'jellio-settings-status');

  const submit = el('button', 'jellio-settings-button', t('settings_update_password'));
  submit.type = 'submit';

  form.appendChild(current);
  form.appendChild(next);
  form.appendChild(confirm);
  form.appendChild(status);
  form.appendChild(submit);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!next.value || next.value !== confirm.value) {
      status.textContent = t('auth_passwords_mismatch');
      return;
    }
    submit.disabled = true;
    status.textContent = t('settings_updating_password');
    updateUserPassword(current.value, next.value)
      .then(function () {
        status.textContent = t('settings_password_updated');
        form.reset();
      })
      .catch(function (err) {
        console.warn('Jellio: could not update password', err);
        status.textContent = t('settings_password_error');
      })
      .finally(function () {
        submit.disabled = false;
      });
  });

  wrap.appendChild(form);
  body.appendChild(wrap);
  return card;
}

// Real Steam-style ask: on, a reader's own profile picture and banner
// stay visible to other users, only Controllers/AchievementsController.
// cs's own badge/stats answer for this user goes dark for anyone but
// them (server side, GetForUser's own header explains the split).
// Fetched alongside sleepTimerCard/quickConnectCard in renderSettings
// below rather than inside buildAccountCategory itself, same real
// reason those two already are: this card owns its own network round
// trip, no reason to block the rest of the screen's own first render
// on it.
async function buildPrivacyCard() {
  let isPrivate = false;
  try {
    const settings = await getProfileSettings();
    isPrivate = !!(settings && settings.IsPrivate);
  } catch (err) {
    console.warn('Jellio: could not load profile privacy setting', err);
  }

  const { card, body } = buildCard('visibility_off', t('settings_privacy_title'), t('settings_privacy_desc'));
  body.appendChild(
    buildToggleRow(
      null,
      t('onboarding_private_label'),
      t('onboarding_private_desc'),
      isPrivate,
      function (checked) {
        setProfilePrivacy(checked).catch(function (err) {
          console.warn('Jellio: could not update profile privacy', err);
        });
      },
    ),
  );
  return card;
}

// Off by default, real feedback's own explicit ask: a reader who never
// turns this on should see nothing different at all, no watchlist
// button suddenly asking Watchlist or Grouplist on every click. On,
// components/card.js's own watchlist button and screens/detail.js's
// own version of it both gain a list picker, screens/home.js's own
// Watchlist tab gains a Grouplist toggle alongside it, and Group Watch
// chat gains a ranking session that draws from it.
async function buildGrouplistCard() {
  let grouplistEnabled = false;
  try {
    const settings = await getProfileSettings();
    grouplistEnabled = !!(settings && settings.GrouplistEnabled);
  } catch (err) {
    console.warn('Jellio: could not load Grouplist setting', err);
  }
  setGrouplistEnabledLocal(grouplistEnabled);

  const { card, body } = buildCard('groups', t('settings_groupwatch_title'), t('settings_groupwatch_desc'));
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_grouplist_label'),
      t('settings_grouplist_desc'),
      grouplistEnabled,
      function (checked) {
        setGrouplistEnabledLocal(checked);
        setGrouplistEnabled(checked).catch(function (err) {
          console.warn('Jellio: could not update Grouplist setting', err);
        });
      },
    ),
  );
  return card;
}

// components/streamPicker.js's own real gate: on, a picker with a
// remembered choice for that title skips straight to it instead of
// asking again; off, every title with real more than one source asks
// every time, same as before this setting existed. screens/detail.js's
// own Change Stream button is the way back in either case, real
// feedback asked for both together rather than only one.
// Real feedback, live: this used to also carry an admin only "Analyze
// library" row (IntroCreditsController's own now-removed analyze-library
// route) queuing a whole-library background sweep. Dropped once a real
// server's own stack trace showed why that could never actually work:
// Gelato's own resolution only runs a real Stremio/debrid lookup from
// inside a real ASP.NET request it recognizes, a detached background
// job gets a cheap gelato://stub/... placeholder back instead, so that
// button could queue work but never actually resolve a real stream for
// any of it. IntroCreditsController.cs's own real POST /analyze/{itemId}
// (screens/player.js's own real playback-start trigger) is the one
// real path left, a small forward looking batch analyzed inside that
// same real request every time a reader starts a new episode.
function buildPlaybackCard() {
  const { card, body } = buildCard('play_circle', t('settings_playback_title'));
  body.appendChild(
    buildSelectRow(
      null,
      t('settings_prebuffer_label'),
      t('settings_prebuffer_desc'),
      PREBUFFER_OPTIONS,
      getPrebufferLevel(),
      function (value, select, status) {
        setPrebufferLevel(value);
        status.textContent = t('settings_saved_next_video');
      },
    ),
  );
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_remember_stream'),
      t('settings_remember_stream_desc'),
      isRememberStreamEnabled(),
      function (checked) {
        setRememberStreamEnabled(checked);
      },
    ),
  );
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_delete_watched'),
      t('settings_delete_watched_desc'),
      isAutoDeleteWatchedEnabled(),
      function (checked) {
        setAutoDeleteWatchedEnabled(checked);
      },
    ),
  );
  if (document.pictureInPictureEnabled) {
    body.appendChild(
      buildToggleRow(
        null,
        t('settings_pip_label'),
        t('settings_pip_desc'),
        isAutoPipEnabled(),
        function (checked) {
          setAutoPipEnabled(checked);
        },
      ),
    );
  }
  body.appendChild(
    buildSelectRow(
      null,
      t('settings_up_next_timer'),
      t('settings_up_next_timer_desc'),
      UPNEXT_COUNTDOWN_OPTIONS,
      String(getUpNextCountdownSeconds()),
      function (value, select, status) {
        setUpNextCountdownSeconds(Number(value));
        status.textContent = t('settings_saved_next_episode');
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
    t('onboarding_step_playback'),
    t('onboarding_playback_sub'),
  );

  const configuration = (user && user.Configuration) || {};
  const options = [{ value: '', label: t('settings_no_preference') }].concat(
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
    status.textContent = t('action_saving');
    updateLanguagePreferences(audioValue, subtitleValue)
      .then(function () {
        status.textContent = t('settings_saved_next_playback');
      })
      .catch(function (err) {
        console.warn('Jellio: could not update language preferences', err);
        status.textContent = t('settings_save_lang_error');
      });
  }

  body.appendChild(
    buildSelectRow(null, t('settings_default_audio'), null, options, audioValue, function (value, select, status) {
      audioValue = value;
      save(status);
    }),
  );
  body.appendChild(
    buildSelectRow(null, t('settings_default_subtitle'), null, options, subtitleValue, function (value, select, status) {
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

  const { card, body } = buildCard('link', t('settings_quick_connect'), t('settings_quick_connect_desc'));
  const wrap = el('div', 'jellio-settings-card-body-form');
  const form = document.createElement('form');
  form.className = 'jellio-settings-form';

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.placeholder = t('settings_quick_connect_placeholder');
  codeInput.autocomplete = 'off';
  codeInput.className = 'jellio-settings-input';
  codeInput.maxLength = 6;

  const status = el('p', 'jellio-settings-status');
  const submit = el('button', 'jellio-settings-button', t('settings_quick_connect_approve'));
  submit.type = 'submit';

  form.appendChild(codeInput);
  form.appendChild(status);
  form.appendChild(submit);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    submit.disabled = true;
    status.textContent = t('settings_quick_connect_approving');
    authorizeQuickConnect(code)
      .then(function (authorized) {
        status.textContent = authorized ? t('settings_quick_connect_approved') : t('settings_quick_connect_invalid');
        if (authorized) form.reset();
      })
      .catch(function (err) {
        console.warn('Jellio: could not authorize Quick Connect', err);
        status.textContent = t('settings_quick_connect_error');
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
  const { card, body } = buildCard('bedtime', t('settings_sleep_timer'));
  const status = el('p', 'jellio-settings-status', t('settings_sleep_timer_empty'));
  const wrap = el('div', 'jellio-settings-card-body-form');
  wrap.appendChild(status);
  body.appendChild(wrap);

  try {
    const result = await getSleepTimerStatus();
    if (result && result.Active) {
      status.textContent = t('settings_sleep_timer_running');
      const cancel = el('button', 'jellio-settings-button', t('settings_sleep_timer_cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        cancelSleepTimer()
          .then(function () {
            status.textContent = t('settings_sleep_timer_cancelled');
            cancel.remove();
          })
          .catch(function (err) {
            console.warn('Jellio: could not cancel sleep timer', err);
            cancel.disabled = false;
          });
      });
      wrap.appendChild(cancel);
    } else {
      status.textContent = t('settings_sleep_timer_none');
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
function buildAccountCategory(user, privacyCard, grouplistCard) {
  const wrap = el('div', 'jellio-settings-category');

  const { card: profileCard, body: profileBody } = buildCard(
    'person',
    t('nav_profile'),
    user ? t('settings_signed_in_as', { name: user.Name }) : null,
  );
  profileBody.appendChild(
    buildActionRow('photo_camera', t('onboarding_change_avatar'), null, function () {
      // The sidebar's own avatar used to pick this up for free on the
      // next navigation's own full rebuild; it no longer rebuilds at
      // all past its first real render (components/sidebar.js's own
      // renderSidebar), so a changed avatar needs this live nudge or
      // it never appears until the next reload.
      openAvatarPicker(refreshProfileAvatar);
    }),
  );
  profileBody.appendChild(
    buildActionRow('badge', t('settings_view_profile'), t('settings_view_profile_desc'), function () {
      navigateTo('#/profile');
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
      buildActionRow('admin_panel_settings', t('settings_admin_dashboard'), null, function () {
        navigateTo('#/dashboard');
      }),
    );
  }
  wrap.appendChild(profileCard);

  wrap.appendChild(buildPasswordCard());
  wrap.appendChild(privacyCard);
  wrap.appendChild(grouplistCard);

  const { card: signOutCard, body: signOutBody } = buildCard(null, null, null);
  signOutBody.appendChild(
    buildActionRow(
      'logout',
      t('nav_sign_out'),
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

// Import from Mihon: a reader's backup file brings their manga library
// over through Suwayomi (Services/Manga/MangaImportService.cs). Only
// offered when the server has Suwayomi set up.
const IMPORT_OUTCOMES = { imported: 'Imported', 'not-found': 'Not found', error: 'Failed', skipped: 'Skipped' };

function buildMihonImportCard() {
  const { card, body } = buildCard(
    'collections_bookmark',
    'Import from Mihon',
    'Brings your Mihon library over: every series with its categories, reading progress, history, bookmarks, notes and reading mode, read straight from the same sources.',
  );

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tachibk,.proto.gz,.gz';
  input.hidden = true;
  body.appendChild(input);
  body.appendChild(
    buildActionRow(
      'upload_file',
      'Choose a backup file',
      t('settings_mihon_hint'),
      function () {
        input.click();
      },
    ),
  );

  const status = el('div', 'jellio-settings-import');
  body.appendChild(status);
  let timer = null;

  function render(response) {
    status.textContent = '';
    const job = response && response.Job;
    const pending = (response && response.PendingChapters) || 0;
    if (!job) {
      if (pending) status.appendChild(el('p', 'jellio-settings-row-description', pending + ' chapters of progress are waiting for their downloads.'));
      return;
    }
    const running = job.Status === 'running';
    const imported = job.Series.filter((series) => series.Outcome === 'imported').length;
    const headline = running
      ? 'Importing ' + Math.min(job.Processed + 1, job.Total) + ' of ' + job.Total + '…'
      : job.Status === 'failed'
        ? 'The import stopped early.'
        : 'Imported ' + imported + ' of ' + job.Total + ' series.';
    status.appendChild(el('p', 'jellio-settings-import-headline', headline));
    if (pending) {
      status.appendChild(
        el('p', 'jellio-settings-row-description', pending + ' chapters of progress will be applied as their downloads reach the library.'),
      );
    }
    const list = el('ul', 'jellio-settings-import-list');
    job.Series.forEach(function (series) {
      const item = el('li', 'jellio-settings-import-item jellio-settings-import-' + series.Outcome);
      item.appendChild(el('span', 'jellio-settings-import-title', series.Title));
      const detail = [IMPORT_OUTCOMES[series.Outcome] || series.Outcome];
      if (series.QueuedChapters) detail.push(series.QueuedChapters + ' to download');
      if (series.Message) detail.push(series.Message);
      item.appendChild(el('span', 'jellio-settings-row-description', detail.join(' · ')));
      list.appendChild(item);
    });
    if (job.Series.length) status.appendChild(list);
    if (running) poll();
  }

  function poll() {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      if (!card.isConnected) return;
      getMangaImportStatus().then(render).catch(function () {
        poll();
      });
    }, 2000);
  }

  input.addEventListener('change', function () {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    status.textContent = '';
    status.appendChild(el('p', 'jellio-settings-import-headline', t('settings_reading_file', { file: file.name })));
    startMangaImport(file)
      .then(render)
      .catch(function (err) {
        status.textContent = '';
        status.appendChild(el('p', 'jellio-settings-import-failed', (err && err.message) || 'Import failed'));
      });
  });

  getMangaImportStatus().then(render).catch(function () {});
  return card;
}

// Translation and dictionary defaults for the reader's study tools
// (components/readerStudy.js). Kept on this device, like the rest of the
// reader's settings; each book can still override its own language.
function buildTranslationCard(translationEnabled) {
  const { card, body } = buildCard(
    'translate',
    t('settings_translation_dict_title'),
    t('settings_translation_dict_desc'),
  );
  const languages = LANGUAGES.map((code) => ({ value: code, label: languageLabel(code) })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  if (translationEnabled) {
    body.appendChild(
      buildSelectRow(null, t('onboarding_translate_into'), t('settings_translate_into_desc'), languages, readTargetLanguage(), function (value, select, status) {
        writeTargetLanguage(value);
        status.textContent = t('action_saved');
      }),
    );
  } else {
    body.appendChild(
      buildRow(null, t('settings_translation_off_title'), t('settings_translation_off_desc'), null),
    );
  }

  body.appendChild(
    buildSelectRow(
      null,
      t('settings_books_language_title'),
      t('settings_books_language_desc'),
      [{ value: 'auto', label: t('settings_detect_auto') }].concat(languages),
      readDefaultBookLanguage(),
      function (value, select, status) {
        writeDefaultBookLanguage(value);
        status.textContent = t('settings_saved_books_lang');
      },
    ),
  );

  body.appendChild(
    buildActionRow('style', t('settings_vocab_deck'), t('settings_vocab_deck_desc'), function () {
      navigateTo('#/vocab');
    }),
  );
  return card;
}

function buildReadingOfflineCard() {
  const { card, body } = buildCard('auto_stories', t('settings_reading_audiobooks'));
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_delete_reading'),
      t('settings_delete_reading_desc'),
      isAutoDeleteReadEnabled(),
      function (checked) {
        setAutoDeleteReadEnabled(checked);
      },
    ),
  );
  const speedOptions = [
    { value: '0.75', label: '0.75×' },
    { value: '1', label: '1× (Normal)' },
    { value: '1.25', label: '1.25×' },
    { value: '1.5', label: '1.5×' },
    { value: '1.75', label: '1.75×' },
    { value: '2', label: '2×' },
  ];
  body.appendChild(
    buildSelectRow(
      null,
      t('settings_audiobook_speed'),
      t('settings_audiobook_speed_desc'),
      speedOptions,
      String(getDefaultAudiobookSpeed()),
      function (val, select, status) {
        setDefaultAudiobookSpeed(Number(val));
        status.textContent = t('action_saved');
        window.setTimeout(() => { status.textContent = ''; }, 2000);
      },
    ),
  );
  return card;
}

function buildReadingCategory(config) {
  const wrap = el('div', 'jellio-settings-category');
  wrap.appendChild(buildReadingOfflineCard());
  wrap.appendChild(buildTranslationCard(!!(config && config.TranslationEnabled)));
  if (config && config.MangaRequestsEnabled) wrap.appendChild(buildMihonImportCard());
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

// The macOS app (Jellio-macOS) checks, downloads and installs its own
// updates; this card shows where that's at and drives it.
function describeAppUpdate(state) {
  switch (state.status) {
    case 'checking':
      return t('settings_app_checking');
    case 'up-to-date':
      return t('settings_app_up_to_date');
    case 'available':
      return t('settings_app_available', { version: state.latest });
    case 'downloading':
      return t('settings_app_downloading', { version: state.latest, percent: Math.round((state.progress || 0) * 100) });
    case 'installing':
      return t('settings_app_installing', { version: state.latest });
    case 'restarting':
      return t('settings_app_restarting', { version: state.latest });
    case 'error':
      return state.error || t('request_failed');
    default:
      return state.checkedAt ? t('settings_app_last_checked', { date: new Date(state.checkedAt).toLocaleString() }) : t('settings_app_not_checked');
  }
}

function buildAppUpdateCard(native) {
  const { card, body } = buildCard('laptop_mac', t('settings_macos_title'), t('settings_macos_desc'));
  const action = el('button', 'jellio-settings-button', t('settings_check_updates'));
  action.type = 'button';
  const statusRow = buildRow(null, t('settings_version'), '', action);
  const description = el('span', 'jellio-settings-row-description');
  statusRow.querySelector('.jellio-settings-row-text').appendChild(description);
  body.appendChild(statusRow);

  let current = null;
  let toggleInput = null;
  body.appendChild(
    buildToggleRow(null, t('settings_check_auto'), t('settings_check_auto_desc'), true, function (checked) {
      native.setAutomatic(checked).catch(function (err) {
        console.warn('Jellio: could not save the update setting', err);
      });
    }),
  );
  toggleInput = body.querySelector('.jellio-settings-toggle-input');

  function paint(state) {
    if (!state) return;
    current = state;
    statusRow.querySelector('.jellio-settings-row-title').textContent = t('settings_version') + ' ' + state.current;
    description.textContent = describeAppUpdate(state);
    const working = ['checking', 'downloading', 'installing', 'restarting'].indexOf(state.status) !== -1;
    action.disabled = working;
    action.textContent = state.status === 'available' ? t('settings_app_install', { version: state.latest }) : working ? t('settings_app_working') : t('settings_check_updates');
    if (toggleInput) toggleInput.checked = state.automatic !== false;
  }

  action.addEventListener('click', function () {
    const call = current && current.status === 'available' ? native.install() : native.check();
    call.then(paint).catch(function (err) {
      console.warn('Jellio: update action failed', err);
    });
  });

  const stop = native.onChange(function (state) {
    if (!card.isConnected) {
      stop();
      return;
    }
    paint(state);
  });
  native.getState().then(paint).catch(function () {});

  if (Array.isArray(MACOS_CHANGELOG_RELEASES) && MACOS_CHANGELOG_RELEASES.length > 0) {
    const macWrap = el('div', 'jellio-settings-macos-changelog-wrap');
    macWrap.style.marginTop = '16px';
    macWrap.style.borderTop = '1px solid rgba(255, 255, 255, 0.08)';
    macWrap.style.paddingTop = '14px';

    const macHeader = el('div', 'jellio-settings-row-title', t('settings_macos_whats_new'));
    macHeader.style.marginBottom = '8px';
    macWrap.appendChild(macHeader);

    const macList = el('div', 'jellio-settings-changelog-list');
    const latestMac = MACOS_CHANGELOG_RELEASES[0];
    const prevMac = MACOS_CHANGELOG_RELEASES.slice(1);

    (latestMac.highlights || []).forEach(function (h) {
      const item = el('div', 'jellio-settings-changelog-item');
      item.appendChild(el('div', 'jellio-settings-changelog-item-title', h.title));
      item.appendChild(el('div', 'jellio-settings-changelog-item-desc', h.description));
      macList.appendChild(item);
    });
    macWrap.appendChild(macList);

    if (prevMac.length > 0) {
      const prevWrap = el('div', 'jellio-settings-changelog-previous-wrap');
      const prevToggle = document.createElement('button');
      prevToggle.type = 'button';
      prevToggle.className = 'jellio-settings-sub-expander';
      prevToggle.setAttribute('aria-expanded', 'false');

      const prevLabel = el('span', 'jellio-settings-sub-label', t('settings_macos_prev_versions', { count: prevMac.length }));
      const prevArrow = el('span', 'jellio-settings-sub-arrow material-icons', 'keyboard_arrow_down');
      prevToggle.appendChild(prevLabel);
      prevToggle.appendChild(prevArrow);
      prevWrap.appendChild(prevToggle);

      const prevBody = el('div', 'jellio-settings-sub-body');
      prevBody.style.display = 'none';

      prevMac.forEach(function (rel) {
        const verCard = el('div', 'jellio-settings-version-card');
        const verHeader = document.createElement('button');
        verHeader.type = 'button';
        verHeader.className = 'jellio-settings-version-header';
        verHeader.setAttribute('aria-expanded', 'false');

        const verTitle = el('span', 'jellio-settings-version-title', rel.subtitle || (t('settings_version') + ' ' + rel.version));
        const verArrow = el('span', 'jellio-settings-sub-arrow material-icons', 'keyboard_arrow_down');
        verHeader.appendChild(verTitle);
        verHeader.appendChild(verArrow);
        verCard.appendChild(verHeader);

        const verContent = el('div', 'jellio-settings-changelog-list');
        verContent.style.display = 'none';
        verContent.style.paddingTop = '0';
        (rel.highlights || []).forEach(function (h) {
          const item = el('div', 'jellio-settings-changelog-item');
          item.appendChild(el('div', 'jellio-settings-changelog-item-title', h.title));
          item.appendChild(el('div', 'jellio-settings-changelog-item-desc', h.description));
          verContent.appendChild(item);
        });
        verCard.appendChild(verContent);

        verHeader.addEventListener('click', function () {
          const isExp = verHeader.getAttribute('aria-expanded') === 'true';
          const next = !isExp;
          verHeader.setAttribute('aria-expanded', String(next));
          verContent.style.display = next ? '' : 'none';
        });

        prevBody.appendChild(verCard);
      });

      prevToggle.addEventListener('click', function () {
        const isExp = prevToggle.getAttribute('aria-expanded') === 'true';
        const next = !isExp;
        prevToggle.setAttribute('aria-expanded', String(next));
        prevBody.style.display = next ? '' : 'none';
      });

      prevWrap.appendChild(prevBody);
      macWrap.appendChild(prevWrap);
    }

    body.appendChild(macWrap);
  }

  return card;
}

// The home row cache (runtime/rowcache.js) lives in this browser; this
// empties it for every tab.
function buildHomeCacheCard() {
  const { card, body } = buildCard('home', t('settings_home_cache'));
  const row = buildActionRow(
    'delete_sweep',
    t('settings_clear_cache_btn'),
    isHomeRowCacheEnabled()
      ? t('settings_cache_enabled_desc')
      : t('settings_cache_disabled'),
    function () {
      clearCachedRows();
      const description = row.querySelector('.jellio-settings-row-description');
      if (description) description.textContent = t('settings_cache_cleared');
    },
  );
  body.appendChild(row);
  return card;
}

function buildRecommendationsCategory() {
  const wrap = el('div', 'jellio-settings-category');

  // --- Card 1: What Others Are Watching ---
  const { card: communityCard, body: communityBody } = buildCard(
    'group',
    t('home_community_watching'),
    t('settings_community_desc'),
  );

  let excludedSet = new Set(getCommunityExcludedUsers());

  const rowToggle = buildToggleRow(
    'visibility',
    t('settings_community_toggle'),
    t('settings_community_toggle_desc'),
    isCommunityRowEnabled(),
    function (enabled) {
      setCommunityRowEnabled(enabled);
      invalidateAllHomeSections();
      clearCachedRows();
      if (usersSubcard) {
        usersSubcard.style.display = enabled ? 'block' : 'none';
      }
    },
  );
  communityBody.appendChild(rowToggle);

  const usersSubcard = el('div', 'jellio-settings-subcard');
  if (!isCommunityRowEnabled()) {
    usersSubcard.style.display = 'none';
  }

  const subcardHeader = el('div', 'jellio-settings-subcard-header');
  subcardHeader.appendChild(el('h3', 'jellio-settings-subcard-title', t('settings_community_included')));
  subcardHeader.appendChild(
    el(
      'p',
      'jellio-settings-subcard-description',
      t('settings_community_included_desc'),
    ),
  );
  usersSubcard.appendChild(subcardHeader);

  const usersList = el('div', 'jellio-settings-user-list');
  usersSubcard.appendChild(usersList);

  const loadingNote = el('p', 'jellio-settings-empty-note', t('status_loading'));
  usersList.appendChild(loadingNote);

  getCommunityUsers()
    .then(function (users) {
      usersList.textContent = '';
      if (!users || users.length === 0) {
        usersList.appendChild(el('p', 'jellio-settings-empty-note', t('settings_community_no_users')));
        return;
      }
      users.forEach(function (user) {
        const userRow = el('div', 'jellio-settings-user-row');

        const avatarWrap = el('div', 'jellio-settings-user-avatar-wrap');
        if (user.PrimaryImageTag) {
          const img = el('img', 'jellio-settings-user-avatar');
          img.src = getUserImageUrl(user.Id, user.PrimaryImageTag, { maxWidth: 64 });
          img.alt = user.Name || '';
          avatarWrap.appendChild(img);
        } else {
          const initial = el('span', 'jellio-settings-user-avatar jellio-settings-user-initial', (user.Name || 'U').charAt(0).toUpperCase());
          avatarWrap.appendChild(initial);
        }
        userRow.appendChild(avatarWrap);

        const nameEl = el('span', 'jellio-settings-user-name', user.Name || 'User');
        userRow.appendChild(nameEl);

        const toggleLabel = el('label', 'jellio-settings-toggle');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'jellio-settings-toggle-input';
        checkbox.checked = !excludedSet.has(user.Id);
        checkbox.addEventListener('change', function () {
          toggleCommunityExcludedUser(user.Id);
          excludedSet = new Set(getCommunityExcludedUsers());
          invalidateAllHomeSections();
          clearCachedRows();
        });
        toggleLabel.appendChild(checkbox);
        toggleLabel.appendChild(el('span', 'jellio-settings-toggle-track'));
        userRow.appendChild(toggleLabel);

        usersList.appendChild(userRow);
      });
    })
    .catch(function (err) {
      console.warn('Jellio: could not load community users', err);
      usersList.textContent = '';
      usersList.appendChild(el('p', 'jellio-settings-empty-note', t('settings_community_load_error')));
    });

  communityBody.appendChild(usersSubcard);
  wrap.appendChild(communityCard);

  // --- Card 2: Genre Recommendations ---
  const { card: genreCard, body: genreBody } = buildCard(
    'movie_filter',
    t('settings_genres_title'),
    t('settings_genres_desc'),
  );

  const genresWrap = el('div', 'jellio-settings-genres-wrap');
  const pillsContainer = el('div', 'jellio-settings-genre-pills');
  genresWrap.appendChild(pillsContainer);

  const loadingGenres = el('p', 'jellio-settings-empty-note', t('status_loading'));
  pillsContainer.appendChild(loadingGenres);

  const actionsWrap = el('div', 'jellio-settings-genre-actions');
  const resetBtn = el('button', 'jellio-settings-btn-secondary', t('settings_genres_reset'));
  resetBtn.type = 'button';
  actionsWrap.appendChild(resetBtn);
  genresWrap.appendChild(actionsWrap);

  getAllGenres(null, 'Movie,Series')
    .then(function (genres) {
      pillsContainer.textContent = '';
      if (!genres || genres.length === 0) {
        pillsContainer.appendChild(el('p', 'jellio-settings-empty-note', t('settings_genres_empty')));
        return;
      }

      function updatePills() {
        const selected = new Set(getSelectedGenres());
        Array.prototype.forEach.call(pillsContainer.children, function (pill) {
          const g = pill.dataset.genre;
          if (selected.has(g)) {
            pill.classList.add('jellio-genre-pill-active');
            pill.querySelector('.jellio-genre-pill-check').style.display = 'inline';
          } else {
            pill.classList.remove('jellio-genre-pill-active');
            pill.querySelector('.jellio-genre-pill-check').style.display = 'none';
          }
        });
      }

      genres.forEach(function (genre) {
        const pill = el('button', 'jellio-genre-pill');
        pill.type = 'button';
        pill.dataset.genre = genre;

        const check = el('span', 'material-icons jellio-genre-pill-check', 'check');
        check.style.display = 'none';
        pill.appendChild(check);
        pill.appendChild(el('span', '', genre));

        pill.addEventListener('click', function () {
          toggleSelectedGenre(genre);
          invalidateAllHomeSections();
          clearCachedRows();
          updatePills();
        });

        pillsContainer.appendChild(pill);
      });

      resetBtn.addEventListener('click', function () {
        setSelectedGenres([]);
        invalidateAllHomeSections();
        clearCachedRows();
        updatePills();
      });

      updatePills();
    })
    .catch(function (err) {
      console.warn('Jellio: could not load library genres', err);
      pillsContainer.textContent = '';
      pillsContainer.appendChild(el('p', 'jellio-settings-empty-note', t('settings_genres_load_error')));
    });

  genreBody.appendChild(genresWrap);
  wrap.appendChild(genreCard);

  return wrap;
}

// Seasonal effects, per browser (runtime/motionSettings.js), applied on
// the spot by components/seasons.js.
function buildDisplayCategory() {
  const wrap = el('div', 'jellio-settings-category');
  const { card: langCard, body: langBody } = buildCard(
    'translate',
    t('settings_display_language_title'),
    t('settings_display_language_desc'),
  );
  const langOptions = DISPLAY_LANGUAGES.map(function (lang) {
    return { value: lang.code, label: lang.nativeName + ' (' + lang.label + ')' };
  });
  langBody.appendChild(
    buildSelectRow(
      null,
      t('settings_display_language_title'),
      null,
      langOptions,
      getDisplayLanguage(),
      function (value, select, status) {
        setDisplayLanguage(value);
        clearCachedRows();
        saveServerDisplayLanguage(value);
        status.textContent = t('action_saved') + ' (' + t('settings_saved_browser') + ')';
        window.setTimeout(function () {
          window.location.reload();
        }, 500);
      },
    ),
  );
  wrap.appendChild(langCard);
  const { card, body } = buildCard('auto_awesome', t('settings_seasonal_title'), t('settings_seasonal_desc'));
  body.appendChild(
    buildSelectRow(
      null,
      t('settings_motion_label'),
      t('settings_motion_desc'),
      MOTION_OPTIONS.map(function (opt) { return { value: opt.value, label: t('motion_' + opt.value) }; }),
      getMotionPreference(),
      function (value, select, status) {
        setMotionPreference(value);
        status.textContent = t('action_saved') + ' (' + t('settings_saved_browser') + ')';
      },
    ),
  );
  wrap.appendChild(card);

  wrap.appendChild(buildHomeCacheCard());
  return wrap;
}

function buildAboutCategory() {
  const wrap = el('div', 'jellio-settings-category');
  const version = jellioVersion();
  const { card } = buildCard('info', t('settings_about_title'), version ? 'Jellio ' + version : 'Jellio');
  wrap.appendChild(card);

  const { card: wizardCard, body: wizardBody } = buildCard(
    'explore',
    t('onboarding_wizard_card_title'),
    t('onboarding_wizard_card_desc'),
  );
  const wizardRow = el('div', 'jellio-settings-row');
  const wizardBtn = el('button', 'jellio-btn jellio-btn-secondary', t('onboarding_wizard_btn'));
  wizardBtn.type = 'button';
  wizardBtn.style.padding = '8px 18px';
  wizardBtn.style.borderRadius = '999px';
  wizardBtn.style.fontWeight = '600';
  wizardBtn.addEventListener('click', function () {
    openOnboardingModal();
  });
  wizardRow.appendChild(wizardBtn);
  wizardBody.appendChild(wizardRow);
  wrap.appendChild(wizardCard);

  const { card: whatsNewCard, body: whatsNewBody } = buildExpandableCard(
    'auto_awesome',
    t('settings_whats_new'),
    LATEST_CHANGELOG.subtitle,
    false,
  );
  const list = el('div', 'jellio-settings-changelog-list');
  const releases = Array.isArray(CHANGELOG_RELEASES) && CHANGELOG_RELEASES.length ? CHANGELOG_RELEASES : [LATEST_CHANGELOG];
  const latestRelease = releases[0];
  const previousReleases = releases.slice(1);

  // Latest release highlights directly visible
  (latestRelease.highlights || []).forEach(function (h) {
    const item = el('div', 'jellio-settings-changelog-item');
    item.appendChild(el('div', 'jellio-settings-changelog-item-title', h.title));
    item.appendChild(el('div', 'jellio-settings-changelog-item-desc', h.description));
    list.appendChild(item);
  });
  whatsNewBody.appendChild(list);

  // Previous releases nested in a collapsible section to prevent dominating screen height
  if (previousReleases.length > 0) {
    const prevWrap = el('div', 'jellio-settings-changelog-previous-wrap');
    const prevToggle = document.createElement('button');
    prevToggle.type = 'button';
    prevToggle.className = 'jellio-settings-sub-expander';
    prevToggle.setAttribute('aria-expanded', 'false');

    const prevLabel = el('span', 'jellio-settings-sub-label', t('settings_previous_versions', { count: previousReleases.length }));
    const prevArrow = el('span', 'jellio-settings-sub-arrow material-icons', 'keyboard_arrow_down');
    prevToggle.appendChild(prevLabel);
    prevToggle.appendChild(prevArrow);
    prevWrap.appendChild(prevToggle);

    const prevBody = el('div', 'jellio-settings-sub-body');
    prevBody.style.display = 'none';

    previousReleases.forEach(function (rel) {
      const verCard = el('div', 'jellio-settings-version-card');
      const verHeader = document.createElement('button');
      verHeader.type = 'button';
      verHeader.className = 'jellio-settings-version-header';
      verHeader.setAttribute('aria-expanded', 'false');

      const verTitle = el('span', 'jellio-settings-version-title', rel.subtitle || ('Version ' + rel.version));
      const verArrow = el('span', 'jellio-settings-sub-arrow material-icons', 'keyboard_arrow_down');
      verHeader.appendChild(verTitle);
      verHeader.appendChild(verArrow);
      verCard.appendChild(verHeader);

      const verContent = el('div', 'jellio-settings-changelog-list');
      verContent.style.display = 'none';
      verContent.style.paddingTop = '0';
      (rel.highlights || []).forEach(function (h) {
        const item = el('div', 'jellio-settings-changelog-item');
        item.appendChild(el('div', 'jellio-settings-changelog-item-title', h.title));
        item.appendChild(el('div', 'jellio-settings-changelog-item-desc', h.description));
        verContent.appendChild(item);
      });
      verCard.appendChild(verContent);

      verHeader.addEventListener('click', function () {
        const isExp = verHeader.getAttribute('aria-expanded') === 'true';
        const next = !isExp;
        verHeader.setAttribute('aria-expanded', String(next));
        verContent.style.display = next ? '' : 'none';
      });

      prevBody.appendChild(verCard);
    });

    prevToggle.addEventListener('click', function () {
      const isExp = prevToggle.getAttribute('aria-expanded') === 'true';
      const next = !isExp;
      prevToggle.setAttribute('aria-expanded', String(next));
      prevBody.style.display = next ? '' : 'none';
    });

    prevWrap.appendChild(prevBody);
    whatsNewBody.appendChild(prevWrap);
  }

  wrap.appendChild(whatsNewCard);

  const native = window.jellioNative && window.jellioNative.updates;
  if (native) wrap.appendChild(buildAppUpdateCard(native));
  return wrap;
}

const CATEGORY_ICONS = {
  account: 'person',
  playback: 'play_circle',
  reading: 'menu_book',
  sessions: 'devices',
  recommendations: 'auto_awesome',
  display: 'palette',
  about: 'info',
};

export async function renderSettings(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-settings';

  const header = el('header', 'jellio-settings-header');
  header.appendChild(el('h1', 'jellio-settings-title', t('settings_title')));
  root.appendChild(header);

  // buildSleepTimerCard/buildQuickConnectCard each own real network
  // round trip and neither one depends on the signed in user's own
  // data at all, so all three fire together here instead of those two
  // cards each waiting on the user fetch to even start.
  const [userResult, sleepTimerCard, quickConnectCard, privacyCard, grouplistCard, config] = await Promise.all([
    getCurrentUser().catch(function (err) {
      console.warn('Jellio: could not load current user', err);
      return null;
    }),
    buildSleepTimerCard(),
    buildQuickConnectCard(),
    buildPrivacyCard(),
    buildGrouplistCard(),
    getJellioConfig().catch(function () {
      return null;
    }),
  ]);
  const user = userResult;

  const categories = [
    { id: 'account', label: t('settings_cat_account'), build: function () { return buildAccountCategory(user, privacyCard, grouplistCard); } },
    { id: 'playback', label: t('settings_cat_playback'), build: function () { return buildPlaybackCategory(user); } },
    {
      id: 'sessions',
      label: t('settings_cat_sessions'),
      build: function () { return buildSessionsCategory(sleepTimerCard, quickConnectCard); },
    },
    { id: 'recommendations', label: t('settings_cat_recommendations'), build: buildRecommendationsCategory },
    { id: 'display', label: t('settings_cat_display'), build: buildDisplayCategory },
    { id: 'about', label: t('settings_cat_about'), build: buildAboutCategory },
  ];
  categories.splice(2, 0, {
    id: 'reading',
    label: t('settings_cat_reading'),
    build: function () {
      return buildReadingCategory(config);
    },
  });

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
