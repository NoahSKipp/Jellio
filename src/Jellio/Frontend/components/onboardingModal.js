// First-run Onboarding Setup Wizard for Jellio Web.
// Welcomes new users and guides them through Display Language, Audio &
// Subtitle Track preferences, Profile & Feed Privacy, and Reading/Manga setup.
// Follows Jellio and Nuvio glassmorphic styling.

import { el } from '../runtime/dom.js';
import { t, getDisplayLanguage, setDisplayLanguage, DISPLAY_LANGUAGES } from '../runtime/i18n.js';
import { getCurrentUserId } from '../runtime/auth.js';
import {
  getCurrentUser,
  updateLanguagePreferences,
  startMangaImport,
} from '../runtime/api.js';
import { isRememberStreamEnabled, setRememberStreamEnabled } from './streamPicker.js';
import { LANGUAGE_OPTIONS, languageName } from '../runtime/languages.js';
import { LANGUAGES, languageLabel, readTargetLanguage, writeTargetLanguage } from './readerStudy.js';
import { getDefaultAudiobookSpeed, setDefaultAudiobookSpeed } from './audioMiniPlayer.js';

const MODAL_ID = 'jellioOnboardingModal';
const STORAGE_PREFIX = 'jellio_onboarding_done_';

export function shouldShowOnboarding(userId) {
  const uid = userId || getCurrentUserId();
  if (!uid) return false;
  try {
    if (window.localStorage.getItem(STORAGE_PREFIX + uid)) {
      return false;
    }

    // Onboarding setup wizard is strictly for initial open / clean installs.
    // If the user has already configured settings, has previous changelog history,
    // or has established account playback preferences, treat onboarding as done.
    const hasExistingUsage = Boolean(
      window.localStorage.getItem('jellio_last_seen_changelog_' + uid) ||
      window.localStorage.getItem('jellio_last_seen_changelog_global') ||
      window.localStorage.getItem('jellio_display_language') ||
      window.localStorage.getItem('jellio_player_volume') ||
      window.localStorage.getItem('jellioPlayerSpeed') ||
      window.localStorage.getItem('jellio_player_sub_style') ||
      window.localStorage.getItem('jellio_player_autoskip') ||
      window.localStorage.getItem('jellio_reader_settings') ||
      window.localStorage.getItem('jellio_reader_study_lang') ||
      window.localStorage.getItem('jellio_audiobook_default_speed') ||
      window.localStorage.getItem('jellio_audiobook_volume') ||
      window.localStorage.getItem('jellio_motion_level') ||
      window.localStorage.getItem('jellio_buffer_seconds') ||
      window.localStorage.getItem('jellio_pip_mode') ||
      window.localStorage.getItem('jellio_up_next_countdown') ||
      window.localStorage.getItem('jellio_recent_searches') ||
      window.localStorage.getItem('jellio_home_genres')
    );

    const user = getCurrentUser();
    const hasServerSettings = Boolean(
      user &&
      user.Configuration &&
      (user.Configuration.AudioLanguagePreference ||
       user.Configuration.SubtitleLanguagePreference ||
       user.Configuration.SubtitleMode)
    );

    if (hasExistingUsage || hasServerSettings) {
      markOnboardingComplete(uid);
      return false;
    }

    return true;
  } catch (err) {
    return false;
  }
}

export function markOnboardingComplete(userId) {
  if (!userId) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + userId, 'true');
  } catch (err) {}
}

export function closeOnboardingModal() {
  const existing = document.getElementById(MODAL_ID);
  if (existing) existing.remove();
}

export function openOnboardingModal(options) {
  closeOnboardingModal();
  const userId = (options && options.userId) || getCurrentUserId();
  const onDone = options && options.onDone;

  let currentStep = 1;

  // Staged state before saving
  let selectedDisplayLang = getDisplayLanguage();
  let selectedAudioLang = '';
  let selectedSubtitleLang = '';
  let rememberStream = isRememberStreamEnabled();
  let readingEnabled = false;
  let targetStudyLang = readTargetLanguage() || 'eng';
  let audiobookSpeed = getDefaultAudiobookSpeed() || 1;
  let mihonImportFile = null;
  let mihonStatusText = '';

  // Pre-load current server user configuration if available
  const sessionUser = getCurrentUser();
  if (sessionUser && sessionUser.Configuration) {
    selectedAudioLang = sessionUser.Configuration.AudioLanguagePreference || '';
    selectedSubtitleLang = sessionUser.Configuration.SubtitleLanguagePreference || '';
  }

  // If user already has audio/subtitle preferences configured (e.g. from Jellio TV setup),
  // skip redundant steps and only show new and relevant settings for this platform.
  const hasSharedAccountSettings = Boolean(selectedAudioLang || selectedSubtitleLang);

  function getActiveSteps() {
    const list = ['language'];
    if (!hasSharedAccountSettings) {
      list.push('playback');
    }
    list.push('reading');
    list.push('done');
    return list;
  }


  const overlay = el('div', 'jellio-onboarding-overlay');
  overlay.id = MODAL_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('onboarding_welcome_title'));

  const card = el('div', 'jellio-onboarding-card');
  overlay.appendChild(card);

  function saveAndFinish() {
    markOnboardingComplete(userId);
    // Persist language preferences to Jellyfin server
    updateLanguagePreferences(selectedAudioLang, selectedSubtitleLang).catch(function () {});
    // Persist stream choice memory
    setRememberStreamEnabled(rememberStream);
    // Persist study & audiobook settings if reading enabled
    if (readingEnabled) {
      writeTargetLanguage(targetStudyLang);
      setDefaultAudiobookSpeed(Number(audiobookSpeed));
      if (mihonImportFile) {
        startMangaImport(mihonImportFile).catch(function () {});
      }
    }
    closeOnboardingModal();
    if (typeof onDone === 'function') onDone();
  }

  function renderStep() {
    card.innerHTML = '';
    const activeSteps = getActiveSteps();
    const totalSteps = activeSteps.length;
    currentStep = Math.min(Math.max(1, currentStep), totalSteps);
    const currentStepId = activeSteps[currentStep - 1];

    // Header with Mark, Title, and Step indicator
    const header = el('div', 'jellio-onboarding-header');
    const headerTop = el('div', 'jellio-onboarding-header-top');

    const brand = el('div', 'jellio-onboarding-brand');
    const mark = el('div', 'jellio-onboarding-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
    brand.appendChild(mark);

    const brandText = el('div', 'jellio-onboarding-brand-text');
    brandText.appendChild(el('span', 'jellio-onboarding-brand-title', 'Jellio'));
    brandText.appendChild(el('span', 'jellio-onboarding-step-counter', t('onboarding_step_counter', { current: currentStep, total: totalSteps })));
    brand.appendChild(brandText);
    headerTop.appendChild(brand);

    const skipBtn = el('button', 'jellio-onboarding-skip-btn', t('onboarding_skip'));
    skipBtn.type = 'button';
    skipBtn.addEventListener('click', function () {
      markOnboardingComplete(userId);
      closeOnboardingModal();
      if (typeof onDone === 'function') onDone();
    });
    headerTop.appendChild(skipBtn);
    header.appendChild(headerTop);

    // Progress pill bar
    const progressTrack = el('div', 'jellio-onboarding-progress-track');
    for (let i = 1; i <= totalSteps; i++) {
      const pill = el('div', 'jellio-onboarding-progress-pill' + (i <= currentStep ? ' active' : ''));
      progressTrack.appendChild(pill);
    }
    header.appendChild(progressTrack);
    card.appendChild(header);

    // Body content per step
    const body = el('div', 'jellio-onboarding-body');

    if (currentStepId === 'language') {
      renderStepLanguage(body);
    } else if (currentStepId === 'playback') {
      renderStepPlayback(body);
    } else if (currentStepId === 'profile') {
      renderStepProfile(body);
    } else if (currentStepId === 'reading') {
      renderStepReading(body);
    } else if (currentStepId === 'done') {
      renderStepDone(body);
    }

    card.appendChild(body);

    // Footer with Back & Next / Finish buttons
    const footer = el('div', 'jellio-onboarding-footer');

    if (currentStep > 1) {
      const backBtn = el('button', 'jellio-onboarding-btn-back', t('onboarding_back'));
      backBtn.type = 'button';
      backBtn.addEventListener('click', function () {
        currentStep = Math.max(1, currentStep - 1);
        renderStep();
      });
      footer.appendChild(backBtn);
    } else {
      footer.appendChild(el('div', 'jellio-onboarding-footer-spacer'));
    }

    if (currentStep < totalSteps) {
      const nextBtn = el('button', 'jellio-onboarding-btn-next', t('onboarding_next'));
      nextBtn.type = 'button';
      nextBtn.addEventListener('click', function () {
        currentStep = Math.min(totalSteps, currentStep + 1);
        renderStep();
      });
      footer.appendChild(nextBtn);
    } else {
      const finishBtn = el('button', 'jellio-onboarding-btn-finish', t('onboarding_finish'));
      finishBtn.type = 'button';
      finishBtn.addEventListener('click', function () {
        saveAndFinish();
      });
      footer.appendChild(finishBtn);
    }

    card.appendChild(footer);
  }

  // STEP 1: Display Language
  function renderStepLanguage(container) {
    container.appendChild(el('h2', 'jellio-onboarding-title', t('onboarding_welcome_title')));
    container.appendChild(el('p', 'jellio-onboarding-sub', t('onboarding_welcome_sub')));

    const langGrid = el('div', 'jellio-onboarding-lang-grid');
    DISPLAY_LANGUAGES.forEach(function (lang) {
      const item = el('button', 'jellio-onboarding-lang-card' + (selectedDisplayLang === lang.code ? ' selected' : ''));
      item.type = 'button';

      const icon = el('span', 'material-icons jellio-onboarding-lang-icon', 'translate');
      item.appendChild(icon);

      const labelWrap = el('div', 'jellio-onboarding-lang-info');
      labelWrap.appendChild(el('div', 'jellio-onboarding-lang-native', lang.nativeName));
      labelWrap.appendChild(el('div', 'jellio-onboarding-lang-name', lang.label));
      item.appendChild(labelWrap);

      item.addEventListener('click', function () {
        selectedDisplayLang = lang.code;
        setDisplayLanguage(lang.code);
        renderStep();
      });
      langGrid.appendChild(item);
    });
    container.appendChild(langGrid);
  }

  // Helper for question mark tooltip
  function buildHelpIcon(title, description) {
    const wrap = el('span', 'jellio-onboarding-help-wrap');
    const btn = el('button', 'jellio-onboarding-help-btn', '?');
    btn.type = 'button';
    btn.setAttribute('aria-label', title);

    const tooltip = el('div', 'jellio-onboarding-tooltip');
    tooltip.appendChild(el('div', 'jellio-onboarding-tooltip-title', title));
    tooltip.appendChild(el('div', 'jellio-onboarding-tooltip-desc', description));
    wrap.appendChild(btn);
    wrap.appendChild(tooltip);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      tooltip.classList.toggle('visible');
    });
    return wrap;
  }

  // STEP 2: Audio & Subtitle Language
  function renderStepPlayback(container) {
    container.appendChild(el('h2', 'jellio-onboarding-title', t('onboarding_step_playback')));
    container.appendChild(el('p', 'jellio-onboarding-sub', t('onboarding_playback_sub')));

    const form = el('div', 'jellio-onboarding-form');

    // Default Audio Language row
    const audioRow = el('div', 'jellio-onboarding-row');
    const audioLabelWrap = el('div', 'jellio-onboarding-label-wrap');
    audioLabelWrap.appendChild(el('label', 'jellio-onboarding-label', t('settings_default_audio')));
    audioLabelWrap.appendChild(buildHelpIcon(t('onboarding_audio_help_title'), t('onboarding_audio_help_desc')));
    audioRow.appendChild(audioLabelWrap);

    const audioSelect = document.createElement('select');
    audioSelect.className = 'jellio-onboarding-select';
    const noPrefOpt = document.createElement('option');
    noPrefOpt.value = '';
    noPrefOpt.textContent = t('settings_no_preference');
    audioSelect.appendChild(noPrefOpt);

    LANGUAGE_OPTIONS.forEach(function (opt) {
      const optEl = document.createElement('option');
      optEl.value = opt.code;
      optEl.textContent = opt.name;
      if (opt.code === selectedAudioLang) optEl.selected = true;
      audioSelect.appendChild(optEl);
    });
    audioSelect.addEventListener('change', function () {
      selectedAudioLang = audioSelect.value;
    });
    audioRow.appendChild(audioSelect);
    form.appendChild(audioRow);

    // Default Subtitle Language row
    const subRow = el('div', 'jellio-onboarding-row');
    const subLabelWrap = el('div', 'jellio-onboarding-label-wrap');
    subLabelWrap.appendChild(el('label', 'jellio-onboarding-label', t('settings_default_subtitle')));
    subLabelWrap.appendChild(buildHelpIcon(t('onboarding_subtitle_help_title'), t('onboarding_subtitle_help_desc')));
    subRow.appendChild(subLabelWrap);

    const subSelect = document.createElement('select');
    subSelect.className = 'jellio-onboarding-select';
    const subNoPrefOpt = document.createElement('option');
    subNoPrefOpt.value = '';
    subNoPrefOpt.textContent = t('settings_no_preference');
    subSelect.appendChild(subNoPrefOpt);

    LANGUAGE_OPTIONS.forEach(function (opt) {
      const optEl = document.createElement('option');
      optEl.value = opt.code;
      optEl.textContent = opt.name;
      if (opt.code === selectedSubtitleLang) optEl.selected = true;
      subSelect.appendChild(optEl);
    });
    subSelect.addEventListener('change', function () {
      selectedSubtitleLang = subSelect.value;
    });
    subRow.appendChild(subSelect);
    form.appendChild(subRow);

    // Remember stream choice toggle
    const streamToggleRow = el('label', 'jellio-onboarding-check-row');
    const streamCheckbox = document.createElement('input');
    streamCheckbox.type = 'checkbox';
    streamCheckbox.className = 'jellio-onboarding-checkbox';
    streamCheckbox.checked = rememberStream;
    streamCheckbox.addEventListener('change', function () {
      rememberStream = streamCheckbox.checked;
    });
    streamToggleRow.appendChild(streamCheckbox);

    const streamText = el('div', 'jellio-onboarding-check-text');
    streamText.appendChild(el('div', 'jellio-onboarding-check-title', t('settings_remember_stream')));
    streamText.appendChild(el('div', 'jellio-onboarding-check-sub', t('settings_remember_stream_desc')));
    streamToggleRow.appendChild(streamText);
    form.appendChild(streamToggleRow);

    container.appendChild(form);
  }

  // STEP 4: Reading & Manga Setup
  function renderStepReading(container) {
    container.appendChild(el('h2', 'jellio-onboarding-title', t('onboarding_step_reading')));
    container.appendChild(el('p', 'jellio-onboarding-sub', t('onboarding_reading_sub')));

    // Master reading toggle
    const toggleCard = el('div', 'jellio-onboarding-card-nested');
    const masterCheckRow = el('label', 'jellio-onboarding-check-row');
    const masterCheckbox = document.createElement('input');
    masterCheckbox.type = 'checkbox';
    masterCheckbox.className = 'jellio-onboarding-checkbox';
    masterCheckbox.checked = readingEnabled;
    masterCheckbox.addEventListener('change', function () {
      readingEnabled = masterCheckbox.checked;
      subSection.style.display = readingEnabled ? 'block' : 'none';
    });
    masterCheckRow.appendChild(masterCheckbox);

    const masterText = el('div', 'jellio-onboarding-check-text');
    masterText.appendChild(el('div', 'jellio-onboarding-check-title', t('onboarding_enable_reading')));
    masterText.appendChild(el('div', 'jellio-onboarding-check-sub', t('onboarding_enable_reading_desc')));
    masterCheckRow.appendChild(masterText);
    toggleCard.appendChild(masterCheckRow);

    // Sub-section revealed when reading is enabled
    const subSection = el('div', 'jellio-onboarding-reading-sub');
    subSection.style.display = readingEnabled ? 'block' : 'none';

    // 1. Mihon Import
    const mihonBlock = el('div', 'jellio-onboarding-reading-block');
    mihonBlock.appendChild(el('h4', 'jellio-onboarding-block-title', t('onboarding_mihon_import')));
    mihonBlock.appendChild(el('p', 'jellio-onboarding-block-desc', t('onboarding_mihon_import_desc')));

    const fileUploadWrap = el('div', 'jellio-onboarding-file-wrap');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.proto.gz,.gz';
    fileInput.style.display = 'none';

    const fileBtn = el('button', 'jellio-onboarding-file-btn', t('onboarding_choose_mihon_file'));
    fileBtn.type = 'button';
    fileBtn.addEventListener('click', function () {
      fileInput.click();
    });

    const fileStatus = el('span', 'jellio-onboarding-file-status', mihonStatusText || t('onboarding_no_file_selected'));
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        mihonImportFile = fileInput.files[0];
        mihonStatusText = mihonImportFile.name;
        fileStatus.textContent = mihonStatusText;
      }
    });

    fileUploadWrap.appendChild(fileBtn);
    fileUploadWrap.appendChild(fileStatus);
    mihonBlock.appendChild(fileUploadWrap);
    subSection.appendChild(mihonBlock);

    // 2. Study & Translation Language
    const studyBlock = el('div', 'jellio-onboarding-reading-block');
    studyBlock.appendChild(el('h4', 'jellio-onboarding-block-title', t('onboarding_study_language_title')));
    const studyRow = el('div', 'jellio-onboarding-row');
    studyRow.appendChild(el('label', 'jellio-onboarding-label', t('onboarding_translate_into')));

    const studySelect = document.createElement('select');
    studySelect.className = 'jellio-onboarding-select';
    LANGUAGES.forEach(function (code) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = languageLabel(code);
      if (code === targetStudyLang) opt.selected = true;
      studySelect.appendChild(opt);
    });
    studySelect.addEventListener('change', function () {
      targetStudyLang = studySelect.value;
    });
    studyRow.appendChild(studySelect);
    studyBlock.appendChild(studyRow);
    subSection.appendChild(studyBlock);

    // 3. Audiobook speed
    const audioBlock = el('div', 'jellio-onboarding-reading-block');
    audioBlock.appendChild(el('h4', 'jellio-onboarding-block-title', t('onboarding_audiobook_speed_title')));
    const speedRow = el('div', 'jellio-onboarding-row');
    speedRow.appendChild(el('label', 'jellio-onboarding-label', t('onboarding_speed')));

    const speedSelect = document.createElement('select');
    speedSelect.className = 'jellio-onboarding-select';
    ['0.75', '1', '1.25', '1.5', '1.75', '2'].forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s + 'x' + (s === '1' ? ' (Normal)' : '');
      if (Number(s) === Number(audiobookSpeed)) opt.selected = true;
      speedSelect.appendChild(opt);
    });
    speedSelect.addEventListener('change', function () {
      audiobookSpeed = Number(speedSelect.value);
    });
    speedRow.appendChild(speedSelect);
    audioBlock.appendChild(speedRow);
    subSection.appendChild(audioBlock);

    toggleCard.appendChild(subSection);
    container.appendChild(toggleCard);
  }

  // STEP 5: Summary & All Set
  function renderStepDone(container) {
    container.appendChild(el('h2', 'jellio-onboarding-title', t('onboarding_ready_title')));
    container.appendChild(el('p', 'jellio-onboarding-sub', t('onboarding_ready_desc')));

    const summaryCard = el('div', 'jellio-onboarding-summary-card');

    function addSummaryItem(iconName, label, value, badgeText) {
      const item = el('div', 'jellio-onboarding-summary-item');
      item.appendChild(el('span', 'material-icons jellio-onboarding-summary-icon', iconName));
      const text = el('div', 'jellio-onboarding-summary-text');
      const labelWrap = el('div', 'jellio-onboarding-summary-label');
      labelWrap.appendChild(document.createTextNode(label));
      if (badgeText) {
        labelWrap.appendChild(el('span', 'jellio-onboarding-summary-badge', badgeText));
      }
      text.appendChild(labelWrap);
      text.appendChild(el('div', 'jellio-onboarding-summary-value', value));
      item.appendChild(text);
      summaryCard.appendChild(item);
    }

    const currentDisplayLangObj = DISPLAY_LANGUAGES.find((l) => l.code === selectedDisplayLang);
    addSummaryItem('translate', t('onboarding_summary_interface_language'), currentDisplayLangObj ? currentDisplayLangObj.nativeName : 'English');

    addSummaryItem(
      'audiotrack',
      t('onboarding_summary_preferred_audio'),
      selectedAudioLang ? languageName(selectedAudioLang) : t('onboarding_summary_primary_audio_fallback'),
      hasSharedAccountSettings ? t('onboarding_synced_badge') : null,
    );

    addSummaryItem(
      'subtitles',
      t('onboarding_summary_subtitles'),
      selectedSubtitleLang ? t('onboarding_summary_subtitles_auto', { name: languageName(selectedSubtitleLang) }) : t('onboarding_summary_subtitles_off'),
      hasSharedAccountSettings ? t('onboarding_synced_badge') : null,
    );


    if (readingEnabled) {
      addSummaryItem('auto_stories', t('onboarding_summary_reading_setup'), t('onboarding_summary_reading_enabled', { lang: targetStudyLang.toUpperCase() }));
    }

    container.appendChild(summaryCard);
    container.appendChild(el('div', 'jellio-onboarding-settings-reminder', t('onboarding_settings_hint')));
  }

  // Initial render
  renderStep();
  document.body.appendChild(overlay);
}
