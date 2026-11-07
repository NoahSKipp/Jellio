import { PREBUFFER_OPTIONS, getPrebufferLevel, setPrebufferLevel, getBufferSwitchMode, setBufferSwitchMode } from '../runtime/bufferSettings.js';
import { getCurrentUser, saveServerDisplayLanguage, saveServerDisplayPreferences, updateUserPassword, getSleepTimerStatus, cancelSleepTimer, updateLanguagePreferences, isQuickConnectEnabled, authorizeQuickConnect, getJellioConfig, clearCachedRows, isHomeRowCacheEnabled, getAllGenres, getUserImageUrl, searchGenreOrCategory } from '../runtime/api.js';
import { getProfileSettings, setProfilePrivacy, setGrouplistEnabled, getCommunityUsers } from '../runtime/apiSocial.js';
import { startMangaImport, getMangaImportStatus } from '../runtime/apiBooks.js';
import {
  isCommunityRowEnabled,
  setCommunityRowEnabled,
  getCommunityExcludedUsers,
  toggleCommunityExcludedUser,
  getSelectedGenres,
  toggleSelectedGenre,
  setSelectedGenres,
  getCustomGenres,
  setCustomGenres,
  addCustomGenre,
  removeCustomGenre,
  syncRecommendationsFromServer,
} from '../runtime/recommendationSettings.js';
import { LATEST_CHANGELOG, CHANGELOG_RELEASES, MACOS_CHANGELOG_RELEASES } from '../runtime/changelog.js';
import { invalidateAllHomeSections } from './home.js';

import { logout } from '../runtime/auth.js';
import { setGrouplistEnabledLocal } from '../runtime/grouplistSettings.js';
import { openAvatarPicker } from '../components/avatarPicker.js';
import { refreshProfileAvatar } from '../components/navShared.js';
import { isRememberStreamEnabled, setRememberStreamEnabled } from '../components/streamPicker.js';
import { isPreferReadyEnabled, setPreferReadyEnabled } from '../runtime/readySources.js';
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
import {
  isRemoveFromWatchlistAfterWatchingEnabled,
  setRemoveFromWatchlistAfterWatchingEnabled,
  syncWatchlistSettingsFromServer,
} from '../runtime/watchlistSettings.js';
import { getDefaultAudiobookSpeed, setDefaultAudiobookSpeed } from '../components/audioMiniPlayer.js';
import { navigateTo } from '../runtime/router.js';
import { LANGUAGE_OPTIONS, languageName } from '../runtime/languages.js';
import { DISPLAY_LANGUAGES, getDisplayLanguage, setDisplayLanguage, t, translateGenre } from '../runtime/i18n.js';
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
import { jellioVersion } from '../runtime/util.js';

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

function buildPlaybackCard() {
  syncWatchlistSettingsFromServer().catch(function () {});
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
        saveServerDisplayPreferences({ prebuffer: value });
        status.textContent = t('settings_saved_next_video') + ' (' + t('settings_saved_profile') + ')';
      },
    ),
  );
  body.appendChild(
    buildSelectRow(
      null,
      t('settings_buffer_switch_label'),
      t('settings_buffer_switch_desc'),
      [
        { value: 'ask', label: t('settings_buffer_switch_ask') },
        { value: 'auto', label: t('settings_buffer_switch_auto') },
        { value: 'off', label: t('settings_buffer_switch_off') },
      ],
      getBufferSwitchMode(),
      function (value, select, status) {
        setBufferSwitchMode(value);
        status.textContent = t('action_saved');
      },
    ),
  );
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_prefer_ready'),
      t('settings_prefer_ready_desc'),
      isPreferReadyEnabled(),
      function (checked) {
        setPreferReadyEnabled(checked);
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
  body.appendChild(
    buildToggleRow(
      null,
      t('settings_remove_watchlist_watched'),
      t('settings_remove_watchlist_watched_desc'),
      isRemoveFromWatchlistAfterWatchingEnabled(),
      function (checked) {
        setRemoveFromWatchlistAfterWatchingEnabled(checked);
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
          saveServerDisplayPreferences({ auto_pip: checked ? 'on' : 'off' });
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
        saveServerDisplayPreferences({ upnext_countdown: String(value) });
        status.textContent = t('settings_saved_next_episode') + ' (' + t('settings_saved_profile') + ')';
      },
    ),
  );
  return card;
}

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

  const subtitleOptions = [
    { value: 'off', label: t('settings_subtitles_off') },
    { value: '', label: t('settings_no_preference') },
  ].concat(
    LANGUAGE_OPTIONS.map(function (option) {
      return { value: option.code, label: option.name };
    }),
  );

  function resolveValue(currentCode) {
    const matched = LANGUAGE_OPTIONS.find(function (option) {
      return option.code === (currentCode || '').toLowerCase() || option.name === languageName(currentCode);
    });
    return matched ? matched.code : '';
  }

  const isSubtitleOff =
    configuration.SubtitleMode === 'None' ||
    configuration.SubtitleLanguagePreference === 'off' ||
    configuration.SubtitleLanguagePreference === 'none';

  let audioValue = resolveValue(configuration.AudioLanguagePreference);
  let subtitleValue = isSubtitleOff ? 'off' : resolveValue(configuration.SubtitleLanguagePreference);

  function save(status) {
    status.textContent = t('action_saving');
    const isSubOff = subtitleValue === 'off';
    const subLangToSave = isSubOff ? '' : subtitleValue;
    const subModeToSave = isSubOff ? 'None' : (subtitleValue ? 'Default' : undefined);
    updateLanguagePreferences(audioValue, subLangToSave, subModeToSave)
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
    buildSelectRow(null, t('settings_default_subtitle'), null, subtitleOptions, subtitleValue, function (value, select, status) {
      subtitleValue = value;
      save(status);
    }),
  );

  return card;
}

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

function buildAccountCategory(user, privacyCard, grouplistCard) {
  const wrap = el('div', 'jellio-settings-category');

  const { card: profileCard, body: profileBody } = buildCard(
    'person',
    t('nav_profile'),
    user ? t('settings_signed_in_as', { name: user.Name }) : null,
  );
  profileBody.appendChild(
    buildActionRow('photo_camera', t('onboarding_change_avatar'), null, function () {
      openAvatarPicker(refreshProfileAvatar);
    }),
  );
  profileBody.appendChild(
    buildActionRow('badge', t('settings_view_profile'), t('settings_view_profile_desc'), function () {
      navigateTo('#/profile');
    }),
  );
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
  action.style.alignSelf = 'center';
  const statusRow = buildRow('laptop_mac', t('settings_version'), '', action);
  const description = el('span', 'jellio-settings-row-description');
  statusRow.querySelector('.jellio-settings-row-text').appendChild(description);
  body.appendChild(statusRow);

  let current = null;
  let toggleInput = null;
  body.appendChild(
    buildToggleRow('sync', t('settings_check_auto'), t('settings_check_auto_desc'), true, function (checked) {
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
    macHeader.style.padding = '0 1.4em';
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

  // --- Card 0: Home Row Customization ---
  const { card: homeCustomizeCard, body: homeCustomizeBody } = buildCard(
    'tune',
    t('home_customize') || 'Customize Home Rows',
    'Reorder or hide rows on your home feed.',
  );
  homeCustomizeBody.appendChild(
    buildActionRow(
      'tune',
      'Customize Rows',
      null,
      function () {
        navigateTo('#/home?edit=1');
      },
    ),
  );
  wrap.appendChild(homeCustomizeCard);

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

  let libraryGenres = [];
  let updatePillsRef = null;

  getAllGenres(null, 'Movie,Series')
    .then(function (genres) {
      libraryGenres = genres || [];
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

      updatePillsRef = updatePills;
      updatePills();
    })
    .catch(function (err) {
      console.warn('Jellio: could not load library genres', err);
      pillsContainer.textContent = '';
      pillsContainer.appendChild(el('p', 'jellio-settings-empty-note', t('settings_genres_load_error')));
    });

  // --- Subcard: Custom & Discovered Genres ---
  const customSubcard = el('div', 'jellio-settings-subcard');
  const customSubcardHeader = el('div', 'jellio-settings-subcard-header');
  customSubcardHeader.appendChild(el('h3', 'jellio-settings-subcard-title', 'Custom & Discovered Genres'));
  customSubcardHeader.appendChild(
    el(
      'p',
      'jellio-settings-subcard-description',
      'Search and add custom categories, tropes, or TMDB genres to your home rows.',
    ),
  );
  customSubcard.appendChild(customSubcardHeader);

  const searchWrap = el('div', 'jellio-custom-genre-search-wrap');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'jellio-settings-input';
  searchInput.placeholder = 'Search for a genre or category (e.g. C-Drama, Cyberpunk, Martial Arts)...';
  searchWrap.appendChild(searchInput);

  const resultContainer = el('div', 'jellio-custom-genre-result');
  searchWrap.appendChild(resultContainer);
  customSubcard.appendChild(searchWrap);

  const customList = el('div', 'jellio-custom-genre-list');
  customSubcard.appendChild(customList);

  function checkGenreStatus(name) {
    const norm = (name || '').trim().toLowerCase();
    if (!norm) return null;
    const standard = getSelectedGenres();
    const matchedEnabled = standard.find(function (g) { return (g || '').trim().toLowerCase() === norm; });
    if (matchedEnabled) {
      return { status: 'enabled_standard', name: matchedEnabled };
    }
    const custom = getCustomGenres();
    const foundCustom = custom.find(function (g) { return (g && g.name ? g.name.trim().toLowerCase() === norm : false); });
    if (foundCustom) {
      return { status: 'custom', name: foundCustom.name };
    }
    const matchedLib = (libraryGenres || []).find(function (g) { return (g || '').trim().toLowerCase() === norm; });
    if (matchedLib) {
      return { status: 'available_standard', name: matchedLib };
    }
    return null;
  }

  function resolveMatch(data) {
    if (!data) return null;
    if (typeof data === 'string' && data.trim()) return { name: data.trim() };
    if (Array.isArray(data) && data.length > 0) return resolveMatch(data[0]);
    if (typeof data === 'object') {
      if (data.Found === false || data.found === false) return null;
      const list = data.Genres || data.Results || data.Items;
      if (Array.isArray(list) && list.length > 0) return resolveMatch(list[0]);
      const name = data.Name || data.name || data.Genre || data.genre || data.Match || data.match || data.Title || data.title;
      if (name) {
        return {
          name: String(name).trim(),
          category: data.Category || data.category || null,
          isStandard: Boolean(data.IsStandard || data.isStandard),
        };
      }
    }
    return null;
  }

  let searchTimer = null;
  let activeSearchId = 0;

  function checkSearchState(query) {
    const currentId = ++activeSearchId;
    resultContainer.textContent = '';
    const trimmed = (query || '').trim();
    if (!trimmed) return;

    const directStatus = checkGenreStatus(trimmed);
    if (directStatus && directStatus.status === 'enabled_standard') {
      const badge = el('span', 'jellio-custom-genre-badge', '"' + directStatus.name + '" is already enabled in your genre rows.');
      resultContainer.appendChild(badge);
      return;
    }
    if (directStatus && directStatus.status === 'custom') {
      const badge = el('span', 'jellio-custom-genre-badge', '"' + directStatus.name + '" is already in your custom genres.');
      resultContainer.appendChild(badge);
      return;
    }

    resultContainer.appendChild(el('span', 'jellio-settings-empty-note', t('status_loading')));

    searchGenreOrCategory(trimmed)
      .then(function (res) {
        if (currentId !== activeSearchId) return;
        resultContainer.textContent = '';

        const match = resolveMatch(res);
        if (!match || !match.name) {
          resultContainer.appendChild(el('span', 'jellio-settings-empty-note', 'No matching genre or category found.'));
          return;
        }

        const status = checkGenreStatus(match.name);
        if (status && status.status === 'enabled_standard') {
          const badge = el('span', 'jellio-custom-genre-badge', '"' + status.name + '" is already enabled in your genre rows.');
          resultContainer.appendChild(badge);
          return;
        }

        if (status && status.status === 'custom') {
          const badge = el('span', 'jellio-custom-genre-badge', '"' + status.name + '" is already in your custom genres.');
          resultContainer.appendChild(badge);
          return;
        }

        const isStandard = Boolean(match.isStandard || (res && (res.IsStandard || res.isStandard)) || (status && status.status === 'available_standard'));
        const standardName = (status && status.name) || match.name;

        if (isStandard) {
          const noteWrap = el('div', 'jellio-custom-genre-found-wrap');
          noteWrap.style.display = 'flex';
          noteWrap.style.flexDirection = 'column';
          noteWrap.style.gap = '8px';
          noteWrap.appendChild(el('span', 'jellio-settings-empty-note', '"' + standardName + '" is an available library genre.'));
          const enableBtn = el('button', 'jellio-custom-genre-add-btn');
          enableBtn.type = 'button';
          enableBtn.appendChild(el('span', 'material-icons', 'check_circle'));
          enableBtn.appendChild(el('span', '', 'Enable "' + standardName + '" for Home'));
          enableBtn.addEventListener('click', function () {
            toggleSelectedGenre(standardName);
            invalidateAllHomeSections();
            clearCachedRows();
            if (updatePillsRef) updatePillsRef();
            searchInput.value = '';
            resultContainer.textContent = '';
          });
          noteWrap.appendChild(enableBtn);
          resultContainer.appendChild(noteWrap);
          return;
        }

        const addBtn = el('button', 'jellio-custom-genre-add-btn');
        addBtn.type = 'button';
        addBtn.appendChild(el('span', 'material-icons', 'add'));
        addBtn.appendChild(el('span', '', 'Add "' + match.name + '" to Home'));
        addBtn.addEventListener('click', function () {
          addCustomGenre({ name: match.name, category: match.category, enabled: true });
          invalidateAllHomeSections();
          clearCachedRows();
          searchInput.value = '';
          resultContainer.textContent = '';
          renderCustomList();
        });
        resultContainer.appendChild(addBtn);
      })
      .catch(function () {
        if (currentId !== activeSearchId) return;
        resultContainer.textContent = '';
        resultContainer.appendChild(el('span', 'jellio-settings-empty-note', 'No matching genre or category found.'));
      });
  }

  searchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    const val = searchInput.value.trim();
    if (!val) {
      resultContainer.textContent = '';
      return;
    }
    searchTimer = setTimeout(function () {
      checkSearchState(val);
    }, 300);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      checkSearchState(searchInput.value.trim());
    }
  });

  function renderCustomList() {
    customList.textContent = '';
    const genres = getCustomGenres();
    if (!genres || genres.length === 0) {
      customList.appendChild(el('p', 'jellio-settings-empty-note', 'No custom genres added yet.'));
      return;
    }

    genres.forEach(function (genreObj) {
      const row = el('div', 'jellio-custom-genre-row');

      const nameEl = el('span', 'jellio-custom-genre-name', genreObj.name);
      if (genreObj.category) {
        const catBadge = el('span', 'jellio-custom-genre-badge', genreObj.category);
        catBadge.style.marginLeft = '0.6em';
        nameEl.appendChild(catBadge);
      }
      row.appendChild(nameEl);

      const actions = el('div', 'jellio-custom-genre-actions');

      const toggleLabel = el('label', 'jellio-settings-toggle');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'jellio-settings-toggle-input';
      checkbox.checked = genreObj.enabled !== false;
      checkbox.addEventListener('change', function () {
        const updated = getCustomGenres().map(function (g) {
          if ((g.name || '').trim().toLowerCase() === (genreObj.name || '').trim().toLowerCase()) {
            return Object.assign({}, g, { enabled: checkbox.checked });
          }
          return g;
        });
        setCustomGenres(updated);
        invalidateAllHomeSections();
        clearCachedRows();
      });
      toggleLabel.appendChild(checkbox);
      toggleLabel.appendChild(el('span', 'jellio-settings-toggle-track'));
      actions.appendChild(toggleLabel);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'jellio-custom-genre-delete';
      deleteBtn.title = 'Remove ' + genreObj.name;
      deleteBtn.appendChild(el('span', 'material-icons', 'delete_outline'));
      deleteBtn.addEventListener('click', function () {
        removeCustomGenre(genreObj.name);
        invalidateAllHomeSections();
        clearCachedRows();
        renderCustomList();
        checkSearchState(searchInput.value.trim());
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      customList.appendChild(row);
    });
  }

  renderCustomList();

  genreBody.appendChild(genresWrap);
  genreBody.appendChild(customSubcard);
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
        saveServerDisplayPreferences({ language: value });
        status.textContent = t('action_saved') + ' (' + t('settings_saved_profile') + ')';
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
        saveServerDisplayPreferences({ seasonal_motion: value });
        status.textContent = t('action_saved') + ' (' + t('settings_saved_profile') + ')';
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
  wizardBody.appendChild(
    buildActionRow('auto_fix_high', t('onboarding_wizard_btn'), null, function () {
      openOnboardingModal();
    }),
  );
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
