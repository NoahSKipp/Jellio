// Next episode: preload, Up Next countdown and the end screen.
// Built by screens/player.js; live is its playerLive accessor object.

import {
  TICKS_PER_SECOND,
  buildStreamUrl,
  canBrowserDirectPlay,
  getMediaSources,
  getNextEpisode,
  getPlaybackInfo,
  getQualityTiers,
  getWarmSources,
  isPlaceholderSource,
  prefetchStreams,
  seedItemCache,
} from '../../runtime/api.js';
import { buildEndScreenModal, buildUpNextOverlay } from '../playerOverlays.js';
import { getUpNextCountdownSeconds } from '../../runtime/upNextSettings.js';
import { isBadSource } from '../../runtime/streamHealth.js';
import { isPreferReadyEnabled, normalizeId } from '../../runtime/readySources.js';
import { navigateTo } from '../../runtime/router.js';
import { notePlayTrigger } from '../../runtime/playStart.js';
import { orderByLanguage } from '../../runtime/streamLanguage.js';
import { pickPlaySource, prewarmedPlayback } from '../../runtime/playbackPrefetch.js';
import { playHash, rememberedSourceId, sourceAudioLanguages } from '../streamPicker.js';
import { preferredAudioIndex } from '../playPrefetch.js';
import { t } from '../../runtime/i18n.js';

export function wireUpNext(deps, live) {
  const {
    attemptPlay, currentPositionTicks, currentUserPromise, itemId, markRealWatchComplete, performSeek,
    pickNegotiatedSource, reportRealDurationIfUseful, root, showLoadingLogo, video, waitForPlayableBuffer,
    wakeControls,
  } = deps;

  let upNextOverlay = null;
  let upNextPlayButton = null;
  let upNextCountdownRemaining = getUpNextCountdownSeconds();
  let isNavigatingNext = false;

  function activeAudioLanguageCode() {
    if (!live.mediaSource) return null;
    const audioStreams = (live.mediaSource.MediaStreams || []).filter(function (stream) {
      return stream.Type === 'Audio';
    });
    const wantedIndex = live.currentAudioStreamIndex != null ? live.currentAudioStreamIndex : live.mediaSource.DefaultAudioStreamIndex;
    const active = audioStreams.find(function (stream) {
      return stream.Index === wantedIndex;
    });
    return active && active.Language ? active.Language.toLowerCase() : null;
  }

  let preloadedNextMediaSourceId = null;

  // Negotiates the next episode ahead (T-55 s) and keeps the answer for its
  // player (From: prewarmed); a stream played as is is also buffered.
  function preloadNextEpisodeStream() {
    if (live.hasInitiatedNextPreload || !live.nextEpisode || live.screenTornDown) return;
    live.hasInitiatedNextPreload = true;
    const target = live.nextEpisode;
    const languageCode = activeAudioLanguageCode();
    Promise.all([
      getMediaSources(target.Id),
      getWarmSources(target.Id),
      getQualityTiers(target.Id),
      currentUserPromise.catch(function () {
        return null;
      }),
    ])
      .then(async function (results) {
        const sources = results[0];
        if (live.screenTornDown || !sources || !sources.length) return;
        const warm = new Set(Object.keys(results[1] || {}).map(normalizeId));
        const tiers = {};
        Object.keys(results[2] || {}).forEach(function (id) {
          tiers[normalizeId(id)] = results[2][id];
        });
        const source = pickPlaySource(sources, {
          rememberedId: rememberedSourceId(target.Id),
          isBad: function (candidate) {
            return isBadSource(target.Id, candidate);
          },
          byLanguage: languageCode
            ? function (list) {
                return orderByLanguage(list, languageCode, sourceAudioLanguages);
              }
            : null,
          preferReady: isPreferReadyEnabled(),
          isReady: function (candidate) {
            return warm.has(normalizeId(candidate.Id));
          },
          tierOf: function (candidate) {
            return tiers[normalizeId(candidate.Id)];
          },
        });
        if (!source || isPlaceholderSource(source)) return;
        preloadedNextMediaSourceId = source.Id;
        const ticks = (target.UserData && target.UserData.PlaybackPositionTicks) || 0;
        const audioIndex = preferredAudioIndex(source, results[3]);
        const promise = getPlaybackInfo(target.Id, ticks, source.Id, audioIndex);
        promise.catch(function () {});
        prewarmedPlayback.put(target.Id, source.Id, ticks, { promise: promise, audioIndex: audioIndex });
        try {
          const info = await promise;
          const nextSource = pickNegotiatedSource(info, source.Id);
          // A transcode would start a server job only to throw it away.
          const asIs = nextSource && ticks === 0 && audioIndex == null && canBrowserDirectPlay(nextSource);
          if (!live.screenTornDown && asIs && !live.preloadedNextVideoEl) {
            live.preloadedNextVideoEl = document.createElement('video');
            live.preloadedNextVideoEl.preload = 'auto';
            live.preloadedNextVideoEl.muted = true;
            live.preloadedNextVideoEl.playsInline = true;
            live.preloadedNextVideoEl.src = buildStreamUrl(target.Id, nextSource, 0, {
              playSessionId: info.PlaySessionId,
            });
          }
        } catch (e) {
          // A failed preload leaves the next player to negotiate itself.
        }
      })
      .catch(function () {});
  }

  async function playNextEpisode() {
    if (isNavigatingNext) return;
    isNavigatingNext = true;
    if (live.upNextCountdownInterval) {
      window.clearInterval(live.upNextCountdownInterval);
      live.upNextCountdownInterval = null;
    }
    if (live.endScreenModalInstance) {
      live.endScreenModalInstance.cleanup();
      live.endScreenModalInstance = null;
    }
    const target = live.nextEpisode;
    if (!target) return;
    live.nextEpisode = null;

    let mediaSourceId = preloadedNextMediaSourceId;
    if (!mediaSourceId) {
      const languageCode = activeAudioLanguageCode();
      if (languageCode) {
        try {
          const sources = await getMediaSources(target.Id);
          const matched = sources.find(function (source) {
            return sourceAudioLanguages(source).indexOf(languageCode) !== -1;
          });
          if (matched) mediaSourceId = matched.Id;
        } catch (err) {
          console.warn('Jellio: could not check next episode sources for a matching audio language', err);
        }
      }
    }

    if (live.preloadedNextVideoEl) {
      try {
        live.preloadedNextVideoEl.src = '';
        live.preloadedNextVideoEl.load();
      } catch (e) {}
      live.preloadedNextVideoEl = null;
    }

    // Its known resume point lets the next player take the prewarmed answer
    // without waiting for the details.
    if (target.UserData) seedItemCache(target);
    notePlayTrigger(target.Id, 'next-episode');
    navigateTo(playHash(target.Id, mediaSourceId));
  }

  function replayCurrentItem() {
    if (live.endScreenModalInstance) {
      live.endScreenModalInstance.cleanup();
      live.endScreenModalInstance = null;
    }
    live.hasReportedStart = false;
    if (live.streamOffsetTicks > 0 || live.needsStartOffset) {
      getPlaybackInfo(itemId, 0, live.mediaSource ? live.mediaSource.Id : null, live.currentAudioStreamIndex)
        .then(function (info) {
          const negotiated = info && info.MediaSources && info.MediaSources[0];
          if (negotiated) {
            live.mediaSource = negotiated;
            live.playSessionId = info.PlaySessionId;
            live.streamOffsetTicks = 0;
            live.needsStartOffset = false;
            live.pendingNativeSeekSeconds = null;
            video.src = buildStreamUrl(itemId, live.mediaSource, 0, {
              audioStreamIndex: live.currentAudioStreamIndex,
              forceTranscode: true,
              playSessionId: live.playSessionId,
            });
            video.load();
            showLoadingLogo();
            waitForPlayableBuffer(attemptPlay);
            return;
          }
          performSeek(0);
          attemptPlay();
        })
        .catch(function () {
          performSeek(0);
          attemptPlay();
        });
    } else {
      performSeek(0);
      attemptPlay();
    }
  }

  function showEndScreenModal() {
    if (live.endScreenModalInstance || isNavigatingNext) return;
    hideUpNext();

    const countdownSetting = getUpNextCountdownSeconds();
    const shouldCountdown = !live.upNextDismissed && countdownSetting > 0;
    const initialCountdown = shouldCountdown
      ? (live.upNextShown && upNextCountdownRemaining > 0 ? upNextCountdownRemaining : countdownSetting)
      : null;

    live.endScreenModalInstance = buildEndScreenModal({
      item: live.item,
      nextEpisode: live.nextEpisode,
      onPlayNext: function () {
        if (live.endScreenModalInstance) {
          live.endScreenModalInstance.cleanup();
          live.endScreenModalInstance = null;
        }
        playNextEpisode();
      },
      onReplay: function () {
        if (live.endScreenModalInstance) {
          live.endScreenModalInstance.cleanup();
          live.endScreenModalInstance = null;
        }
        replayCurrentItem();
      },
      onClose: function () {
        if (live.endScreenModalInstance) {
          live.endScreenModalInstance.cleanup();
          live.endScreenModalInstance = null;
        }
      },
      onBack: function () {
        if (live.endScreenModalInstance) {
          live.endScreenModalInstance.cleanup();
          live.endScreenModalInstance = null;
        }
        if (live.item.SeriesId) {
          navigateTo('#/item?id=' + live.item.SeriesId);
        } else {
          navigateTo('#/home');
        }
      },
      initialCountdown: initialCountdown,
    });

    root.appendChild(live.endScreenModalInstance.overlay);
    if (live.endScreenModalInstance.primaryBtn) {
      live.endScreenModalInstance.primaryBtn.focus();
    }
    wakeControls();
  }

  function updateUpNextCountdown() {
    if (upNextPlayButton) {
      if (upNextCountdownRemaining > 0) {
        upNextPlayButton.textContent = t('player_play_now_countdown', { seconds: upNextCountdownRemaining });
      } else {
        upNextPlayButton.textContent = t('player_play_now');
      }
    }
  }

  function showUpNext() {
    if (live.upNextShown || live.upNextDismissed || !upNextOverlay) return;
    live.upNextShown = true;
    preloadNextEpisodeStream();
    markRealWatchComplete();
    reportRealDurationIfUseful(currentPositionTicks() / TICKS_PER_SECOND);
    upNextOverlay.classList.remove('jellio-player-upnext-hidden');
    const countdownSecs = getUpNextCountdownSeconds();
    if (countdownSecs > 0) {
      upNextCountdownRemaining = countdownSecs;
      updateUpNextCountdown();
      live.upNextCountdownInterval = window.setInterval(function () {
        upNextCountdownRemaining -= 1;
        updateUpNextCountdown();
        if (upNextCountdownRemaining <= 0) {
          window.clearInterval(live.upNextCountdownInterval);
          live.upNextCountdownInterval = null;
          playNextEpisode();
        }
      }, 1000);
    } else {
      upNextCountdownRemaining = 0;
      updateUpNextCountdown();
    }
  }

  function hideUpNext() {
    if (live.upNextCountdownInterval) {
      window.clearInterval(live.upNextCountdownInterval);
      live.upNextCountdownInterval = null;
    }
    live.upNextShown = false;
    if (upNextOverlay) upNextOverlay.classList.add('jellio-player-upnext-hidden');
  }

  function dismissUpNext() {
    hideUpNext();
    live.upNextDismissed = true;
  }

  if (live.item.Type === 'Episode') {
    getNextEpisode(live.item)
      .then(function (result) {
        if (!result) return;
        live.nextEpisode = result;
        prefetchStreams(result.Id);
        const built = buildUpNextOverlay(result, playNextEpisode, dismissUpNext);
        upNextOverlay = built.overlay;
        upNextPlayButton = built.playButton;
        root.appendChild(upNextOverlay);
      })
      .catch(function (err) {
        console.warn('Jellio: could not resolve next episode', err);
      });
  }
  return { activeAudioLanguageCode, showEndScreenModal, preloadNextEpisodeStream, dismissUpNext, showUpNext };
}
