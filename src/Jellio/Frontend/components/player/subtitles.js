// Subtitle menu, track loading, burn-in, style and sync offset.
// Built by screens/player.js; live is its playerLive accessor object.

import {
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_SIZES,
  applySubtitleStyle,
  saveSubtitleStyle,
} from '../../runtime/playerPrefs.js';
import {
  TICKS_PER_SECOND,
  buildStreamUrl,
  buildSubtitleUrl,
  getPlaybackInfo,
  getSubtitleStreams,
  matchSubtitleStream,
  reportPlaybackStopped,
} from '../../runtime/api.js';
import { avoidingVideoTranscodes, getVideoTranscodePolicy } from '../../runtime/transcodePolicy.js';
import { el } from '../../runtime/dom.js';
import { languageName } from '../../runtime/languages.js';
import { readString, remove, writeString } from '../../runtime/storage.js';
import { t } from '../../runtime/i18n.js';

export function buildSubtitleControls(deps, live) {
  const {
    attemptPlay, closePopovers, currentPositionTicks, currentUserPromise, itemId, registerPopover, scope,
    showLoadingLogo, showPlayerToast, subtitleButton, video, waitForPlayableBuffer, willUseHls,
  } = deps;

  const subtitleMenu = el('div', 'jellio-player-popover jellio-player-popover-large jellio-player-popover-hidden');
  const subtitleColumns = el('div', 'jellio-player-popover-columns');
  const subtitleLanguageList = el('div', 'jellio-player-popover-list jellio-player-popover-languages');
  const subtitleList = el('div', 'jellio-player-popover-list jellio-player-popover-tracks');
  subtitleColumns.appendChild(subtitleLanguageList);
  subtitleColumns.appendChild(subtitleList);
  subtitleMenu.appendChild(subtitleColumns);

  let reentrant = false;
  function enforceSubtitleTrackModes() {
    if (reentrant) return;
    reentrant = true;
    try {
      for (let i = 0; i < video.textTracks.length; i++) {
        const tt = video.textTracks[i];
        const desired = live.activeTrack && live.activeTrack.track === tt ? 'showing' : 'disabled';
        if (tt.mode !== desired) tt.mode = desired;
      }
    } finally {
      reentrant = false;
    }
  }
  scope.listen(video.textTracks, 'change', enforceSubtitleTrackModes);

  function normalizeCuePositions(textTrack) {
    const cues = textTrack.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (typeof VTTCue === 'undefined' || !(cue instanceof VTTCue)) continue;
      try {
        cue.align = 'center';
        cue.position = 'auto';
        cue.snapToLines = false;
        cue.line = 82;
        cue.size = 100;
      } catch (err) {
      }
    }
  }

  const SUB_OFFSET_STORAGE_PREFIX = 'jellio_sub_offset_';
  let subtitleOffsetSec = 0;
  try {
    const savedOffset = parseFloat(readString(SUB_OFFSET_STORAGE_PREFIX + itemId));
    if (Number.isFinite(savedOffset)) {
      subtitleOffsetSec = Math.round(savedOffset * 10) / 10;
    }
  } catch (e) {}

  function applyCuesOffset(textTrack, offset) {
    if (!textTrack || !textTrack.cues) return;
    const cues = textTrack.cues;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (cue._origStart === undefined) {
        cue._origStart = cue.startTime;
        cue._origEnd = cue.endTime;
      }
      cue.startTime = Math.max(0, cue._origStart + offset);
      cue.endTime = Math.max(0, cue._origEnd + offset);
    }
  }

  function selectSubtitle(stream, optionButton) {
    if (live.activeTrack) {
      if (live.activeTrack.track) live.activeTrack.track.mode = 'disabled';
      live.activeTrack.remove();
      live.activeTrack = null;
    }
    live.activeSubtitleStreamIndex = stream ? stream.Index : null;
    Array.prototype.forEach.call(subtitleList.children, function (child) {
      child.classList.remove('jellio-player-popover-option-active');
    });
    if (optionButton) optionButton.classList.add('jellio-player-popover-option-active');
    subtitleButton.classList.toggle('jellio-player-pill-btn-active', !!stream);
    if (!stream) {
      enforceSubtitleTrackModes();
      return;
    }
    attachSubtitleTrack(stream, 0);
  }

  const MAX_SUBTITLE_LOAD_ATTEMPTS = 4;
  const SUBTITLE_RETRY_DELAY_MS = 4000;

  function attachSubtitleTrack(stream, attempt) {
    if (live.activeSubtitleStreamIndex !== stream.Index) return;
    if (live.activeTrack) {
      if (live.activeTrack.track) live.activeTrack.track.mode = 'disabled';
      live.activeTrack.remove();
      live.activeTrack = null;
    }
    showPlayerToast(
      attempt === 0
        ? t('player_subtitles_loading')
        : t('player_subtitles_loading_retry', { n: attempt + 1, total: MAX_SUBTITLE_LOAD_ATTEMPTS }),
    );
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = stream.DisplayTitle || stream.Language || 'Subtitle';
    track.srclang = stream.Language || '';
    track.src = buildSubtitleUrl(itemId, live.mediaSource.Id, stream);
    track.default = true;
    video.appendChild(track);
    live.activeTrack = track;
    track.addEventListener('load', function () {
      if (live.activeTrack !== track) return;
      if (!track.track) return;
      normalizeCuePositions(track.track);
      if (subtitleOffsetSec !== 0) {
        applyCuesOffset(track.track, subtitleOffsetSec);
      }
      track.track.mode = 'showing';
      enforceSubtitleTrackModes();
    });
    track.addEventListener('error', function () {
      if (live.activeTrack !== track) return;
      if (attempt + 1 < MAX_SUBTITLE_LOAD_ATTEMPTS) {
        window.setTimeout(function () {
          if (live.activeSubtitleStreamIndex === stream.Index) attachSubtitleTrack(stream, attempt + 1);
        }, SUBTITLE_RETRY_DELAY_MS);
        return;
      }
      showPlayerToast(t('player_subtitle_load_failed'));
    });
  }

  async function selectBurnedInSubtitle(stream, optionButton) {
    if (live.activeTrack) {
      if (live.activeTrack.track) live.activeTrack.track.mode = 'disabled';
      live.activeTrack.remove();
      live.activeTrack = null;
    }
    Array.prototype.forEach.call(subtitleList.children, function (child) {
      child.classList.remove('jellio-player-popover-option-active');
    });
    if (optionButton) optionButton.classList.add('jellio-player-popover-option-active');
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    try {
      reportPlaybackStopped(itemId, live.mediaSource.Id, resumeTicks);
      const info = await getPlaybackInfo(itemId, resumeTicks, live.mediaSource.Id, live.currentAudioStreamIndex, stream.Index);
      const negotiated = info && info.MediaSources && info.MediaSources[0];
      if (!negotiated) {
        showPlayerToast(t('player_subtitle_gone'));
        return;
      }
      live.mediaSource = negotiated;
      live.playSessionId = info.PlaySessionId;
      live.activeSubtitleStreamIndex = stream.Index;
      live.streamIsTranscoded = true;
      const subtitleUsesHls = willUseHls(live.mediaSource, true);
      live.needsStartOffset = !subtitleUsesHls;
      live.streamOffsetTicks = live.needsStartOffset ? resumeTicks : 0;
      live.pendingNativeSeekSeconds = subtitleUsesHls ? resumeTicks / TICKS_PER_SECOND : null;
      live.hasReportedStart = false;
      video.src = buildStreamUrl(itemId, live.mediaSource, resumeTicks, {
        audioStreamIndex: live.currentAudioStreamIndex,
        burnInSubtitleStreamIndex: stream.Index,
        forceTranscode: true,
        playSessionId: live.playSessionId,
      });
      video.load();
      showLoadingLogo();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      subtitleButton.classList.add('jellio-player-pill-btn-active');
      live.rebuildAudioMenu();
      rebuildSubtitleMenu();
      closePopovers(null);
      showPlayerToast(t('player_subtitle_burn_in', { name: stream.DisplayTitle || stream.Language || 'subtitle' }));
    } catch (err) {
      console.warn('Jellio: selectBurnedInSubtitle failed', err);
      showPlayerToast(t('player_subtitle_switch_failed', { error: err && err.message ? err.message : err }));
    }
  }

  function renderSubtitleTrackList(subtitleStreams) {
    subtitleList.textContent = '';
    const offOption = el(
      'button',
      'jellio-player-popover-option' + (live.activeSubtitleStreamIndex == null ? ' jellio-player-popover-option-active' : ''),
      'Off',
    );
    offOption.type = 'button';
    offOption.addEventListener('click', function () {
      selectSubtitle(null, offOption);
    });
    subtitleList.appendChild(offOption);
    subtitleStreams
      .filter(function (stream) {
        return !live.selectedSubtitleLanguage || (stream.Language || '').toLowerCase() === live.selectedSubtitleLanguage;
      })
      .forEach(function (stream) {
        const label =
          (stream.DisplayTitle || stream.Language || 'Subtitle') +
          (stream.IsTextSubtitleStream ? '' : avoidingVideoTranscodes() ? ' (slow: burns into video)' : ' (image)');
        const option = el(
          'button',
          'jellio-player-popover-option' +
            (stream.Index === live.activeSubtitleStreamIndex ? ' jellio-player-popover-option-active' : ''),
          label,
        );
        option.type = 'button';
        option.addEventListener('click', function () {
          if (stream.IsTextSubtitleStream) {
            selectSubtitle(stream, option);
          } else {
            selectBurnedInSubtitle(stream, option);
          }
        });
        subtitleList.appendChild(option);
      });
  }

  function rebuildSubtitleMenu() {
    subtitleLanguageList.textContent = '';
    // Video transcode policy Block: image subtitles would need a re-encode,
    // so they aren't offered.
    const subtitleStreams = getSubtitleStreams(live.mediaSource).filter(function (stream) {
      return getVideoTranscodePolicy() !== 'Block' || stream.IsTextSubtitleStream;
    });
    if (!subtitleStreams.length) {
      subtitleButton.disabled = true;
      return;
    }
    subtitleButton.disabled = false;
    live.selectedSubtitleLanguage = null;

    const noneOption = el('button', 'jellio-player-popover-option jellio-player-popover-option-active', t('vocab_all_languages'));
    noneOption.type = 'button';
    noneOption.addEventListener('click', function () {
      live.selectedSubtitleLanguage = null;
      Array.prototype.forEach.call(subtitleLanguageList.children, function (child) {
        child.classList.remove('jellio-player-popover-option-active');
      });
      noneOption.classList.add('jellio-player-popover-option-active');
      renderSubtitleTrackList(subtitleStreams);
    });
    subtitleLanguageList.appendChild(noneOption);

    const languages = [];
    subtitleStreams.forEach(function (stream) {
      const code = (stream.Language || '').toLowerCase();
      if (code && languages.indexOf(code) === -1) languages.push(code);
    });
    languages.forEach(function (code) {
      const option = el('button', 'jellio-player-popover-option', languageName(code));
      option.type = 'button';
      option.addEventListener('click', function () {
        live.selectedSubtitleLanguage = code;
        Array.prototype.forEach.call(subtitleLanguageList.children, function (child) {
          child.classList.remove('jellio-player-popover-option-active');
        });
        option.classList.add('jellio-player-popover-option-active');
        renderSubtitleTrackList(subtitleStreams);
      });
      subtitleLanguageList.appendChild(option);
    });

    renderSubtitleTrackList(subtitleStreams);
  }
  (async function () {
    let matched = null;
    try {
      const user = await currentUserPromise;
      const subtitleMode = user && user.Configuration && user.Configuration.SubtitleMode;
      const preferredLanguage = user && user.Configuration && user.Configuration.SubtitleLanguagePreference;
      const isSubtitlesDisabled = subtitleMode === 'None' || preferredLanguage === 'off' || preferredLanguage === 'none' || !preferredLanguage;
      matched = isSubtitlesDisabled ? null : matchSubtitleStream(live.mediaSource, preferredLanguage);
    } catch (err) {
      console.warn('Jellio: could not match preferred subtitle language', err);
    }
    if (matched) live.activeSubtitleStreamIndex = matched.Index;
    rebuildSubtitleMenu();
    if (matched) {
      if (matched.DeliveryMethod === 'External' || live.hasReportedStart) {
        attachSubtitleTrack(matched, 0);
      } else {
        live.deferredAutoSubtitleStream = matched;
      }
    }
  })();

  registerPopover(subtitleButton, subtitleMenu);

  const styleSection = el('div', 'jellio-player-popover-style');
  subtitleMenu.appendChild(styleSection);

  function buildStyleGroup(label, options, currentValue, onPick) {
    const group = el('div', 'jellio-player-style-group');
    group.appendChild(el('div', 'jellio-player-style-group-label', label));
    const optionRow = el('div', 'jellio-player-style-group-options');
    options.forEach(function (option) {
      const optionButton = el(
        'button',
        'jellio-player-popover-option' + (option.value === currentValue ? ' jellio-player-popover-option-active' : ''),
        option.label,
      );
      optionButton.type = 'button';
      optionButton.addEventListener('click', function () {
        onPick(option.value);
        Array.prototype.forEach.call(optionRow.children, function (child) {
          child.classList.remove('jellio-player-popover-option-active');
        });
        optionButton.classList.add('jellio-player-popover-option-active');
      });
      optionRow.appendChild(optionButton);
    });
    group.appendChild(optionRow);
    return group;
  }

  styleSection.appendChild(
    buildStyleGroup('Size', SUBTITLE_SIZES, live.subtitleStyle.size, function (value) {
      live.subtitleStyle = Object.assign({}, live.subtitleStyle, { size: value });
      applySubtitleStyle(video, live.subtitleStyle);
      saveSubtitleStyle(live.subtitleStyle);
    }),
  );
  styleSection.appendChild(
    buildStyleGroup('Background', SUBTITLE_BACKGROUNDS, live.subtitleStyle.background, function (value) {
      live.subtitleStyle = Object.assign({}, live.subtitleStyle, { background: value });
      applySubtitleStyle(video, live.subtitleStyle);
      saveSubtitleStyle(live.subtitleStyle);
    }),
  );

  const syncSection = el('div', 'jellio-player-style-group');
  syncSection.appendChild(el('div', 'jellio-player-style-group-label', t('player_delay_sync')));
  const syncRow = el('div', 'jellio-player-subtitle-sync-row');
  const minusHalf = el('button', 'jellio-player-popover-option', '-0.5s');
  minusHalf.type = 'button';
  const minusTenth = el('button', 'jellio-player-popover-option', '-0.1s');
  minusTenth.type = 'button';
  const syncDisplay = el('span', 'jellio-player-subtitle-sync-value', (subtitleOffsetSec > 0 ? '+' : '') + subtitleOffsetSec.toFixed(1) + 's');
  const plusTenth = el('button', 'jellio-player-popover-option', '+0.1s');
  plusTenth.type = 'button';
  const plusHalf = el('button', 'jellio-player-popover-option', '+0.5s');
  plusHalf.type = 'button';
  const resetBtn = el('button', 'jellio-player-popover-option', t('action_reset'));
  resetBtn.type = 'button';

  function updateSubtitleOffset(delta, isReset) {
    if (isReset) {
      subtitleOffsetSec = 0;
    } else {
      subtitleOffsetSec = Math.round((subtitleOffsetSec + delta) * 10) / 10;
    }
    try {
      if (subtitleOffsetSec !== 0) {
        writeString(SUB_OFFSET_STORAGE_PREFIX + itemId, String(subtitleOffsetSec));
      } else {
        remove(SUB_OFFSET_STORAGE_PREFIX + itemId);
      }
    } catch (e) {}
    syncDisplay.textContent = (subtitleOffsetSec > 0 ? '+' : '') + subtitleOffsetSec.toFixed(1) + 's';
    if (live.activeTrack && live.activeTrack.track) {
      applyCuesOffset(live.activeTrack.track, subtitleOffsetSec);
    }
    showPlayerToast(t('player_toast_subtitle_sync', { value: syncDisplay.textContent }));
  }

  minusHalf.addEventListener('click', function () { updateSubtitleOffset(-0.5); });
  minusTenth.addEventListener('click', function () { updateSubtitleOffset(-0.1); });
  plusTenth.addEventListener('click', function () { updateSubtitleOffset(0.1); });
  plusHalf.addEventListener('click', function () { updateSubtitleOffset(0.5); });
  resetBtn.addEventListener('click', function () { updateSubtitleOffset(0, true); });

  syncRow.appendChild(minusHalf);
  syncRow.appendChild(minusTenth);
  syncRow.appendChild(syncDisplay);
  syncRow.appendChild(plusTenth);
  syncRow.appendChild(plusHalf);
  syncRow.appendChild(resetBtn);
  syncSection.appendChild(syncRow);
  styleSection.appendChild(syncSection);
  return { rebuildSubtitleMenu, subtitleMenu, updateSubtitleOffset, attachSubtitleTrack };
}
