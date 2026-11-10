// Settings popover (auto-skip, sleep, shortcuts) and the shortcuts modal.
// Built by screens/player.js; live is its playerLive accessor object.

import { el } from '../../runtime/dom.js';
import { readString, writeString } from '../../runtime/storage.js';
import { t } from '../../runtime/i18n.js';

export function buildSettingsMenu(deps, live) {
  const {
    closePopovers, positionPopover, registerPopover, settingsButton, showPlayerToast, sleepButton, sleepMenu,
    wakeControls,
  } = deps;

  // === Settings popover: Auto-skip Intros toggle and Keyboard Shortcuts modal trigger ===
  const AUTOSKIP_KEY = 'jellio_player_autoskip';
  try {
    live.autoSkipEnabled = readString(AUTOSKIP_KEY) === 'true';
  } catch (e) {}

  const settingsMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const autoSkipOption = el('button', 'jellio-player-popover-option');
  autoSkipOption.type = 'button';
  const autoSkipLabel = el('span', '', t('player_autoskip'));
  autoSkipOption.appendChild(autoSkipLabel);
  function syncAutoSkipUI() {
    autoSkipOption.classList.toggle('jellio-player-popover-option-active', live.autoSkipEnabled);
  }
  syncAutoSkipUI();
  autoSkipOption.addEventListener('click', function () {
    live.autoSkipEnabled = !live.autoSkipEnabled;
    writeString(AUTOSKIP_KEY, String(live.autoSkipEnabled));
    syncAutoSkipUI();
    showPlayerToast(t(live.autoSkipEnabled ? 'player_autoskip_on' : 'player_autoskip_off'));
  });
  settingsMenu.appendChild(autoSkipOption);

  live.sleepOption = el('button', 'jellio-player-popover-option jellio-player-settings-sleep');
  live.sleepOption.type = 'button';
  const sleepOptionLabel = el('span', 'jellio-player-settings-sleep-label');
  const sleepOptionIcon = el('span', 'material-icons bedtime');
  sleepOptionIcon.setAttribute('aria-hidden', 'true');
  sleepOptionLabel.appendChild(sleepOptionIcon);
  sleepOptionLabel.appendChild(el('span', '', t('player_sleep_timer')));
  live.sleepOption.appendChild(sleepOptionLabel);
  live.sleepOption.addEventListener('click', function () {
    closePopovers(sleepMenu);
    const nowHidden = sleepMenu.classList.toggle('jellio-player-popover-hidden');
    settingsButton.setAttribute('aria-expanded', 'false');
    sleepButton.setAttribute('aria-expanded', String(!nowHidden));
    if (!nowHidden) {
      sleepMenu.style.top = '';
      sleepMenu.style.bottom = '';
      positionPopover(settingsButton, sleepMenu);
    }
    wakeControls();
  });
  settingsMenu.appendChild(live.sleepOption);

  const shortcutsOption = el('button', 'jellio-player-popover-option jellio-player-popover-shortcuts-option');
  shortcutsOption.type = 'button';
  shortcutsOption.appendChild(el('span', '', t('player_keyboard_shortcuts')));
  const shortcutHint = el('span', 'jellio-player-shortcut-badge', '?');
  shortcutsOption.appendChild(shortcutHint);
  shortcutsOption.addEventListener('click', function () {
    closePopovers(null);
    live.openShortcutsModal();
  });
  settingsMenu.appendChild(shortcutsOption);

  registerPopover(settingsButton, settingsMenu);

  // === Keyboard Shortcuts Modal ===
  const shortcutsModal = el('div', 'jellio-player-shortcuts-modal jellio-player-shortcuts-modal-hidden');
  const shortcutsBackdrop = el('div', 'jellio-player-shortcuts-backdrop');
  const shortcutsCard = el('div', 'jellio-player-shortcuts-card');
  const shortcutsHeader = el('div', 'jellio-player-shortcuts-header');
  shortcutsHeader.appendChild(el('h3', 'jellio-player-shortcuts-title', t('player_keyboard_shortcuts')));
  const shortcutsClose = el('button', 'jellio-player-shortcuts-close', '×');
  shortcutsClose.type = 'button';
  shortcutsClose.setAttribute('aria-label', t('player_close_shortcuts'));
  shortcutsHeader.appendChild(shortcutsClose);
  shortcutsCard.appendChild(shortcutsHeader);

  const shortcutsList = el('div', 'jellio-player-shortcuts-list');
  const SHORTCUTS = [
    { key: 'Space / K', desc: 'Play / Pause' },
    { key: '← / → / J / L', desc: 'Seek 10 seconds' },
    { key: '↑ / ↓ / Wheel', desc: 'Volume up / down' },
    { key: 'M', desc: 'Mute / Unmute' },
    { key: 'F / DblClick', desc: 'Toggle Fullscreen' },
    { key: 'C', desc: 'Subtitles & styling' },
    { key: 'Z / X', desc: 'Subtitle sync (-0.1s / +0.1s)' },
    { key: ', / .', desc: 'Frame step (when paused)' },
    { key: '< / >', desc: 'Playback speed' },
    { key: 'S', desc: 'Skip Intro / Credits' },
    { key: 'Alt + C', desc: 'Cast to Smart TV / device' },
    { key: '?', desc: 'Toggle cheat sheet' },
    { key: 'Esc', desc: 'Close dialog / panel' },
  ];
  SHORTCUTS.forEach(function (sc) {
    const row = el('div', 'jellio-player-shortcut-row');
    const badge = el('kbd', 'jellio-player-shortcut-badge', sc.key);
    const desc = el('span', 'jellio-player-shortcut-desc', sc.desc);
    row.appendChild(badge);
    row.appendChild(desc);
    shortcutsList.appendChild(row);
  });
  shortcutsCard.appendChild(shortcutsList);
  shortcutsModal.appendChild(shortcutsBackdrop);
  shortcutsModal.appendChild(shortcutsCard);

  live.openShortcutsModal = function () {
    shortcutsModal.classList.remove('jellio-player-shortcuts-modal-hidden');
    wakeControls();
  };
  live.closeShortcutsModal = function () {
    shortcutsModal.classList.add('jellio-player-shortcuts-modal-hidden');
  };
  live.toggleShortcutsModal = function () {
    if (shortcutsModal.classList.contains('jellio-player-shortcuts-modal-hidden')) {
      live.openShortcutsModal();
    } else {
      live.closeShortcutsModal();
    }
  };

  shortcutsBackdrop.addEventListener('click', live.closeShortcutsModal);
  shortcutsClose.addEventListener('click', live.closeShortcutsModal);
  return { settingsMenu, shortcutsModal };
}
