// Repeated buffering: offer (or switch to) the next stream at the same spot.
// Built by screens/player.js; live is its playerLive accessor object.

import { el } from '../../runtime/dom.js';
import { getBufferSwitchMode, setBufferSwitchMode } from '../../runtime/bufferSettings.js';
import { getCurrentGroup } from '../../runtime/syncPlay.js';
import { markBadSource } from '../../runtime/streamHealth.js';
import { t } from '../../runtime/i18n.js';

export function wireBufferPrompt(deps, live) {
  const { failoverTried, itemId, nextStreams, root, showPlayerToast, streamLanguage, switchSource, video } = deps;

  // A stream that keeps stopping to buffer: offer the next one (or switch
  // straight away when that's the setting), resuming at the same spot.
  const BUFFER_WINDOW_MS = 120000;
  const BUFFER_STALL_TOTAL_MS = 12000;
  const BUFFER_STALL_COUNT = 4;
  const BUFFER_PROMPT_SNOOZE_MS = 10 * 60000;
  const bufferStalls = [];
  let bufferPromptSnoozedUntil = 0;
  let bufferPrompt = null;
  let bufferSwitching = false;

  function recentStalls(now) {
    while (bufferStalls.length && now - bufferStalls[0].at > BUFFER_WINDOW_MS) bufferStalls.shift();
    return bufferStalls;
  }

  function checkBuffering() {
    const now = Date.now();
    const stalls = recentStalls(now);
    const ongoing = live.bufferStallStartedAt ? now - live.bufferStallStartedAt : 0;
    const total = stalls.reduce(function (sum, stall) {
      return sum + stall.ms;
    }, ongoing);
    const count = stalls.length + (live.bufferStallStartedAt ? 1 : 0);
    if (total < BUFFER_STALL_TOTAL_MS && count < BUFFER_STALL_COUNT) return;
    if (bufferPrompt || bufferSwitching || now < bufferPromptSnoozedUntil) return;
    const mode = getBufferSwitchMode();
    if (mode === 'off') return;
    if (mode === 'auto') switchForBuffering();
    else showBufferPrompt();
  }

  function closeBufferPrompt() {
    if (bufferPrompt) bufferPrompt.remove();
    bufferPrompt = null;
  }

  function showBufferPrompt() {
    bufferPrompt = el('div', 'jellio-player-buffer-prompt');
    bufferPrompt.appendChild(el('div', 'jellio-player-buffer-prompt-text', t('player_buffer_prompt')));
    const actions = el('div', 'jellio-player-buffer-prompt-actions');
    const switchButton = el('button', 'jellio-settings-button', t('player_buffer_switch'));
    switchButton.type = 'button';
    switchButton.addEventListener('click', function () {
      closeBufferPrompt();
      switchForBuffering();
    });
    const keep = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('player_buffer_keep'));
    keep.type = 'button';
    keep.addEventListener('click', function () {
      closeBufferPrompt();
      bufferPromptSnoozedUntil = Date.now() + BUFFER_PROMPT_SNOOZE_MS;
    });
    const always = el('button', 'jellio-player-buffer-prompt-always', t('player_buffer_always'));
    always.type = 'button';
    always.addEventListener('click', function () {
      setBufferSwitchMode('auto');
      closeBufferPrompt();
      switchForBuffering();
    });
    actions.appendChild(switchButton);
    actions.appendChild(keep);
    actions.appendChild(always);
    bufferPrompt.appendChild(actions);
    root.appendChild(bufferPrompt);
    switchButton.focus();
  }

  async function switchForBuffering() {
    if (bufferSwitching || live.screenTornDown || getCurrentGroup()) return;
    bufferSwitching = true;
    const tried = failoverTried.concat(live.mediaSource && live.mediaSource.Id ? [live.mediaSource.Id] : []);
    const language = await streamLanguage();
    const ordered = await nextStreams(tried, language, 'buffering switch');
    if (live.screenTornDown) return;
    if (!ordered.length) {
      bufferSwitching = false;
      bufferPromptSnoozedUntil = Date.now() + BUFFER_PROMPT_SNOOZE_MS;
      showPlayerToast(t('player_buffer_no_other'));
      return;
    }
    markBadSource(itemId, live.mediaSource, { soft: true });
    if (live.mediaSource && live.mediaSource.Id && failoverTried.indexOf(live.mediaSource.Id) === -1) failoverTried.push(live.mediaSource.Id);
    await switchSource(ordered[0]);
    bufferSwitching = false;
  }

  video.addEventListener('waiting', function () {
    if (!live.hasReportedStart || video.paused || live.syncPlaylistItemId || live.bufferStallStartedAt) return;
    if (Date.now() - live.lastUserSeekAt < 4000) return;
    live.bufferStallStartedAt = Date.now();
    if (live.bufferStallTimer) window.clearInterval(live.bufferStallTimer);
    live.bufferStallTimer = window.setInterval(function () {
      if (live.screenTornDown || !live.bufferStallStartedAt) {
        window.clearInterval(live.bufferStallTimer);
        live.bufferStallTimer = null;
        return;
      }
      checkBuffering();
    }, 1000);
  });
  video.addEventListener('playing', function () {
    if (!live.bufferStallStartedAt) return;
    bufferStalls.push({ at: Date.now(), ms: Date.now() - live.bufferStallStartedAt });
    live.bufferStallStartedAt = 0;
    if (live.bufferStallTimer) window.clearInterval(live.bufferStallTimer);
    live.bufferStallTimer = null;
    checkBuffering();
  });
  return { bufferStalls, closeBufferPrompt };
}
