// Audio track popover and dialogue boost.
// Built by screens/player.js; live is its playerLive accessor object.

import {
  TICKS_PER_SECOND,
  buildStreamUrl,
  getAudioStreams,
  getPlaybackInfo,
  reportPlaybackStopped,
} from '../../runtime/api.js';
import { el } from '../../runtime/dom.js';
import { t } from '../../runtime/i18n.js';

export function buildAudioMenu(deps, live) {
  const {
    attemptPlay, audioButton, closePopovers, currentPositionTicks, itemId, pickNegotiatedSource,
    rebuildSubtitleMenu, registerPopover, showLoadingLogo, showPlayerToast, video, waitForPlayableBuffer,
    willUseHls,
  } = deps;

  // === Audio track popover ===
  let sourceNode = null;
  let compressorNode = null;
  let dialogueBoostEnabled = false;

  function setDialogueBoost(enabled) {
    dialogueBoostEnabled = enabled;
    try {
      if (!live.audioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          live.audioCtx = new AudioCtxClass();
          sourceNode = live.audioCtx.createMediaElementSource(video);
          compressorNode = live.audioCtx.createDynamicsCompressor();
          compressorNode.threshold.setValueAtTime(-24, live.audioCtx.currentTime);
          compressorNode.knee.setValueAtTime(30, live.audioCtx.currentTime);
          compressorNode.ratio.setValueAtTime(12, live.audioCtx.currentTime);
          compressorNode.attack.setValueAtTime(0.003, live.audioCtx.currentTime);
          compressorNode.release.setValueAtTime(0.25, live.audioCtx.currentTime);
        }
      }
      if (live.audioCtx && live.audioCtx.state === 'suspended') {
        live.audioCtx.resume();
      }
      if (sourceNode && compressorNode && live.audioCtx) {
        sourceNode.disconnect();
        compressorNode.disconnect();
        if (dialogueBoostEnabled) {
          sourceNode.connect(compressorNode);
          compressorNode.connect(live.audioCtx.destination);
        } else {
          sourceNode.connect(live.audioCtx.destination);
        }
      }
    } catch (err) {
      console.warn('Jellio: dialogue boost error', err);
    }
  }

  const audioMenu = el('div', 'jellio-player-popover jellio-player-popover-large jellio-player-popover-hidden');

  function audioStreamLabel(stream) {
    const language = stream.Language ? stream.Language.toUpperCase() : stream.DisplayTitle || 'Unknown';
    const parts = [stream.Codec ? stream.Codec.toUpperCase() : '', stream.ChannelLayout || ''].filter(Boolean);
    return parts.length ? language + ' · ' + parts.join(' ') : language;
  }

  function rebuildAudioMenu() {
    audioMenu.textContent = '';
    const streams = getAudioStreams(live.mediaSource);
    audioButton.disabled = false;
    if (streams.length > 0) {
      streams.forEach(function (stream) {
        const isActive =
          live.currentAudioStreamIndex == null
            ? stream.Index === live.mediaSource.DefaultAudioStreamIndex
            : stream.Index === live.currentAudioStreamIndex;
        const option = el(
          'button',
          'jellio-player-popover-option' + (isActive ? ' jellio-player-popover-option-active' : ''),
          audioStreamLabel(stream),
        );
        option.type = 'button';
        option.addEventListener('click', function () {
          showPlayerToast(t('player_audio_switching', { name: audioStreamLabel(stream) }));
          if (isActive && live.currentAudioStreamIndex != null) {
            closePopovers(null);
            return;
          }
          switchAudioTrack(stream);
        });
        audioMenu.appendChild(option);
      });
    }

    const boostOption = el(
      'button',
      'jellio-player-popover-option jellio-player-boost-option' + (dialogueBoostEnabled ? ' jellio-player-popover-option-active' : ''),
      'Dialogue Boost / Night Mode: ' + (dialogueBoostEnabled ? 'On' : 'Off'),
    );
    boostOption.type = 'button';
    boostOption.addEventListener('click', function () {
      setDialogueBoost(!dialogueBoostEnabled);
      boostOption.textContent = t('player_dialogue_boost', { status: dialogueBoostEnabled ? t('state_on') : t('state_off') });
      if (dialogueBoostEnabled) {
        boostOption.classList.add('jellio-player-popover-option-active');
        showPlayerToast(t('player_dialogue_boost_on'));
      } else {
        boostOption.classList.remove('jellio-player-popover-option-active');
        showPlayerToast(t('player_dialogue_boost_off'));
      }
    });
    audioMenu.appendChild(boostOption);
  }
  registerPopover(audioButton, audioMenu);

  async function switchAudioTrack(stream) {
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    try {
      reportPlaybackStopped(itemId, live.mediaSource.Id, resumeTicks);
      const info = await getPlaybackInfo(itemId, resumeTicks, live.mediaSource.Id, stream.Index);
      const negotiated = pickNegotiatedSource(info, live.mediaSource.Id);
      if (!negotiated) {
        showPlayerToast(t('player_audio_gone'));
        return;
      }
      live.mediaSource = negotiated;
      live.playSessionId = info.PlaySessionId;
      if (live.activeTrack) {
        live.activeTrack.remove();
        live.activeTrack = null;
      }
      live.currentAudioStreamIndex = stream.Index;
      live.streamIsTranscoded = true;
      const switchUsesHls = willUseHls(live.mediaSource, true);
      live.needsStartOffset = !switchUsesHls;
      live.streamOffsetTicks = live.needsStartOffset ? resumeTicks : 0;
      live.pendingNativeSeekSeconds = switchUsesHls ? resumeTicks / TICKS_PER_SECOND : null;
      live.hasReportedStart = false;
      video.src = buildStreamUrl(itemId, live.mediaSource, resumeTicks, {
        audioStreamIndex: live.currentAudioStreamIndex,
        forceTranscode: true,
        playSessionId: live.playSessionId,
      });
      video.load();
      showLoadingLogo();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      rebuildSubtitleMenu();
      rebuildAudioMenu();
      closePopovers(null);
      showPlayerToast(t('player_audio_requested', { name: audioStreamLabel(stream) }));
    } catch (err) {
      console.warn('Jellio: switchAudioTrack failed', err);
      showPlayerToast(t('player_audio_switch_failed', { error: err && err.message ? err.message : err }));
    }
  }
  rebuildAudioMenu();
  return { audioMenu, rebuildAudioMenu };
}
