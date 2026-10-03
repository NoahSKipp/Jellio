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
  getProfileSettings,
  setProfilePrivacy,
  setGrouplistEnabled,
  getJellioConfig,
  startMangaImport,
  getMangaImportStatus,
} from '../runtime/api.js';
import { logout } from '../runtime/auth.js';
import { setGrouplistEnabledLocal } from '../runtime/grouplistSettings.js';
import { openAvatarPicker } from '../components/avatarPicker.js';
import { refreshProfileAvatar } from '../components/navShared.js';
import { isRememberStreamEnabled, setRememberStreamEnabled } from '../components/streamPicker.js';
import { UPNEXT_TRIGGER_OPTIONS, getUpNextTriggerSeconds, setUpNextTriggerSeconds } from '../runtime/upNextSettings.js';
import {
  isAutoDeleteWatchedEnabled,
  setAutoDeleteWatchedEnabled,
  isAutoDeleteReadEnabled,
  setAutoDeleteReadEnabled,
} from '../runtime/offline.js';
import { getDefaultAudiobookSpeed, setDefaultAudiobookSpeed } from '../components/audioMiniPlayer.js';
import { navigateTo } from '../runtime/router.js';
import { LANGUAGE_OPTIONS, languageName } from '../runtime/languages.js';
import {
  LANGUAGES,
  languageLabel,
  readTargetLanguage,
  writeTargetLanguage,
  readDefaultBookLanguage,
  writeDefaultBookLanguage,
} from '../components/readerStudy.js';
import { el } from '../runtime/dom.js';

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

  const { card, body } = buildCard('visibility_off', 'Privacy', 'Controls what other users can see on your profile.');
  body.appendChild(
    buildToggleRow(
      null,
      'Private profile',
      'Your profile picture and banner stay visible. Achievement badges and activity are hidden from other users.',
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

  const { card, body } = buildCard('groups', 'Group Watch lists', 'A shared list for picking what to watch together.');
  body.appendChild(
    buildToggleRow(
      null,
      'Grouplist',
      'Adds a second list alongside your Watchlist, and a ranking session in Group Watch chat for picking from it together.',
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
  body.appendChild(
    buildToggleRow(
      null,
      'Delete after watching',
      'Automatically remove downloaded episodes and movies from this device once finished. Files on the Jellyfin server are never affected.',
      isAutoDeleteWatchedEnabled(),
      function (checked) {
        setAutoDeleteWatchedEnabled(checked);
      },
    ),
  );
  body.appendChild(
    buildSelectRow(
      null,
      'Next episode timing',
      'When the Up Next card appears near the end of an episode. Only used when this episode has no Intro Skipper credits data to time it off instead.',
      UPNEXT_TRIGGER_OPTIONS,
      String(getUpNextTriggerSeconds()),
      function (value, select, status) {
        setUpNextTriggerSeconds(Number(value));
        status.textContent = 'Saved, takes effect on the next episode.';
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
function buildAccountCategory(user, privacyCard, grouplistCard) {
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
  profileBody.appendChild(
    buildActionRow('badge', 'View profile', 'Banner, badges and activity.', function () {
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
      buildActionRow('admin_panel_settings', 'Open admin dashboard', null, function () {
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
      'In Mihon: Settings, Data and storage, Create backup. Then pick the .tachibk file here.',
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
    status.appendChild(el('p', 'jellio-settings-import-headline', 'Reading ' + file.name + '…'));
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
    'Translation and dictionary',
    'Select a word or passage while reading to look it up or translate it.',
  );
  const languages = LANGUAGES.map((code) => ({ value: code, label: languageLabel(code) })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  if (translationEnabled) {
    body.appendChild(
      buildSelectRow(null, 'Translate into', 'The language translations and vocabulary cards are written in.', languages, readTargetLanguage(), function (value, select, status) {
        writeTargetLanguage(value);
        status.textContent = 'Saved.';
      }),
    );
  } else {
    body.appendChild(
      buildRow(null, 'Translation is off', 'An admin can turn it on by adding a DeepL API key in Jellio’s plugin settings. Dictionary lookups work without it.', null),
    );
  }

  body.appendChild(
    buildSelectRow(
      null,
      'Books are written in',
      'Detect automatically works out each book’s language from its text the first time you translate. Pick one if you mostly read in one language; the reader can still change it per book.',
      [{ value: 'auto', label: 'Detect automatically' }].concat(languages),
      readDefaultBookLanguage(),
      function (value, select, status) {
        writeDefaultBookLanguage(value);
        status.textContent = 'Saved. Applies to books you haven’t set a language for.';
      },
    ),
  );

  body.appendChild(
    buildActionRow('style', 'Vocabulary deck', 'Review the words you saved while reading, or export them to Anki.', function () {
      navigateTo('#/vocab');
    }),
  );
  return card;
}

function buildReadingOfflineCard() {
  const { card, body } = buildCard('auto_stories', 'Reading & Audiobooks');
  body.appendChild(
    buildToggleRow(
      null,
      'Delete after reading',
      'Automatically remove downloaded chapters, books, and audiobooks from this device once finished. Files on the Jellyfin server are never affected.',
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
      'Default audiobook speed',
      'Preferred playback speed when opening an audiobook.',
      speedOptions,
      String(getDefaultAudiobookSpeed()),
      function (val, select, status) {
        setDefaultAudiobookSpeed(Number(val));
        status.textContent = 'Saved.';
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
      return 'Checking for updates…';
    case 'up-to-date':
      return 'You’re up to date.';
    case 'available':
      return 'Version ' + state.latest + ' is available.';
    case 'downloading':
      return 'Downloading ' + state.latest + '… ' + Math.round((state.progress || 0) * 100) + '%';
    case 'installing':
      return 'Installing ' + state.latest + '…';
    case 'restarting':
      return 'Restarting into ' + state.latest + '…';
    case 'error':
      return state.error || 'Something went wrong.';
    default:
      return state.checkedAt ? 'Last checked ' + new Date(state.checkedAt).toLocaleString() + '.' : 'Not checked yet.';
  }
}

function buildAppUpdateCard(native) {
  const { card, body } = buildCard('laptop_mac', 'Jellio for macOS', 'Updates for this Mac app.');
  const action = el('button', 'jellio-settings-button', 'Check for updates');
  action.type = 'button';
  const statusRow = buildRow(null, 'Version', '', action);
  const description = el('span', 'jellio-settings-row-description');
  statusRow.querySelector('.jellio-settings-row-text').appendChild(description);
  body.appendChild(statusRow);

  let current = null;
  let toggleInput = null;
  body.appendChild(
    buildToggleRow(null, 'Check automatically', 'Looks for a new version when Jellio starts and every few hours.', true, function (checked) {
      native.setAutomatic(checked).catch(function (err) {
        console.warn('Jellio: could not save the update setting', err);
      });
    }),
  );
  toggleInput = body.querySelector('.jellio-settings-toggle-input');

  function paint(state) {
    if (!state) return;
    current = state;
    statusRow.querySelector('.jellio-settings-row-title').textContent = 'Version ' + state.current;
    description.textContent = describeAppUpdate(state);
    const working = ['checking', 'downloading', 'installing', 'restarting'].indexOf(state.status) !== -1;
    action.disabled = working;
    action.textContent = state.status === 'available' ? 'Install ' + state.latest : working ? 'Working…' : 'Check for updates';
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
  return card;
}

function buildAboutCategory() {
  const wrap = el('div', 'jellio-settings-category');
  const version = jellioVersion();
  const { card } = buildCard('info', 'About', version ? 'Jellio ' + version : 'Jellio');
  wrap.appendChild(card);
  const native = window.jellioNative && window.jellioNative.updates;
  if (native) wrap.appendChild(buildAppUpdateCard(native));
  return wrap;
}

const CATEGORY_ICONS = {
  account: 'person',
  playback: 'play_circle',
  reading: 'menu_book',
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
    { id: 'account', label: 'Account', build: function () { return buildAccountCategory(user, privacyCard, grouplistCard); } },
    { id: 'playback', label: 'Playback', build: function () { return buildPlaybackCategory(user); } },
    {
      id: 'sessions',
      label: 'Sessions',
      build: function () { return buildSessionsCategory(sleepTimerCard, quickConnectCard); },
    },
    { id: 'about', label: 'About', build: buildAboutCategory },
  ];
  categories.splice(2, 0, {
    id: 'reading',
    label: 'Reading',
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
