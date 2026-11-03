import { t, getDisplayLanguage } from '../runtime/i18n.js';
import { preferredStreamLanguage, orderByLanguage } from '../runtime/streamLanguage.js';
import { createPauseGate, startProgressTimer, stopProgressTimer, PAUSE_IDLE_STOP_MS } from '../runtime/playbackGuard.js';
import { attachPictureInPicture } from '../components/pictureInPicture.js';
import { isOffline, findAnyDownload, removeDownload, isAutoDeleteWatchedEnabled } from '../runtime/offline.js';
import { renderOfflinePlayer } from './offlinePlayer.js';
import {
  initGoogleCast,
  getAvailableCastTargets,
  castToJellyfinSession,
  castToGoogleCast,
  promptRemotePlayback,
  promptAirPlay,
  sendRemotePlayPause,
  sendRemoteSeek,
  sendRemoteVolume,
  disconnectCast,
  getActiveCast,
  addCastListener,
  isGoogleCastSupported,
  isAirPlaySupported,
} from '../runtime/cast.js';
import { getItemDetails, getPlaybackInfo, getMediaSources, isPlaceholderSource, buildStreamUrl, buildCastStreamUrl, canBrowserDirectPlay, loadVideoTranscodePolicy, logPlaybackDecision, supportsNativeHls, reportPlaybackStart, reportPlaybackProgress, reportPlaybackStopped, startSleepTimer, cancelSleepTimer, getSleepTimerStatus, getImageUrl, getSubtitleStreams, getAudioStreams, matchAudioStreamIndex, matchSubtitleStream, buildSubtitleUrl, getNextEpisode, getCommunitySkipSegments, getIntroSkipperSegments, getJellioIntroCredits, getSeasons, getEpisodes, getCurrentUser, TICKS_PER_SECOND, creditRealWatch, reportRealDuration, probeRealDuration, setPlayed, prefetchStreams, setPlaybackActive } from '../runtime/api.js';
import { getGroupWatchMessages, sendGroupWatchMessage, creditGroupWatchTogether, voteRankingSession, startJoinSync, clearJoinSync, getJoinSync } from '../runtime/apiSocial.js';
import { syncTracker } from '../runtime/apiBooks.js';
import { getUpNextCountdownSeconds } from '../runtime/upNextSettings.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { invalidateHomeSections } from './home.js';
import { markBadSource, unmarkBadSource, isBadSource, looksLikePlaceholder, hasNoAudio, looksLikeSilentSlideshow, stoppedTooEarly, PLACEHOLDER_STALL_MS } from '../runtime/streamHealth.js';
import { avoidingVideoTranscodes, classifySource, describeTranscodeReason, getVideoTranscodePolicy, playbackOutlook } from '../runtime/transcodePolicy.js';
import { videoInfoOf } from '../runtime/transcodeClassifier.js';
import { sourceLabel, buildOutlookBadge, buildSourceCard, buildLanguageFilterRow, buildQualityFilterRow, filterSources, sourceAudioLanguages, playHash } from '../components/streamPicker.js';
import { renderLoading } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { languageName } from '../runtime/languages.js';
import { buildRatingBadge } from '../components/ratingBadge.js';
import {
  getCurrentGroup,
  getCurrentPlaylistTarget,
  onGroupChange as onSyncGroupChange,
  onCommand as onSyncCommand,
  remoteToLocal,
  estimateCurrentTicks,
  notifyBuffering,
  notifyReady,
  requestSeek as requestSyncSeek,
  requestUnpause as requestSyncUnpause,
  requestPause as requestSyncPause,
  publishQueue as publishSyncQueue,
  getSyncUserId,
  getLastCommand as getLastSyncCommand,
  sameId as sameSyncId,
  leaveGroup as leaveSyncGroup,
} from '../runtime/syncPlay.js';
import { createPartyLayer, askCatchUp } from '../components/partyLayer.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { fetchRankingSession, renderRankingSession, stopRankingCountdown } from '../components/groupWatchRanking.js';
import { el } from '../runtime/dom.js';
import { prebufferSettings, getBufferSwitchMode, setBufferSwitchMode } from '../runtime/bufferSettings.js';
import { loadVolumePreference, saveVolumePreference, SUBTITLE_SIZES, SUBTITLE_BACKGROUNDS, loadSubtitleStyle, saveSubtitleStyle, subtitleStyleTag, applySubtitleStyle } from '../runtime/playerPrefs.js';
import { buildUpNextOverlay, buildEndScreenModal, buildResumePrompt, renderPlaybackError } from '../components/playerOverlays.js';

const PROGRESS_REPORT_MS = 5000;
// title|source pairs already failed over as a placeholder clip this session,
// so a genuinely silent, slideshow-like title can't send us round in circles.
const placeholderFlagged = new Set();
const GROUP_WATCH_COMPLETION_THRESHOLD = 0.9;
const REAL_WATCH_COMPLETION_THRESHOLD = 0.9;
const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];
const EPISODE_SLEEP_TIMER_OPTIONS = [1, 2, 3, 5];
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const IDLE_HIDE_MS = 3000;

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n);
  };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function willUseHls(source, forceTranscode) {
  const directPlay = !forceTranscode && canBrowserDirectPlay(source);
  return !directPlay && supportsNativeHls();
}

let mediaSessionOwner = null;

export async function renderPlayer(root, params) {
  let screenTornDown = false;
  const playerToken = {};
  mediaSessionOwner = playerToken;
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-player';

  const itemId = params.get('id');
  if (!itemId) {
    renderPlaybackError(root, null, 'Nothing to play.');
    return undefined;
  }

  // Downloaded videos (screens/offlinePlayer.js): when the server can't
  // be reached, or when opened from Downloads.
  if (params.get('local') === '1' || isOffline()) return renderOfflinePlayer(root, params);

  const isGroupJoinNavigation = params.get('groupJoin') === '1';

  renderLoading(root);

  const currentUserPromise = getCurrentUser();

  let item;
  try {
    item = await getItemDetails(itemId, { includePlaybackFields: true });
  } catch (err) {
    console.warn('Jellio: could not load item for playback', err);
    renderPlaybackError(root, itemId, describeNetworkFailure('this title', err), function () {
      renderPlayer(root, params);
    });
    return undefined;
  }

  let syncPlaylistItemId = null;
  // The watch party layer (components/partyLayer.js), set once the
  // player is built.
  let partyLayer = null;
  let overlayInsets = null;
  const initialSyncTarget = getCurrentPlaylistTarget();
  let startTicks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
  if (initialSyncTarget && sameSyncId(initialSyncTarget.itemId, itemId)) {
    syncPlaylistItemId = initialSyncTarget.playlistItemId;
    startTicks = initialSyncTarget.startPositionTicks || 0;
  }

  const isInitialGroupCatchUp = !!(getCurrentGroup() && syncPlaylistItemId && initialSyncTarget.isPlaying);
  let joinSyncActive = false;
  let joinSyncGroupId = null;
  if (isInitialGroupCatchUp) {
    joinSyncActive = true;
    joinSyncGroupId = getCurrentGroup().GroupId;
    notifyBuffering(startTicks, false, syncPlaylistItemId).catch(function () {});
    startJoinSync(joinSyncGroupId, syncPlaylistItemId).catch(function () {});
  }

  const isEpisodeItem = item.Type === 'Episode' && !!item.SeriesName;
  setTitle((isEpisodeItem ? item.SeriesName : item.Name) + ' - Jellio');

  function seriesAwareArtworkUrl(maxWidth) {
    const artId = isEpisodeItem && item.SeriesId ? item.SeriesId : itemId;
    const backdropTag = isEpisodeItem
      ? item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]
      : item.BackdropImageTags && item.BackdropImageTags[0];
    const primaryTag = isEpisodeItem ? item.SeriesPrimaryImageTag : item.ImageTags && item.ImageTags.Primary;
    const tag = backdropTag || primaryTag;
    if (!tag) return null;
    return getImageUrl(artId, backdropTag ? 'Backdrop' : 'Primary', { tag: tag, maxWidth: maxWidth });
  }

  function seriesAwareLogoUrl(maxWidth) {
    const artId = isEpisodeItem && item.SeriesId ? item.SeriesId : itemId;
    const tag = isEpisodeItem ? item.ParentLogoImageTag : item.ImageTags && item.ImageTags.Logo;
    if (!tag) return null;
    return getImageUrl(artId, 'Logo', { tag: tag, maxWidth: maxWidth });
  }

  const posterUrl = seriesAwareArtworkUrl(1600);

  function fullscreenArtCss() {
    const backdropId = isEpisodeItem ? item.ParentBackdropItemId || item.SeriesId : null;
    const layers = [];
    if (backdropId) layers.push('url(' + getImageUrl(backdropId, 'Backdrop', { maxWidth: 1920 }) + ')');
    if (posterUrl) layers.push('url(' + posterUrl + ')');
    return layers.join(', ');
  }
  const logoUrl = seriesAwareLogoUrl(800);

  root.textContent = '';
  if (posterUrl) {
    const preBackdrop = el('div', 'jellio-player-loading-backdrop');
    preBackdrop.style.backgroundImage = fullscreenArtCss();
    root.appendChild(preBackdrop);
  }
  if (logoUrl) {
    const preLogo = el('div', 'jellio-player-loading-logo');
    preLogo.style.backgroundImage = 'url(' + logoUrl + ')';
    root.appendChild(preLogo);
  }

  const preferredMediaSourceId = params.get('mediaSourceId') || undefined;
  const failoverTried = (params.get('tried') || '').split(',').filter(Boolean);

  if (preferredMediaSourceId && !failoverTried.length) {
    unmarkBadSource(itemId, { Id: preferredMediaSourceId });
  }

  let failoverOverlay = null;
  if (failoverTried.length) {
    failoverOverlay = el('div', 'jellio-player-failover');
    const box = el('div', 'jellio-player-failover-box');
    box.appendChild(el('div', 'jellio-player-failover-spinner'));
    box.appendChild(el('div', 'jellio-player-failover-title', t('player_stream_error')));
    box.appendChild(
      el('div', 'jellio-player-failover-text', 'Trying the next one (attempt ' + (failoverTried.length + 1) + ')…'),
    );
    const stop = el('button', 'jellio-player-failover-stop', t('action_stop'));
    stop.type = 'button';
    stop.addEventListener('click', function () {
      screenTornDown = true;
      if (failoverOverlay) {
        failoverOverlay.remove();
        failoverOverlay = null;
      }
      navigateTo('#/item?id=' + itemId);
    });
    box.appendChild(stop);
    failoverOverlay.appendChild(box);
    root.appendChild(failoverOverlay);
  }

  let playbackInfo;
  try {
    playbackInfo = await getPlaybackInfo(itemId, startTicks, preferredMediaSourceId);
  } catch (err) {
    if (screenTornDown) return undefined;
    console.warn('Jellio: could not negotiate playback', err);
    const isTimeoutOrAbort = err && (err.name === 'AbortError' || /timeout/i.test(err.message || ''));
    if (!getCurrentGroup() && !isTimeoutOrAbort && preferredMediaSourceId) {
      markBadSource(itemId, { Id: preferredMediaSourceId });
      const tried = failoverTried.concat([preferredMediaSourceId]);
      let sources = [];
      try {
        sources = await getMediaSources(itemId, { forceFresh: true });
      } catch (e) {}
      if (screenTornDown) return undefined;
      let language = params.get('lang') || '';
      if (!language) {
        let audioPreference = '';
        try {
          const user = await currentUserPromise;
          audioPreference = (user && user.Configuration && user.Configuration.AudioLanguagePreference) || '';
        } catch (e) {}
        language = preferredStreamLanguage(audioPreference, getDisplayLanguage());
      }
      const candidates = orderByLanguage(
        sources.filter(function (s) {
          return tried.indexOf(s.Id) === -1 && !isBadSource(itemId, s);
        }),
        language,
        sourceAudioLanguages,
      );
      if (candidates.length > 0) {
        navigateTo(
          playHash(itemId, candidates[0].Id) +
            '&tried=' + encodeURIComponent(tried.join(',')) +
            (language ? '&lang=' + encodeURIComponent(language) : ''),
        );
        return undefined;
      }
    }
    renderPlaybackError(root, itemId, describeNetworkFailure('the stream', err), function () {
      renderPlayer(root, params);
    });
    return undefined;
  }
  if (screenTornDown) return undefined;

  function pickNegotiatedSource(info, wantedId) {
    const list = (info && info.MediaSources) || [];
    if (wantedId) {
      const match = list.find(function (s) {
        return s && s.Id === wantedId;
      });
      if (match) return match;
    }
    return list[0] || null;
  }

  const playbackSources = (playbackInfo && playbackInfo.MediaSources) || [];
  let mediaSource = pickNegotiatedSource(playbackInfo, preferredMediaSourceId);
  let playSessionId = playbackInfo && playbackInfo.PlaySessionId;
  if (!mediaSource || (!preferredMediaSourceId && playbackSources.length === 1 && isPlaceholderSource(mediaSource))) {
    console.warn('Jellio: no playable media source for', itemId);
    renderPlaybackError(
      root,
      itemId,
      preferredMediaSourceId
        ? 'That stream is no longer available. Pick a different one.'
        : 'No playable stream was found for this title.',
      function () {
        renderPlayer(root, params);
      },
    );
    return undefined;
  }

  try {
    await loadVideoTranscodePolicy();
  } catch (err) {}
  const sourceClassification = classifySource(mediaSource, canBrowserDirectPlay(mediaSource) && !(startTicks > 0));
  logPlaybackDecision(itemId, mediaSource, sourceClassification, getVideoTranscodePolicy());
  if (avoidingVideoTranscodes() && sourceClassification.needsVideoTranscode && !params.get('tried')) {
    const alternatives = await getMediaSources(itemId).catch(function () {
      return [];
    });
    if (screenTornDown) return undefined;
    const others = alternatives.filter(function (source) {
      return source.Id !== mediaSource.Id && !isBadSource(itemId, source) && !classifySource(source, canBrowserDirectPlay(source)).needsVideoTranscode;
    });
    // One known to copy (probed, or by its name) before one nothing is known about.
    const copyable =
      others.find(function (source) {
        return !!videoInfoOf(source);
      }) || others[0];
    // In Avoid a stream the reader picked by hand is played as picked.
    if (copyable && (!preferredMediaSourceId || getVideoTranscodePolicy() === 'Block')) {
      navigateTo(playHash(itemId, copyable.Id));
      return undefined;
    }
    if (getVideoTranscodePolicy() === 'Block') {
      renderPlaybackError(
        root,
        itemId,
        'This needs the server to re-encode the video (' +
          sourceClassification.reasons.map(describeTranscodeReason).join(', ') +
          '), which is turned off on this server, and no other stream for it can be played as is.',
      );
      return undefined;
    }
  }

  let currentAudioStreamIndex = null;
  try {
    const user = await currentUserPromise;
    const preferredLanguage = user && user.Configuration && user.Configuration.AudioLanguagePreference;
    const matchedIndex = preferredLanguage ? matchAudioStreamIndex(mediaSource, preferredLanguage) : null;
    if (matchedIndex != null && getAudioStreams(mediaSource).length > 1) {
      const rematched = await getPlaybackInfo(itemId, startTicks, mediaSource.Id, matchedIndex);
      const rematchedSource = pickNegotiatedSource(rematched, mediaSource.Id);
      if (rematchedSource) {
        mediaSource = rematchedSource;
        playSessionId = rematched.PlaySessionId;
        currentAudioStreamIndex = matchedIndex;
      }
    }
  } catch (err) {
    console.warn('Jellio: could not match preferred audio language', err);
  }
  if (screenTornDown) return undefined;

  root.textContent = '';
  if (failoverOverlay) {
    root.appendChild(failoverOverlay);
  }

  const forcedTranscode = startTicks > 0 || currentAudioStreamIndex != null;
  const streamUrl = buildStreamUrl(itemId, mediaSource, startTicks, {
    audioStreamIndex: currentAudioStreamIndex,
    forceTranscode: forcedTranscode,
    playSessionId: playSessionId,
  });

  let streamIsTranscoded = forcedTranscode || !canBrowserDirectPlay(mediaSource);
  const initialUsesHls = willUseHls(mediaSource, forcedTranscode);
  let needsStartOffset = streamIsTranscoded && !initialUsesHls;
  let streamOffsetTicks = needsStartOffset ? startTicks : 0;
  let pendingNativeSeekSeconds = startTicks > 0 && !needsStartOffset ? startTicks / TICKS_PER_SECOND : null;
  let durationSeconds = (mediaSource.RunTimeTicks || item.RunTimeTicks || 0) / TICKS_PER_SECOND;
  let fallbackDurationSeconds = durationSeconds;
  let videoDurationGrowing = false;
  let videoDurationStrikes = 0;
  let lastVideoDuration = 0;
  function videoDurationIsFinal() {
    return !videoDurationGrowing && (!streamIsTranscoded || supportsNativeHls());
  }
  function paintDuration() {
    durationLabel.textContent = durationSeconds ? formatTime(durationSeconds) : '--:--';
  }

  if (params.get('fromStart') === '1') startTicks = 0;
  // A buffering switch carries the position over and plays straight on.
  let lastUserSeekAt = 0;
  const reloadedAtTicks = Number(params.get('at')) || 0;
  if (reloadedAtTicks > 0 && !syncPlaylistItemId) startTicks = reloadedAtTicks;
  const hasResumePosition = startTicks > 0 && !syncPlaylistItemId && !reloadedAtTicks;

  const video = document.createElement('video');
  video.className = 'jellio-player-video';
  // Ask the browser to keep loading ahead, paused included.
  video.preload = 'auto';
  // Set by the stall wait (Pre-buffer More/Maximum): playback is held, not
  // paused by the reader, so no pause screen.
  let stallHold = false;
  video.src = streamUrl;
  video.playsInline = true;
  video.preservesPitch = true;
  video.webkitPreservesPitch = true;
  video.mozPreservesPitch = true;
  video.setAttribute('x-webkit-airplay', 'allow');
  video.setAttribute('airplay', 'allow');
  if (video.remote && typeof video.remote.watchAvailability === 'function') {
    video.remote.watchAvailability(function () {}).catch(function () {});
  }
  initGoogleCast().catch(function () {});
  const savedVolume = loadVolumePreference();
  video.volume = savedVolume.volume;
  video.muted = savedVolume.muted;
  if (posterUrl) video.poster = posterUrl;

  let loadingBackdrop = null;
  let loadingLogo = null;
  let logoWatchdog = null;
  let logoLastTime = 0;
  let logoLastFrames = 0;
  let logoShownAt = 0;

  function logoSeesPlayback() {
    if ((!loadingLogo && !loadingBackdrop) || video.paused || video.ended || video.seeking || video.readyState < 3) {
      logoLastTime = video.currentTime;
      return false;
    }
    const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
    if (quality) {
      if (quality.totalVideoFrames < logoLastFrames) logoLastFrames = quality.totalVideoFrames;
      else if (quality.totalVideoFrames - logoLastFrames >= 3) return true;
    }
    const delta = video.currentTime - logoLastTime;
    logoLastTime = video.currentTime;
    return delta > 0.05 && delta < 2;
  }

  function showLoadingLogo() {
    if (loadingBackdrop) {
      loadingBackdrop.remove();
      loadingBackdrop = null;
    }
    if (posterUrl && video.readyState < 3) {
      loadingBackdrop = el('div', 'jellio-player-loading-backdrop');
      loadingBackdrop.style.backgroundImage = 'url(' + posterUrl + ')';
      if (video.parentNode === root && video.nextSibling) {
        root.insertBefore(loadingBackdrop, video.nextSibling);
      } else {
        root.appendChild(loadingBackdrop);
      }
    }
    if (loadingLogo) {
      loadingLogo.remove();
      loadingLogo = null;
    }
    if (logoUrl) {
      loadingLogo = el('div', 'jellio-player-loading-logo');
      loadingLogo.style.backgroundImage = 'url(' + logoUrl + ')';
      const anchor = loadingBackdrop || video;
      if (anchor.parentNode === root && anchor.nextSibling) {
        root.insertBefore(loadingLogo, anchor.nextSibling);
      } else {
        root.appendChild(loadingLogo);
      }
    }
    if (!loadingLogo && !loadingBackdrop) return;
    logoLastTime = video.currentTime;
    logoLastFrames = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
    logoShownAt = Date.now();
    if (typeof video.requestVideoFrameCallback === 'function') {
      const shown = loadingLogo || loadingBackdrop;
      let frames = 0;
      const onFrame = function () {
        if ((loadingLogo || loadingBackdrop) !== shown) return;
        if (!video.paused && video.readyState >= 3 && ++frames >= 3) {
          hideLoadingLogo();
          return;
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    window.clearInterval(logoWatchdog);
    logoWatchdog = window.setInterval(function () {
      if (!loadingLogo && !loadingBackdrop) {
        window.clearInterval(logoWatchdog);
        return;
      }
      if (logoSeesPlayback()) hideLoadingLogo();
    }, 400);
  }

  // Screen Wake Lock API: keeps the display awake during active video playback.
  let wakeLock = null;
  function holdAwake(on) {
    if (!on) {
      if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
      }
      return;
    }
    if (wakeLock || !navigator.wakeLock) return;
    navigator.wakeLock
      .request('screen')
      .then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () {
          if (wakeLock === lock) wakeLock = null;
        });
      })
      .catch(function () {});
  }
  function onWakeVisibility() {
    if (document.visibilityState === 'visible' && !video.paused && !video.ended) {
      holdAwake(true);
    }
  }
  document.addEventListener('visibilitychange', onWakeVisibility);

  function notifyNativePlayback(active) {
    if (window.jellioNative && typeof window.jellioNative.setPlaybackState === 'function') {
      try {
        window.jellioNative.setPlaybackState(active);
      } catch (err) {}
    }
  }

  // Other tabs refresh their home rows one at a time while this plays.
  video.addEventListener('playing', function () {
    setPlaybackActive(true);
    holdAwake(true);
    notifyNativePlayback(true);
  });
  ['pause', 'ended', 'emptied'].forEach(function (type) {
    video.addEventListener(type, function () {
      setPlaybackActive(false);
      holdAwake(false);
      notifyNativePlayback(false);
    });
  });
  ['timeupdate', 'seeked', 'canplay'].forEach(function (type) {
    video.addEventListener(type, function () {
      if (logoSeesPlayback()) hideLoadingLogo();
    });
  });

  function hideLoadingLogo() {
    window.clearInterval(logoWatchdog);
    if (loadingBackdrop) {
      loadingBackdrop.remove();
      loadingBackdrop = null;
    }
    if (loadingLogo) {
      loadingLogo.remove();
      loadingLogo = null;
    }
  }

  let subtitleStyle = loadSubtitleStyle();
  applySubtitleStyle(video, subtitleStyle);

  const shell = el('div', 'jellio-player-shell');

  const topbar = el('div', 'jellio-player-topbar');
  const topbarInfo = el('div', 'jellio-player-topbar-info');
  topbarInfo.appendChild(el('div', 'jellio-player-topbar-title', isEpisodeItem ? item.SeriesName : item.Name || ''));
  if (isEpisodeItem) {
    const hasCode = typeof item.ParentIndexNumber === 'number' && typeof item.IndexNumber === 'number';
    const code = hasCode ? 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber : '';
    topbarInfo.appendChild(
      el('div', 'jellio-player-topbar-episode', code ? code + ' · ' + (item.Name || '') : item.Name || ''),
    );
  }
  const topbarMeta = el('div', 'jellio-player-topbar-meta', sourceLabel(mediaSource));
  topbarInfo.appendChild(topbarMeta);
  topbar.appendChild(topbarInfo);

  const backButton = el('button', 'jellio-player-back');
  backButton.type = 'button';
  backButton.setAttribute('aria-label', t('onboarding_back'));
  const backIcon = el('span', 'material-icons arrow_back');
  backIcon.setAttribute('aria-hidden', 'true');
  backButton.appendChild(backIcon);
  backButton.addEventListener('click', function () {
    navigateTo('#/item?id=' + itemId);
  });
  const topbarActions = el('div', 'jellio-player-topbar-actions');

  let openShortcutsModal = function () {};
  let closeShortcutsModal = function () {};
  let toggleShortcutsModal = function () {};
  let toggleCastMenu = function () {};
  let syncMediaSession = function () {};
  let syncMediaPosition = function () {};

  let pip = null;
  if (document.pictureInPictureEnabled) {
    pip = attachPictureInPicture({
      video: video,
      root: root,
      onReturn: function () {
        checkForFrozenPicture();
      },
      // The browser will not let go of this video element: carry on in a
      // fresh player at the same spot.
      onStuck: function () {
        if (screenTornDown) return;
        navigateTo(
          playHash(itemId, mediaSource && mediaSource.Id) +
            (failoverTried.length ? '&tried=' + encodeURIComponent(failoverTried.join(',')) : '') +
            '&at=' + currentPositionTicks() +
            '&r=' + Date.now(),
        );
      },
    });
    topbarActions.appendChild(pip.button);
  }

  let frozenCheck = null;
  function checkForFrozenPicture() {
    window.clearTimeout(frozenCheck);
    if (video.paused || video.ended || document.pictureInPictureElement === video || typeof video.getVideoPlaybackQuality !== 'function') return;
    const before = video.getVideoPlaybackQuality().totalVideoFrames;
    const timeBefore = video.currentTime;
    frozenCheck = window.setTimeout(function () {
      if (video.paused || video.seeking || video.currentTime - timeBefore < 0.5) return;
      const drawn = video.getVideoPlaybackQuality().totalVideoFrames - before;
      if (drawn >= 5) return;
      // The clock is running but no frames are drawn: make the browser
      // repaint the video, then reload at this spot if that was not enough.
      video.style.visibility = 'hidden';
      void video.offsetHeight;
      video.style.visibility = '';
      const framesNow = video.getVideoPlaybackQuality().totalVideoFrames;
      frozenCheck = window.setTimeout(function () {
        if (video.paused || video.getVideoPlaybackQuality().totalVideoFrames - framesNow >= 5) return;
        seekToAbsoluteSeconds(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0));
      }, 900);
    }, 900);
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', function () {
        if (pip) pip.enterForTabLeave();
      });
      if (pip) pip.markBrowserOpensOnLeave();
    } catch (err) {
      // Not every browser knows this action.
    }
  }
  document.addEventListener('visibilitychange', onTabVisibility);
  function onTabVisibility() {
    if (document.visibilityState === 'visible') checkForFrozenPicture();
  }

  let exitFullscreenOnCleanup = function () {};
  let fullscreenButton = null;
  const fullscreenEnabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  if (fullscreenEnabled) {
    fullscreenButton = el('button', 'jellio-player-back jellio-player-fullscreen');
    fullscreenButton.type = 'button';
    fullscreenButton.setAttribute('aria-label', t('player_fullscreen'));
    const fullscreenIcon = el('span', 'material-icons fullscreen');
    fullscreenIcon.setAttribute('aria-hidden', 'true');
    fullscreenButton.appendChild(fullscreenIcon);

    function isFullscreen() {
      return (document.fullscreenElement || document.webkitFullscreenElement) === root;
    }
    function updateFullscreenButton() {
      const active = isFullscreen();
      fullscreenIcon.className = 'material-icons ' + (active ? 'fullscreen_exit' : 'fullscreen');
      fullscreenButton.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
    }

    fullscreenButton.addEventListener('click', function () {
      wakeControls();
      if (isFullscreen()) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (root.requestFullscreen) {
        root.requestFullscreen().catch(function () {});
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
    exitFullscreenOnCleanup = function () {
      document.removeEventListener('fullscreenchange', updateFullscreenButton);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenButton);
      if (isFullscreen()) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    };
    topbarActions.appendChild(fullscreenButton);
  }

  const CHAT_POLL_MS = 3000;
  let stopChatOnCleanup = function () {};
  let closeChatPanel = function () {};
  const currentSyncGroup = getCurrentGroup();
  if (currentSyncGroup) {
    const chatToggleButton = el('button', 'jellio-player-back jellio-player-chat-toggle');
    chatToggleButton.type = 'button';
    chatToggleButton.setAttribute('aria-label', t('gw_chat_title'));
    chatToggleButton.setAttribute('aria-expanded', 'false');
    const chatToggleIcon = el('span', 'material-icons chat_bubble_outline');
    chatToggleIcon.setAttribute('aria-hidden', 'true');
    chatToggleButton.appendChild(chatToggleIcon);
    topbarActions.appendChild(chatToggleButton);

    const chatPanel = el('div', 'jellio-player-chat-panel');
    const chatMessages = el('div', 'jellio-player-chat-messages');
    const chatRankingContainer = el('div', 'jellio-pick-container');
    const chatInputRow = el('div', 'jellio-player-chat-input-row');
    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.className = 'jellio-player-chat-input';
    chatInput.placeholder = t('gw_message_placeholder');
    chatInput.maxLength = 500;
    const chatSendButton = el('button', 'jellio-player-chat-send');
    chatSendButton.type = 'button';
    chatSendButton.setAttribute('aria-label', t('action_send'));
    const chatSendIcon = el('span', 'material-icons send');
    chatSendIcon.setAttribute('aria-hidden', 'true');
    chatSendButton.appendChild(chatSendIcon);
    chatInputRow.appendChild(chatInput);
    chatInputRow.appendChild(chatSendButton);
    chatPanel.appendChild(chatMessages);
    chatPanel.appendChild(chatRankingContainer);
    chatPanel.appendChild(chatInputRow);
    root.appendChild(chatPanel);

    let chatLastMessageId = 0;
    let chatPollTimer = null;
    let chatOpen = false;

    const MAX_CHAT_DOM_MESSAGES = 200;

    function appendChatMessages(messages) {
      messages.forEach(function (message) {
        const row = el('div', 'jellio-player-chat-message');
        if (message.ItemId) {
          row.classList.add('jellio-player-chat-message-watch-card');
          row.setAttribute('role', 'button');
          row.setAttribute('tabindex', '0');
          row.addEventListener('click', function () {
            navigateTo('#/play?id=' + message.ItemId + '&groupJoin=1');
          });
        }
        row.appendChild(el('span', 'jellio-player-chat-message-author', (message.UserName || 'Someone') + ':'));
        row.appendChild(el('span', 'jellio-player-chat-message-text', message.Text));
        if (message.ItemId) row.appendChild(el('span', 'jellio-player-chat-message-cta', t('gw_click_to_join')));
        chatMessages.appendChild(row);
        chatLastMessageId = Math.max(chatLastMessageId, message.Id);
      });
      while (chatMessages.children.length > MAX_CHAT_DOM_MESSAGES) {
        chatMessages.removeChild(chatMessages.firstChild);
      }
      if (messages.length) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function onVote(itemId) {
      voteRankingSession(currentSyncGroup.GroupId, itemId)
        .then(function (updated) {
          renderRankingSession(chatRankingContainer, updated, getSyncUserId(), onVote);
        })
        .catch(function (err) {
          console.warn('Jellio: could not cast a Group Watch pick vote', err);
        });
    }

    function pollRanking() {
      if (!isGrouplistEnabled()) return;
      fetchRankingSession(currentSyncGroup.GroupId).then(function (session) {
        renderRankingSession(chatRankingContainer, session, getSyncUserId(), onVote);
      });
    }

    function pollChat() {
      getGroupWatchMessages(currentSyncGroup.GroupId, chatLastMessageId)
        .then(function (messages) {
          if (messages.length) appendChatMessages(messages);
        })
        .catch(function () {
        });
      pollRanking();
    }

    function sendChatMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      sendGroupWatchMessage(currentSyncGroup.GroupId, text)
        .then(function (message) {
          if (message) appendChatMessages([message]);
        })
        .catch(function (err) {
          console.warn('Jellio: could not send Group Watch message', err);
        });
    }

    chatSendButton.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') sendChatMessage();
    });
    chatInput.addEventListener('focus', wakeControls);

    chatToggleButton.addEventListener('click', function () {
      chatOpen = !chatOpen;
      if (partyLayer) partyLayer.setChatPanelOpen(chatOpen);
      chatPanel.classList.toggle('jellio-player-chat-panel-visible', chatOpen);
      chatToggleButton.setAttribute('aria-expanded', String(chatOpen));
      if (chatOpen) {
        pollChat();
        chatPollTimer = window.setInterval(pollChat, CHAT_POLL_MS);
        wakeControls();
      } else if (chatPollTimer) {
        window.clearInterval(chatPollTimer);
        chatPollTimer = null;
        stopRankingCountdown(chatRankingContainer);
      }
    });

    closeChatPanel = function () {
      if (chatOpen) chatToggleButton.click();
    };

    stopChatOnCleanup = function () {
      if (chatPollTimer) window.clearInterval(chatPollTimer);
      stopRankingCountdown(chatRankingContainer);
    };
  }

  topbarActions.appendChild(backButton);
  topbar.appendChild(topbarActions);

  // === Center transport: skip back 10s, play/pause, skip forward 10s ===
  const centerControls = el('div', 'jellio-player-center-controls');

  const skipBackButton = el('button', 'jellio-player-transport');
  skipBackButton.type = 'button';
  skipBackButton.setAttribute('aria-label', t('player_back_10s'));
  const skipBackIcon = el('span', 'material-icons replay_10');
  skipBackIcon.setAttribute('aria-hidden', 'true');
  skipBackButton.appendChild(skipBackIcon);

  const playPauseButton = el('button', 'jellio-player-transport jellio-player-playpause-center');
  playPauseButton.type = 'button';
  playPauseButton.setAttribute('aria-label', t('action_pause'));
  const playPauseIcon = el('span', 'material-icons pause');
  playPauseIcon.setAttribute('aria-hidden', 'true');
  playPauseButton.appendChild(playPauseIcon);
  playPauseButton.addEventListener('click', function () {
    if (getActiveCast()) {
      sendRemotePlayPause(getActiveCast().isPaused).catch(function (err) {
        console.warn('Jellio: could not send Cast play/pause', err);
      });
      return;
    }
    if (syncPlaylistItemId) {
      // Host-only party: ask the host instead.
      if (partyLayer && partyLayer.shouldAsk()) {
        partyLayer.ask(video.paused ? 'play' : 'pause');
        return;
      }
      (video.paused ? requestSyncUnpause : requestSyncPause)().catch(function (err) {
        console.warn('Jellio: could not send Group Watch play/pause', err);
      });
      return;
    }
    if (video.paused) attemptPlay();
    else video.pause();
  });

  const skipForwardButton = el('button', 'jellio-player-transport');
  skipForwardButton.type = 'button';
  skipForwardButton.setAttribute('aria-label', t('player_forward_10s'));
  const skipForwardIcon = el('span', 'material-icons forward_10');
  skipForwardIcon.setAttribute('aria-hidden', 'true');
  skipForwardButton.appendChild(skipForwardIcon);

  centerControls.appendChild(skipBackButton);
  centerControls.appendChild(playPauseButton);
  centerControls.appendChild(skipForwardButton);

  // === Full width seek bar ===
  const seekRow = el('div', 'jellio-player-seek-row');
  const currentTimeLabel = el('span', 'jellio-player-time', formatTime(startTicks / TICKS_PER_SECOND));
  const seekWrap = el('div', 'jellio-player-seek-wrap');
  const seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.className = 'jellio-player-seek';
  seekBar.min = '0';
  seekBar.max = '100';
  seekBar.value = '0';
  seekBar.setAttribute('aria-label', t('player_seek'));
  const durationLabel = el('span', 'jellio-player-time', durationSeconds ? formatTime(durationSeconds) : '--:--');
  seekWrap.appendChild(seekBar);
  seekRow.appendChild(currentTimeLabel);
  seekRow.appendChild(seekWrap);
  seekRow.appendChild(durationLabel);

  // === Floating pill: Speed, Subtitles, Audio, Sources, Episodes, Sleep ===
  const pill = el('div', 'jellio-player-pill');

  function buildPillButton(iconName, label) {
    const button = el('button', 'jellio-player-pill-btn');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const icon = el('span', 'material-icons ' + iconName);
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.appendChild(el('span', 'jellio-player-pill-btn-label', label));
    return button;
  }

  const volumeButton = buildPillButton('volume_up', 'Volume');
  volumeButton.classList.add('jellio-player-pill-volume');
  const speedButton = buildPillButton('speed', '1x');
  speedButton.classList.add('jellio-player-pill-speed');
  const subtitleButton = buildPillButton('subtitles', 'Subtitles');
  subtitleButton.classList.add('jellio-player-pill-subtitles');
  const audioButton = buildPillButton('graphic_eq', 'Audio');
  audioButton.classList.add('jellio-player-pill-audio');
  const sourceButton = buildPillButton('swap_horiz', 'Sources');
  sourceButton.classList.add('jellio-player-pill-sources');
  sourceButton.disabled = true;
  const episodesButton = buildPillButton('video_library', 'Episodes');
  episodesButton.classList.add('jellio-player-pill-episodes');
  episodesButton.disabled = true;
  const sleepButton = buildPillButton('bedtime', 'Sleep');
  sleepButton.classList.add('jellio-player-pill-sleep');
  const castButton = buildPillButton('cast', 'Cast');
  castButton.classList.add('jellio-player-pill-cast');
  const settingsButton = buildPillButton('settings', 'Settings');
  settingsButton.classList.add('jellio-player-pill-settings');

  pill.appendChild(volumeButton);
  pill.appendChild(speedButton);
  pill.appendChild(subtitleButton);
  pill.appendChild(audioButton);
  pill.appendChild(sourceButton);
  pill.appendChild(episodesButton);
  pill.appendChild(sleepButton);
  pill.appendChild(castButton);
  pill.appendChild(settingsButton);

  const popovers = [];
  function closePopovers(except) {
    popovers.forEach(function (entry) {
      if (entry.menu === except) return;
      entry.menu.classList.add('jellio-player-popover-hidden');
      entry.button.setAttribute('aria-expanded', 'false');
    });
  }
  function positionPopover(button, menu) {
    const shellRect = shell.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const margin = 16;
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.right = 'auto';
    const menuWidth = menu.offsetWidth;
    const center = buttonRect.left - shellRect.left + buttonRect.width / 2;
    const maxLeft = Math.max(margin, shellRect.width - menuWidth - margin);
    const left = Math.min(Math.max(center - menuWidth / 2, margin), maxLeft);
    menu.style.left = left + 'px';
  }
  function registerPopover(button, menu) {
    popovers.push({ button: button, menu: menu });
    button.addEventListener('click', function () {
      closePopovers(menu);
      const nowHidden = menu.classList.toggle('jellio-player-popover-hidden');
      button.setAttribute('aria-expanded', String(!nowHidden));
      if (!nowHidden) positionPopover(button, menu);
      wakeControls();
    });
  }

  const volumeMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden jellio-player-popover-volume');
  const volumeMuteButton = el('button', 'jellio-player-popover-volume-mute');
  volumeMuteButton.type = 'button';
  volumeMuteButton.setAttribute('aria-label', t('player_mute'));
  const volumeMuteIcon = el('span', 'material-icons volume_up');
  volumeMuteIcon.setAttribute('aria-hidden', 'true');
  volumeMuteButton.appendChild(volumeMuteIcon);
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'jellio-player-popover-volume-slider';
  volumeSlider.min = '0';
  volumeSlider.max = '100';
  volumeSlider.setAttribute('aria-label', t('player_volume'));
  const volumeLevelLabel = el('span', 'jellio-player-popover-volume-level', '100%');
  volumeMenu.appendChild(volumeMuteButton);
  volumeMenu.appendChild(volumeSlider);
  volumeMenu.appendChild(volumeLevelLabel);

  function syncVolumeUI() {
    const pct = Math.round(video.volume * 100);
    const effectivelyMuted = video.muted || video.volume === 0;
    volumeSlider.value = String(pct);
    volumeLevelLabel.textContent = effectivelyMuted ? 'Muted' : pct + '%';
    const iconName = effectivelyMuted ? 'volume_off' : pct < 50 ? 'volume_down' : 'volume_up';
    volumeMuteIcon.className = 'material-icons ' + iconName;
    volumeMuteButton.setAttribute('aria-label', effectivelyMuted ? 'Unmute' : 'Mute');
    const pillIcon = volumeButton.querySelector('.material-icons');
    if (pillIcon) pillIcon.className = 'material-icons ' + iconName;
    saveVolumePreference(video.volume, video.muted);
  }
  syncVolumeUI();

  volumeSlider.addEventListener('input', function () {
    video.volume = Number(volumeSlider.value) / 100;
    video.muted = false;
    syncVolumeUI();
  });
  volumeMuteButton.addEventListener('click', function () {
    video.muted = !video.muted;
    syncVolumeUI();
  });
  registerPopover(volumeButton, volumeMenu);

  // === Speed popover ===
  const savedSpeed = parseFloat(window.localStorage.getItem('jellioPlayerSpeed')) || 1;
  const speedMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');

  function applyPlaybackSpeed(speed) {
    video.playbackRate = speed;
    try {
      window.localStorage.setItem('jellioPlayerSpeed', String(speed));
    } catch (err) {}
    const label = speedButton.querySelector('.jellio-player-pill-btn-label');
    if (label) label.textContent = speed + 'x';
    Array.prototype.forEach.call(speedMenu.children, function (child) {
      child.classList.toggle('jellio-player-popover-option-active', child.textContent === speed + 'x');
    });
    syncMediaPosition();
  }

  function stepPlaybackSpeed(direction) {
    const curSpeed = video.playbackRate || 1;
    let index = PLAYBACK_SPEEDS.indexOf(curSpeed);
    if (index === -1) {
      index = PLAYBACK_SPEEDS.reduce(function (prev, curr, idx) {
        return Math.abs(curr - curSpeed) < Math.abs(PLAYBACK_SPEEDS[prev] - curSpeed) ? idx : prev;
      }, 2);
    }
    const newIndex = Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, index + direction));
    const newSpeed = PLAYBACK_SPEEDS[newIndex];
    if (newSpeed !== curSpeed) {
      applyPlaybackSpeed(newSpeed);
      showPlayerToast(newSpeed + 'x Speed');
    }
  }

  PLAYBACK_SPEEDS.forEach(function (speed) {
    const option = el(
      'button',
      'jellio-player-popover-option' + (speed === savedSpeed ? ' jellio-player-popover-option-active' : ''),
      speed + 'x',
    );
    option.type = 'button';
    option.addEventListener('click', function () {
      applyPlaybackSpeed(speed);
      closePopovers(null);
    });
    speedMenu.appendChild(option);
  });
  if (savedSpeed !== 1) {
    applyPlaybackSpeed(savedSpeed);
  }
  registerPopover(speedButton, speedMenu);

  const subtitleMenu = el('div', 'jellio-player-popover jellio-player-popover-large jellio-player-popover-hidden');
  const subtitleColumns = el('div', 'jellio-player-popover-columns');
  const subtitleLanguageList = el('div', 'jellio-player-popover-list jellio-player-popover-languages');
  const subtitleList = el('div', 'jellio-player-popover-list jellio-player-popover-tracks');
  subtitleColumns.appendChild(subtitleLanguageList);
  subtitleColumns.appendChild(subtitleList);
  subtitleMenu.appendChild(subtitleColumns);
  let activeTrack = null;
  let selectedSubtitleLanguage = null;
  let activeSubtitleStreamIndex = null;

  let reentrant = false;
  function enforceSubtitleTrackModes() {
    if (reentrant) return;
    reentrant = true;
    try {
      for (let i = 0; i < video.textTracks.length; i++) {
        const tt = video.textTracks[i];
        const desired = activeTrack && activeTrack.track === tt ? 'showing' : 'disabled';
        if (tt.mode !== desired) tt.mode = desired;
      }
    } finally {
      reentrant = false;
    }
  }
  video.textTracks.addEventListener('change', enforceSubtitleTrackModes);

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
    const savedOffset = parseFloat(localStorage.getItem(SUB_OFFSET_STORAGE_PREFIX + itemId));
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
    if (activeTrack) {
      if (activeTrack.track) activeTrack.track.mode = 'disabled';
      activeTrack.remove();
      activeTrack = null;
    }
    activeSubtitleStreamIndex = stream ? stream.Index : null;
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
    if (activeSubtitleStreamIndex !== stream.Index) return;
    if (activeTrack) {
      if (activeTrack.track) activeTrack.track.mode = 'disabled';
      activeTrack.remove();
      activeTrack = null;
    }
    showPlayerToast(
      attempt === 0
        ? 'Loading subtitles… this can take a moment for some sources.'
        : 'Still loading subtitles… (attempt ' + (attempt + 1) + ' of ' + MAX_SUBTITLE_LOAD_ATTEMPTS + ')',
    );
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = stream.DisplayTitle || stream.Language || 'Subtitle';
    track.srclang = stream.Language || '';
    track.src = buildSubtitleUrl(itemId, mediaSource.Id, stream);
    track.default = true;
    video.appendChild(track);
    activeTrack = track;
    track.addEventListener('load', function () {
      if (activeTrack !== track) return;
      if (!track.track) return;
      normalizeCuePositions(track.track);
      if (subtitleOffsetSec !== 0) {
        applyCuesOffset(track.track, subtitleOffsetSec);
      }
      track.track.mode = 'showing';
      enforceSubtitleTrackModes();
    });
    track.addEventListener('error', function () {
      if (activeTrack !== track) return;
      if (attempt + 1 < MAX_SUBTITLE_LOAD_ATTEMPTS) {
        window.setTimeout(function () {
          if (activeSubtitleStreamIndex === stream.Index) attachSubtitleTrack(stream, attempt + 1);
        }, SUBTITLE_RETRY_DELAY_MS);
        return;
      }
      showPlayerToast('That subtitle track could not be loaded.');
    });
  }

  async function selectBurnedInSubtitle(stream, optionButton) {
    if (activeTrack) {
      if (activeTrack.track) activeTrack.track.mode = 'disabled';
      activeTrack.remove();
      activeTrack = null;
    }
    Array.prototype.forEach.call(subtitleList.children, function (child) {
      child.classList.remove('jellio-player-popover-option-active');
    });
    if (optionButton) optionButton.classList.add('jellio-player-popover-option-active');
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    try {
      reportPlaybackStopped(itemId, mediaSource.Id, resumeTicks);
      const info = await getPlaybackInfo(itemId, resumeTicks, mediaSource.Id, currentAudioStreamIndex, stream.Index);
      const negotiated = info && info.MediaSources && info.MediaSources[0];
      if (!negotiated) {
        showPlayerToast('That subtitle track is no longer available.');
        return;
      }
      mediaSource = negotiated;
      playSessionId = info.PlaySessionId;
      activeSubtitleStreamIndex = stream.Index;
      streamIsTranscoded = true;
      const subtitleUsesHls = willUseHls(mediaSource, true);
      needsStartOffset = !subtitleUsesHls;
      streamOffsetTicks = needsStartOffset ? resumeTicks : 0;
      pendingNativeSeekSeconds = subtitleUsesHls ? resumeTicks / TICKS_PER_SECOND : null;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        burnInSubtitleStreamIndex: stream.Index,
        forceTranscode: true,
        playSessionId: playSessionId,
      });
      video.load();
      showLoadingLogo();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      subtitleButton.classList.add('jellio-player-pill-btn-active');
      rebuildAudioMenu();
      rebuildSubtitleMenu();
      closePopovers(null);
      showPlayerToast('Requested ' + (stream.DisplayTitle || stream.Language || 'subtitle') + ' (burned in), reloading…');
    } catch (err) {
      console.warn('Jellio: selectBurnedInSubtitle failed', err);
      showPlayerToast('Subtitle switch failed: ' + (err && err.message ? err.message : err));
    }
  }

  function renderSubtitleTrackList(subtitleStreams) {
    subtitleList.textContent = '';
    const offOption = el(
      'button',
      'jellio-player-popover-option' + (activeSubtitleStreamIndex == null ? ' jellio-player-popover-option-active' : ''),
      'Off',
    );
    offOption.type = 'button';
    offOption.addEventListener('click', function () {
      selectSubtitle(null, offOption);
    });
    subtitleList.appendChild(offOption);
    subtitleStreams
      .filter(function (stream) {
        return !selectedSubtitleLanguage || (stream.Language || '').toLowerCase() === selectedSubtitleLanguage;
      })
      .forEach(function (stream) {
        const label =
          (stream.DisplayTitle || stream.Language || 'Subtitle') +
          (stream.IsTextSubtitleStream ? '' : avoidingVideoTranscodes() ? ' (slow: burns into video)' : ' (image)');
        const option = el(
          'button',
          'jellio-player-popover-option' +
            (stream.Index === activeSubtitleStreamIndex ? ' jellio-player-popover-option-active' : ''),
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
    const subtitleStreams = getSubtitleStreams(mediaSource).filter(function (stream) {
      return getVideoTranscodePolicy() !== 'Block' || stream.IsTextSubtitleStream;
    });
    if (!subtitleStreams.length) {
      subtitleButton.disabled = true;
      return;
    }
    subtitleButton.disabled = false;
    selectedSubtitleLanguage = null;

    const noneOption = el('button', 'jellio-player-popover-option jellio-player-popover-option-active', t('vocab_all_languages'));
    noneOption.type = 'button';
    noneOption.addEventListener('click', function () {
      selectedSubtitleLanguage = null;
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
        selectedSubtitleLanguage = code;
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
  let deferredAutoSubtitleStream = null;
  (async function () {
    let matched = null;
    try {
      const user = await currentUserPromise;
      const subtitleMode = user && user.Configuration && user.Configuration.SubtitleMode;
      const preferredLanguage = user && user.Configuration && user.Configuration.SubtitleLanguagePreference;
      const isSubtitlesDisabled = subtitleMode === 'None' || preferredLanguage === 'off' || preferredLanguage === 'none' || !preferredLanguage;
      matched = isSubtitlesDisabled ? null : matchSubtitleStream(mediaSource, preferredLanguage);
    } catch (err) {
      console.warn('Jellio: could not match preferred subtitle language', err);
    }
    if (matched) activeSubtitleStreamIndex = matched.Index;
    rebuildSubtitleMenu();
    if (matched) {
      if (matched.DeliveryMethod === 'External' || hasReportedStart) {
        attachSubtitleTrack(matched, 0);
      } else {
        deferredAutoSubtitleStream = matched;
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
    buildStyleGroup('Size', SUBTITLE_SIZES, subtitleStyle.size, function (value) {
      subtitleStyle = Object.assign({}, subtitleStyle, { size: value });
      applySubtitleStyle(video, subtitleStyle);
      saveSubtitleStyle(subtitleStyle);
    }),
  );
  styleSection.appendChild(
    buildStyleGroup('Background', SUBTITLE_BACKGROUNDS, subtitleStyle.background, function (value) {
      subtitleStyle = Object.assign({}, subtitleStyle, { background: value });
      applySubtitleStyle(video, subtitleStyle);
      saveSubtitleStyle(subtitleStyle);
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
        localStorage.setItem(SUB_OFFSET_STORAGE_PREFIX + itemId, String(subtitleOffsetSec));
      } else {
        localStorage.removeItem(SUB_OFFSET_STORAGE_PREFIX + itemId);
      }
    } catch (e) {}
    syncDisplay.textContent = (subtitleOffsetSec > 0 ? '+' : '') + subtitleOffsetSec.toFixed(1) + 's';
    if (activeTrack && activeTrack.track) {
      applyCuesOffset(activeTrack.track, subtitleOffsetSec);
    }
    showPlayerToast('Subtitle sync: ' + syncDisplay.textContent);
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

  // === Audio track popover ===
  let audioCtx = null;
  let sourceNode = null;
  let compressorNode = null;
  let dialogueBoostEnabled = false;

  function setDialogueBoost(enabled) {
    dialogueBoostEnabled = enabled;
    try {
      if (!audioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          audioCtx = new AudioCtxClass();
          sourceNode = audioCtx.createMediaElementSource(video);
          compressorNode = audioCtx.createDynamicsCompressor();
          compressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime);
          compressorNode.knee.setValueAtTime(30, audioCtx.currentTime);
          compressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);
          compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
          compressorNode.release.setValueAtTime(0.25, audioCtx.currentTime);
        }
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if (sourceNode && compressorNode && audioCtx) {
        sourceNode.disconnect();
        compressorNode.disconnect();
        if (dialogueBoostEnabled) {
          sourceNode.connect(compressorNode);
          compressorNode.connect(audioCtx.destination);
        } else {
          sourceNode.connect(audioCtx.destination);
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
    const streams = getAudioStreams(mediaSource);
    audioButton.disabled = false;
    if (streams.length > 0) {
      streams.forEach(function (stream) {
        const isActive =
          currentAudioStreamIndex == null
            ? stream.Index === mediaSource.DefaultAudioStreamIndex
            : stream.Index === currentAudioStreamIndex;
        const option = el(
          'button',
          'jellio-player-popover-option' + (isActive ? ' jellio-player-popover-option-active' : ''),
          audioStreamLabel(stream),
        );
        option.type = 'button';
        option.addEventListener('click', function () {
          showPlayerToast('Switching to ' + audioStreamLabel(stream) + '…');
          if (isActive && currentAudioStreamIndex != null) {
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
        showPlayerToast('Dialogue Boost enabled (night mode dynamic compression)');
      } else {
        boostOption.classList.remove('jellio-player-popover-option-active');
        showPlayerToast('Dialogue Boost disabled');
      }
    });
    audioMenu.appendChild(boostOption);
  }
  registerPopover(audioButton, audioMenu);

  async function switchAudioTrack(stream) {
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    try {
      reportPlaybackStopped(itemId, mediaSource.Id, resumeTicks);
      const info = await getPlaybackInfo(itemId, resumeTicks, mediaSource.Id, stream.Index);
      const negotiated = pickNegotiatedSource(info, mediaSource.Id);
      if (!negotiated) {
        showPlayerToast('That audio track is no longer available.');
        return;
      }
      mediaSource = negotiated;
      playSessionId = info.PlaySessionId;
      if (activeTrack) {
        activeTrack.remove();
        activeTrack = null;
      }
      currentAudioStreamIndex = stream.Index;
      streamIsTranscoded = true;
      const switchUsesHls = willUseHls(mediaSource, true);
      needsStartOffset = !switchUsesHls;
      streamOffsetTicks = needsStartOffset ? resumeTicks : 0;
      pendingNativeSeekSeconds = switchUsesHls ? resumeTicks / TICKS_PER_SECOND : null;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        forceTranscode: true,
        playSessionId: playSessionId,
      });
      video.load();
      showLoadingLogo();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      rebuildSubtitleMenu();
      rebuildAudioMenu();
      closePopovers(null);
      showPlayerToast('Requested ' + audioStreamLabel(stream) + ', reloading…');
    } catch (err) {
      console.warn('Jellio: switchAudioTrack failed', err);
      showPlayerToast('Audio switch failed: ' + (err && err.message ? err.message : err));
    }
  }
  rebuildAudioMenu();

  let sleepTimerEpisodesRemaining = null;
  let sleepOption = null;
  function syncSleepActive(isActive) {
    sleepButton.classList.toggle('jellio-player-pill-btn-active', Boolean(isActive));
    if (sleepOption) {
      sleepOption.classList.toggle('jellio-player-popover-option-active', Boolean(isActive));
    }
  }
  const sleepMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const cancelOption = el('button', 'jellio-player-popover-option', t('settings_sleep_timer_cancel'));
  cancelOption.type = 'button';
  cancelOption.addEventListener('click', function () {
    sleepTimerEpisodesRemaining = null;
    cancelSleepTimer().then(function () {
      syncSleepActive(false);
      closePopovers(null);
    });
  });
  sleepMenu.appendChild(cancelOption);
  sleepMenu.appendChild(el('div', 'jellio-player-style-group-label', t('player_stop_after')));
  SLEEP_TIMER_OPTIONS.forEach(function (minutes) {
    const option = el('button', 'jellio-player-popover-option', minutes + ' min');
    option.type = 'button';
    option.addEventListener('click', function () {
      sleepTimerEpisodesRemaining = null;
      startSleepTimer(minutes).then(function () {
        syncSleepActive(true);
        closePopovers(null);
      });
    });
    sleepMenu.appendChild(option);
  });
  sleepMenu.appendChild(el('div', 'jellio-player-style-group-label', t('player_or_stop_after')));
  EPISODE_SLEEP_TIMER_OPTIONS.forEach(function (count) {
    const option = el('button', 'jellio-player-popover-option', count + (count === 1 ? ' episode' : ' episodes'));
    option.type = 'button';
    option.addEventListener('click', function () {
      cancelSleepTimer().catch(function () {
        // Nothing was running server side, nothing to react to.
      });
      sleepTimerEpisodesRemaining = count;
      syncSleepActive(true);
      closePopovers(null);
    });
    sleepMenu.appendChild(option);
  });
  registerPopover(sleepButton, sleepMenu);

  getSleepTimerStatus()
    .then(function (status) {
      if (status && status.Active) syncSleepActive(true);
    })
    .catch(function () {
      // No status yet is not an error worth surfacing here.
    });

  // === Cast to Smart TV popover ===
  const castMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden jellio-player-cast-popover');
  const castHeader = el('div', 'jellio-player-cast-header');
  const castTitle = el('div', 'jellio-player-cast-title');
  const castTitleIcon = el('span', 'material-icons cast');
  castTitleIcon.setAttribute('aria-hidden', 'true');
  castTitle.appendChild(castTitleIcon);
  castTitle.appendChild(el('span', null, t('player_cast_to_device')));
  castHeader.appendChild(castTitle);

  const castRefreshBtn = el('button', 'jellio-player-cast-refresh');
  castRefreshBtn.type = 'button';
  castRefreshBtn.setAttribute('aria-label', t('player_refresh_devices'));
  const castRefreshIcon = el('span', 'material-icons refresh');
  castRefreshIcon.setAttribute('aria-hidden', 'true');
  castRefreshBtn.appendChild(castRefreshIcon);
  castHeader.appendChild(castRefreshBtn);
  castMenu.appendChild(castHeader);

  const castBody = el('div', 'jellio-player-cast-body');
  castMenu.appendChild(castBody);

  let isScanningCast = false;
  async function refreshCastMenu() {
    if (isScanningCast) return;
    isScanningCast = true;
    castRefreshBtn.classList.add('spinning');
    castBody.innerHTML = '';

    const currentCast = getActiveCast();
    if (currentCast) {
      const activeBox = el('div', 'jellio-player-cast-active-box');
      const activeRow = el('div', 'jellio-player-cast-active-row');
      const info = el('div', 'jellio-player-cast-device-info');
      info.appendChild(el('div', 'jellio-player-cast-device-name', currentCast.name || 'Connected TV'));
      info.appendChild(el('div', 'jellio-player-cast-device-sub', currentCast.type === 'jellyfin' ? (currentCast.client || 'Jellyfin Client') : 'Wireless Stream'));
      activeRow.appendChild(info);

      const disconnectBtn = el('button', 'jellio-player-cast-disconnect-btn');
      disconnectBtn.type = 'button';
      const disIcon = el('span', 'material-icons cast_connected');
      disIcon.setAttribute('aria-hidden', 'true');
      disconnectBtn.appendChild(disIcon);
      disconnectBtn.appendChild(el('span', null, t('player_disconnect')));
      disconnectBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        const res = await disconnectCast();
        if (res && res.resumePositionTicks != null) {
          seekToAbsoluteSeconds(res.resumePositionTicks / TICKS_PER_SECOND);
          video.play().catch(function () {});
        }
        refreshCastMenu();
      });
      activeRow.appendChild(disconnectBtn);
      activeBox.appendChild(activeRow);
      castBody.appendChild(activeBox);
    }

    const loadingBox = el('div', 'jellio-player-cast-loading');
    const loadingSpinner = el('div', 'jellio-player-cast-loading-spinner');
    const spinIcon = el('span', 'material-icons', 'sync');
    spinIcon.setAttribute('aria-hidden', 'true');
    loadingSpinner.appendChild(spinIcon);
    loadingBox.appendChild(loadingSpinner);

    const loadingText = el('div', 'jellio-player-cast-loading-text');
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-title', t('player_looking_devices')));
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-sub', t('player_scanning_network')));
    loadingBox.appendChild(loadingText);
    castBody.appendChild(loadingBox);

    if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
      positionPopover(castButton, castMenu);
    }

    try {
      const [targets] = await Promise.all([
        getAvailableCastTargets(),
        new Promise(function (resolve) { setTimeout(resolve, 350); }),
      ]);
      loadingBox.remove();

      const tvTargets = targets.filter(function (t) { return t.isTv; });
      const otherTargets = targets.filter(function (t) { return !t.isTv; });

      if (tvTargets.length > 0) {
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', t('player_smart_tvs')));
        tvTargets.forEach(function (target) {
          castBody.appendChild(buildCastDeviceButton(target, 'tv'));
        });
      }

      if (otherTargets.length > 0) {
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', t('player_other_clients')));
        otherTargets.forEach(function (target) {
          castBody.appendChild(buildCastDeviceButton(target, 'devices'));
        });
      }

      const googleCastAvailable = isGoogleCastSupported();
      const airplayAvailable = isAirPlaySupported(video);
      const hasWireless = googleCastAvailable || airplayAvailable;

      if (targets.length === 0) {
        const emptyBox = el('div', 'jellio-player-cast-empty');
        const emptyIconWrap = el('div', 'jellio-player-cast-empty-icon');
        const emptyIcon = el('span', 'material-icons', 'tv_off');
        emptyIcon.setAttribute('aria-hidden', 'true');
        emptyIconWrap.appendChild(emptyIcon);
        emptyBox.appendChild(emptyIconWrap);

        const emptyTitle = el('div', 'jellio-player-cast-empty-title', t('player_no_devices'));
        emptyBox.appendChild(emptyTitle);

        const emptySub = el('div', 'jellio-player-cast-empty-sub', hasWireless
          ? 'No Smart TVs or Jellyfin apps were detected on your local network. You can still stream via the wireless options below.'
          : 'Make sure your Smart TV or Chromecast is turned on and connected to the same Wi-Fi network.');
        emptyBox.appendChild(emptySub);
        castBody.appendChild(emptyBox);
      }

      function useDirectSourceForRemote(url, asHls) {
        const positionSec = (streamOffsetTicks / TICKS_PER_SECOND) + (video.currentTime || 0);
        let next = url;
        if (asHls) {
          next = url.replace('/stream.mp4?', '/master.m3u8?').replace(/&?StartTimeTicks=\d+/, '');
        }
        if (video.currentSrc === next) return;
        streamOffsetTicks = asHls ? 0 : Math.round(positionSec * TICKS_PER_SECOND);
        video.src = next;
        if (asHls) {
          video.addEventListener('loadedmetadata', function () {
            try { video.currentTime = positionSec; } catch (_) {}
          }, { once: true });
        }
        video.load();
        video.play().catch(function () {});
      }

      if (hasWireless) {
        const wirelessTitle = el('div', 'jellio-player-cast-section-title', t('player_wireless_display'));
        castBody.appendChild(wirelessTitle);

        if (googleCastAvailable) {
          const gcastBtn = el('button', 'jellio-player-cast-device-btn');
          gcastBtn.type = 'button';
          const iconWrap = el('div', 'jellio-player-cast-device-icon');
          const icon = el('span', 'material-icons cast');
          icon.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);
          gcastBtn.appendChild(iconWrap);

          const info = el('div', 'jellio-player-cast-device-info');
          info.appendChild(el('div', 'jellio-player-cast-device-name', 'Google Cast / Chromecast'));
          info.appendChild(el('div', 'jellio-player-cast-device-sub', t('player_cast_browser_desc')));
          gcastBtn.appendChild(info);

          gcastBtn.addEventListener('click', async function () {
            try {
              castMenu.classList.add('jellio-player-popover-hidden');
              const currentSec = (streamOffsetTicks / TICKS_PER_SECOND) + (video.currentTime || 0);
              const currentTicks = Math.round(currentSec * TICKS_PER_SECOND);
              const castStreamUrl = buildCastStreamUrl(itemId, mediaSource, currentTicks, {
                audioStreamIndex: currentAudioStreamIndex,
                subtitleStreamIndex: activeSubtitleStreamIndex,
              });

              const preferRemotePlayback = /Android/i.test(navigator.userAgent) &&
                typeof video.remote !== 'undefined' && typeof video.remote.prompt === 'function';
              if (window.cast && window.cast.framework && !preferRemotePlayback) {
                await castToGoogleCast(castStreamUrl, item, currentSec, {
                  mediaSource: mediaSource,
                  startOffsetTicks: currentTicks,
                  posterUrl: getImageUrl(itemId, 'Primary', { maxWidth: 800 }),
                });
                video.pause();
                showPlayerToast('Streaming via Google Cast');
              } else if (typeof video.remote !== 'undefined' && typeof video.remote.prompt === 'function') {
                // A Media Source stream cannot be handed to a cast device, so the
                // picker would list nothing; route a plain stream URL instead.
                useDirectSourceForRemote(castStreamUrl, false);
                await promptRemotePlayback(video);
                showPlayerToast('Streaming via Wireless Display');
              } else {
                await castToGoogleCast(castStreamUrl, item, currentSec, {
                  mediaSource: mediaSource,
                  startOffsetTicks: currentTicks,
                  posterUrl: getImageUrl(itemId, 'Primary', { maxWidth: 800 }),
                });
                video.pause();
                showPlayerToast('Streaming via Google Cast');
              }
            } catch (err) {
              if (
                err &&
                (err.name === 'AbortError' ||
                 err.name === 'NotAllowedError' ||
                 err.name === 'NotFoundError' ||
                 (err.message && (err.message.includes('dismissed') || err.message.includes('cancel') || err.message.includes('not selected'))))
              ) {
                // User simply dismissed or closed the browser's native Cast dialog
                return;
              }
              console.warn('Jellio: Google Cast failed', err);
              showPlayerToast('Cast could not connect: ' + (err && err.message ? err.message : 'no device selected'));
            }
          });
          castBody.appendChild(gcastBtn);
        }

        if (airplayAvailable) {
          const airplayBtn = el('button', 'jellio-player-cast-device-btn');
          airplayBtn.type = 'button';
          const iconWrap = el('div', 'jellio-player-cast-device-icon');
          const icon = el('span', 'material-icons airplay');
          icon.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);
          airplayBtn.appendChild(iconWrap);

          const info = el('div', 'jellio-player-cast-device-info');
          info.appendChild(el('div', 'jellio-player-cast-device-name', t('player_airplay')));
          info.appendChild(el('div', 'jellio-player-cast-device-sub', t('player_airplay_desc')));
          airplayBtn.appendChild(info);

          airplayBtn.addEventListener('click', function () {
            castMenu.classList.add('jellio-player-popover-hidden');
            try {
              useDirectSourceForRemote(buildCastStreamUrl(itemId, mediaSource, 0, {
                audioStreamIndex: currentAudioStreamIndex,
                subtitleStreamIndex: activeSubtitleStreamIndex,
              }), true);
              promptAirPlay(video);
            } catch (err) {
              showPlayerToast('AirPlay not available');
            }
          });
          castBody.appendChild(airplayBtn);
        }
      }
    } catch (err) {
      console.warn('Jellio: error populating cast menu', err);
      loadingBox.remove();
      const errBox = el('div', 'jellio-player-cast-empty');
      const errIconWrap = el('div', 'jellio-player-cast-empty-icon');
      const errIcon = el('span', 'material-icons', 'error_outline');
      errIcon.setAttribute('aria-hidden', 'true');
      errIconWrap.appendChild(errIcon);
      errBox.appendChild(errIconWrap);
      errBox.appendChild(el('div', 'jellio-player-cast-empty-title', t('player_search_devices_error')));
      errBox.appendChild(el('div', 'jellio-player-cast-empty-sub', t('player_check_connection_retry')));
      castBody.appendChild(errBox);
    } finally {
      isScanningCast = false;
      castRefreshBtn.classList.remove('spinning');
      if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
        positionPopover(castButton, castMenu);
      }
    }
  }

  function buildCastDeviceButton(target, defaultIconName) {
    const btn = el('button', 'jellio-player-cast-device-btn');
    btn.type = 'button';

    const iconWrap = el('div', 'jellio-player-cast-device-icon');
    const icon = el('span', 'material-icons ' + defaultIconName);
    icon.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(icon);
    btn.appendChild(iconWrap);

    const info = el('div', 'jellio-player-cast-device-info');
    info.appendChild(el('div', 'jellio-player-cast-device-name', target.name));
    const subText = target.nowPlaying ? ('Playing: ' + target.nowPlaying) : (target.client || 'Ready to stream');
    info.appendChild(el('div', 'jellio-player-cast-device-sub', subText));
    btn.appendChild(info);

    if (target.isTv) {
      btn.appendChild(el('span', 'jellio-player-cast-device-badge', t('player_smart_tv_label')));
    }

    btn.addEventListener('click', async function () {
      try {
        const currentTicks = Math.round((streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0)) * TICKS_PER_SECOND);
        video.pause();
        castMenu.classList.add('jellio-player-popover-hidden');
        showPlayerToast('Streaming to ' + target.name + '...');
        await castToJellyfinSession(target, itemId, currentTicks, mediaSource, currentAudioStreamIndex, activeSubtitleStreamIndex);
        showPlayerToast('Casting on ' + target.name);
      } catch (err) {
        console.warn('Jellio: failed to cast to ' + target.name, err);
        showPlayerToast('Could not cast to ' + target.name);
      }
    });

    return btn;
  }

  registerPopover(castButton, castMenu);
  castButton.addEventListener('click', function () {
    if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
      refreshCastMenu();
    }
  });
  castRefreshBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    refreshCastMenu();
  });

  toggleCastMenu = function () {
    castButton.click();
  };

  // === In-player floating Cast Banner ===
  const castBanner = el('div', 'jellio-player-cast-banner');
  castBanner.style.display = 'none';

  const castBannerIcon = el('span', 'material-icons cast_connected jellio-player-cast-banner-icon');
  castBannerIcon.setAttribute('aria-hidden', 'true');
  const castBannerText = el('span', 'jellio-player-cast-banner-text', t('player_streaming_to_smart_tv'));

  const castBannerControls = el('div', 'jellio-player-cast-banner-controls');
  const bannerSkipBack = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipBack.type = 'button';
  bannerSkipBack.setAttribute('aria-label', t('player_skip_back_10s'));
  bannerSkipBack.appendChild(el('span', 'material-icons replay_10'));
  bannerSkipBack.addEventListener('click', function () {
    skipBackButton.click();
  });

  const bannerPlayPause = el('button', 'jellio-player-cast-banner-btn');
  bannerPlayPause.type = 'button';
  bannerPlayPause.setAttribute('aria-label', t('player_play_pause_tv'));
  const bannerPlayPauseIcon = el('span', 'material-icons pause');
  bannerPlayPause.appendChild(bannerPlayPauseIcon);
  bannerPlayPause.addEventListener('click', function () {
    playPauseButton.click();
  });

  const bannerSkipForward = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipForward.type = 'button';
  bannerSkipForward.setAttribute('aria-label', t('player_skip_fwd_30s'));
  bannerSkipForward.appendChild(el('span', 'material-icons forward_30'));
  bannerSkipForward.addEventListener('click', function () {
    skipForwardButton.click();
  });

  const bannerDisconnect = el('button', 'jellio-player-cast-banner-disconnect', t('player_resume_here'));
  bannerDisconnect.type = 'button';
  bannerDisconnect.setAttribute('aria-label', t('player_stop_casting'));
  bannerDisconnect.addEventListener('click', async function () {
    const res = await disconnectCast();
    if (res && res.resumePositionTicks != null) {
      seekToAbsoluteSeconds(res.resumePositionTicks / TICKS_PER_SECOND);
      video.play().catch(function () {});
    }
  });

  castBannerControls.appendChild(bannerSkipBack);
  castBannerControls.appendChild(bannerPlayPause);
  castBannerControls.appendChild(bannerSkipForward);
  castBannerControls.appendChild(bannerDisconnect);

  castBanner.appendChild(castBannerIcon);
  castBanner.appendChild(castBannerText);
  castBanner.appendChild(castBannerControls);

  const unsubscribeCast = addCastListener(function (castState) {
    const isCasting = Boolean(castState);
    castButton.classList.toggle('jellio-player-pill-btn-active', isCasting);
    const iconName = isCasting ? 'cast_connected' : 'cast';
    const pillIcon = castButton.querySelector('.material-icons');
    if (pillIcon) pillIcon.className = 'material-icons ' + iconName;

    if (isCasting) {
      castBanner.style.display = 'flex';
      castBannerText.textContent = t('player_streaming_to', { name: castState.name || t('player_smart_tvs') });
      bannerPlayPauseIcon.className = 'material-icons ' + (castState.isPaused ? 'play_arrow' : 'pause');
      playPauseIcon.className = 'material-icons ' + (castState.isPaused ? 'play_arrow' : 'pause');
      playPauseButton.setAttribute('aria-label', castState.isPaused ? 'Play' : 'Pause');

      if (castState.positionTicks != null && !seeking) {
        const sec = castState.positionTicks / TICKS_PER_SECOND;
        currentTimeLabel.textContent = formatTime(sec);
        if (durationSeconds > 0) {
          seekBar.value = String(Math.min(100, Math.max(0, (sec / durationSeconds) * 100)));
        }
      }
    } else {
      castBanner.style.display = 'none';
      playPauseIcon.className = 'material-icons ' + (video.paused ? 'play_arrow' : 'pause');
      playPauseButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    }
  });

  // === Settings popover: Auto-skip Intros toggle and Keyboard Shortcuts modal trigger ===
  const AUTOSKIP_KEY = 'jellio_player_autoskip';
  let autoSkipEnabled = false;
  try {
    autoSkipEnabled = localStorage.getItem(AUTOSKIP_KEY) === 'true';
  } catch (e) {}

  const settingsMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const autoSkipOption = el('button', 'jellio-player-popover-option');
  autoSkipOption.type = 'button';
  const autoSkipLabel = el('span', '', t('player_autoskip'));
  autoSkipOption.appendChild(autoSkipLabel);
  function syncAutoSkipUI() {
    autoSkipOption.classList.toggle('jellio-player-popover-option-active', autoSkipEnabled);
  }
  syncAutoSkipUI();
  autoSkipOption.addEventListener('click', function () {
    autoSkipEnabled = !autoSkipEnabled;
    try {
      localStorage.setItem(AUTOSKIP_KEY, String(autoSkipEnabled));
    } catch (e) {}
    syncAutoSkipUI();
    showPlayerToast(autoSkipEnabled ? 'Auto-skip enabled' : 'Auto-skip disabled');
  });
  settingsMenu.appendChild(autoSkipOption);

  sleepOption = el('button', 'jellio-player-popover-option jellio-player-settings-sleep');
  sleepOption.type = 'button';
  const sleepOptionLabel = el('span', 'jellio-player-settings-sleep-label');
  const sleepOptionIcon = el('span', 'material-icons bedtime');
  sleepOptionIcon.setAttribute('aria-hidden', 'true');
  sleepOptionLabel.appendChild(sleepOptionIcon);
  sleepOptionLabel.appendChild(el('span', '', t('player_sleep_timer')));
  sleepOption.appendChild(sleepOptionLabel);
  sleepOption.addEventListener('click', function () {
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
  settingsMenu.appendChild(sleepOption);

  const shortcutsOption = el('button', 'jellio-player-popover-option jellio-player-popover-shortcuts-option');
  shortcutsOption.type = 'button';
  shortcutsOption.appendChild(el('span', '', t('player_keyboard_shortcuts')));
  const shortcutHint = el('span', 'jellio-player-shortcut-badge', '?');
  shortcutsOption.appendChild(shortcutHint);
  shortcutsOption.addEventListener('click', function () {
    closePopovers(null);
    openShortcutsModal();
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

  openShortcutsModal = function () {
    shortcutsModal.classList.remove('jellio-player-shortcuts-modal-hidden');
    wakeControls();
  };
  closeShortcutsModal = function () {
    shortcutsModal.classList.add('jellio-player-shortcuts-modal-hidden');
  };
  toggleShortcutsModal = function () {
    if (shortcutsModal.classList.contains('jellio-player-shortcuts-modal-hidden')) {
      openShortcutsModal();
    } else {
      closeShortcutsModal();
    }
  };

  shortcutsBackdrop.addEventListener('click', closeShortcutsModal);
  shortcutsClose.addEventListener('click', closeShortcutsModal);

  // === MediaSession API: OS lock screen, media keys, Bluetooth headset controls ===
  syncMediaSession = function () {
    if (!('mediaSession' in navigator)) return;
    try {
      const artwork = [];
      const poster = seriesAwareArtworkUrl(800) || seriesAwareArtworkUrl(1600);
      if (poster) {
        artwork.push({ src: poster, sizes: '800x450', type: 'image/jpeg' });
      }
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: isEpisodeItem ? (item.Name || 'Episode') : (item.Name || 'Video'),
        artist: isEpisodeItem ? item.SeriesName : '',
        album: isEpisodeItem && typeof item.ParentIndexNumber === 'number' && typeof item.IndexNumber === 'number'
          ? ('Season ' + item.ParentIndexNumber + ' · Episode ' + item.IndexNumber)
          : '',
        artwork: artwork,
      });

      navigator.mediaSession.setActionHandler('play', function () {
        attemptPlay();
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        video.pause();
      });
      navigator.mediaSession.setActionHandler('seekbackward', function (details) {
        const offset = (details && details.seekOffset) || 10;
        performSeek(Math.max(0, video.currentTime - offset));
      });
      navigator.mediaSession.setActionHandler('seekforward', function (details) {
        const offset = (details && details.seekOffset) || 10;
        performSeek(Math.min(durationSeconds || video.duration || 0, video.currentTime + offset));
      });
      navigator.mediaSession.setActionHandler('seekto', function (details) {
        if (details && typeof details.seekTime === 'number') {
          performSeek(details.seekTime);
        }
      });
      navigator.mediaSession.setActionHandler('stop', function () {
        backButton.click();
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        skipBackButton.click();
      });
      if (nextEpisode) {
        navigator.mediaSession.setActionHandler('nexttrack', function () {
          navigateTo('#/item?id=' + nextEpisode.Id);
        });
      }
    } catch (e) {
      console.warn('Jellio: could not initialize MediaSession', e);
    }
  };

  syncMediaPosition = function () {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (durationSeconds > 0 && !isNaN(video.currentTime)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: durationSeconds,
          playbackRate: video.playbackRate || 1,
          position: Math.min(durationSeconds, Math.max(0, video.currentTime)),
        });
      } catch (e) {}
    }
  };

  syncMediaSession();

  const sourcePanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const sourcePanelHeader = el('div', 'jellio-player-sidepanel-header');
  sourcePanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', t('player_sources')));
  const sourceCloseButton = el('button', 'jellio-player-sidepanel-close', t('action_close'));
  sourceCloseButton.type = 'button';
  sourcePanelHeader.appendChild(sourceCloseButton);
  sourcePanel.appendChild(sourcePanelHeader);
  const sourceFilterContainer = el('div', 'jellio-player-sidepanel-filters');
  sourcePanel.appendChild(sourceFilterContainer);
  const sourceList = el('div', 'jellio-player-sidepanel-list');
  sourcePanel.appendChild(sourceList);

  let sourceOptions = [mediaSource];
  let selectedSourceLanguage = null;
  let selectedSourceQuality = null;
  let switchingSource = false;

  function closeSidePanels() {
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
    sourceButton.setAttribute('aria-expanded', 'false');
    episodesButton.setAttribute('aria-expanded', 'false');
    if (shell) shell.scrollLeft = 0;
    if (root) root.scrollLeft = 0;
    wakeControls();
  }

  function rebuildSourceFilter() {
    sourceFilterContainer.textContent = '';
    selectedSourceLanguage = null;
    const filterRow = buildLanguageFilterRow(sourceOptions, function (code) {
      selectedSourceLanguage = code;
      rebuildSourceMenu();
    });
    if (filterRow) sourceFilterContainer.appendChild(filterRow);
    selectedSourceQuality = null;
    const qualityRow = buildQualityFilterRow(sourceOptions, function (quality) {
      selectedSourceQuality = quality;
      rebuildSourceMenu();
    });
    if (qualityRow) sourceFilterContainer.appendChild(qualityRow);
  }

  function rebuildSourceMenu() {
    sourceList.textContent = '';
    const blocking = getVideoTranscodePolicy() === 'Block';
    const filtered = filterSources(sourceOptions, selectedSourceLanguage, selectedSourceQuality)
      .map(function (source, index) {
        const judged = avoidingVideoTranscodes() && videoInfoOf(source) ? classifySource(source, canBrowserDirectPlay(source)) : null;
        return {
          source: source,
          verdict: judged && judged.needsVideoTranscode ? judged : null,
          outlook: judged ? playbackOutlook(judged) : null,
          index: index,
        };
      })
      .sort(function (a, b) {
        return (a.verdict ? 1 : 0) - (b.verdict ? 1 : 0) || a.index - b.index;
      });
    filtered.forEach(function (entry) {
      const source = entry.source;
      const verdict = entry.verdict;
      const card = buildSourceCard(
        source,
        function (picked) {
          if (verdict && blocking && picked.Id !== mediaSource.Id) {
            showPlayerToast('This stream needs the server to re-encode the video, which is turned off on this server.');
            return;
          }
          closeSidePanels();
          if (picked.Id !== mediaSource.Id) switchSource(picked);
        },
        source.Id === mediaSource.Id,
      );
      const outlook = entry.outlook;
      if (outlook) card.insertBefore(buildOutlookBadge(outlook), card.children[1] || null);
      if (verdict) {
        card.classList.add(blocking ? 'jellio-player-source-blocked' : 'jellio-player-source-warn');
        if (blocking) card.setAttribute('aria-disabled', 'true');
      }
      sourceList.appendChild(card);
    });
  }

  sourceButton.addEventListener('click', function () {
    closePopovers(null);
    const willOpen = sourcePanel.classList.contains('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
    episodesButton.setAttribute('aria-expanded', 'false');
    if (willOpen) {
      sourcePanel.classList.remove('jellio-player-sidepanel-hidden');
      sourceButton.setAttribute('aria-expanded', 'true');
    } else {
      sourcePanel.classList.add('jellio-player-sidepanel-hidden');
      sourceButton.setAttribute('aria-expanded', 'false');
    }
    wakeControls();
  });
  sourceCloseButton.addEventListener('click', function (e) {
    e.stopPropagation();
    closeSidePanels();
  });

  const episodesPanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const episodesPanelHeader = el('div', 'jellio-player-sidepanel-header');
  episodesPanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', t('player_episodes')));
  const episodesCloseButton = el('button', 'jellio-player-sidepanel-close', t('action_close'));
  episodesCloseButton.type = 'button';
  episodesPanelHeader.appendChild(episodesCloseButton);
  episodesPanel.appendChild(episodesPanelHeader);
  const seasonTabs = el('div', 'jellio-player-sidepanel-tabs');
  episodesPanel.appendChild(seasonTabs);
  const episodeList = el('div', 'jellio-player-sidepanel-list');
  episodesPanel.appendChild(episodeList);
  episodesCloseButton.addEventListener('click', function (e) {
    e.stopPropagation();
    closeSidePanels();
  });

  function buildEpisodeRow(episode) {
    const row = el('button', 'jellio-player-episode-row' + (episode.Id === itemId ? ' jellio-player-episode-row-active' : ''));
    row.type = 'button';
    const thumbTag = (episode.ImageTags && episode.ImageTags.Primary) || episode.ParentThumbImageTag;
    const thumb = el('div', 'jellio-player-episode-thumb');
    if (thumbTag) {
      thumb.style.backgroundImage = 'url(' + getImageUrl(episode.Id, 'Primary', { tag: thumbTag, maxWidth: 400 }) + ')';
    }
    if (episode.CommunityRating) {
      thumb.appendChild(buildRatingBadge(episode.CommunityRating, 'jellio-player-episode-rating'));
    }
    const hasCode = typeof episode.ParentIndexNumber === 'number' && typeof episode.IndexNumber === 'number';
    if (hasCode) {
      thumb.appendChild(el('span', 'jellio-player-episode-code', 'S' + episode.ParentIndexNumber + 'E' + episode.IndexNumber));
    }
    row.appendChild(thumb);
    const body = el('div', 'jellio-player-episode-body');
    body.appendChild(el('div', 'jellio-player-episode-title', episode.Name || ''));
    if (episode.Overview) {
      body.appendChild(el('p', 'jellio-player-episode-overview', episode.Overview));
    }
    row.appendChild(body);
    row.addEventListener('click', function () {
      if (episode.Id === itemId) {
        closeSidePanels();
        return;
      }
      navigateTo('#/play?id=' + episode.Id);
    });
    return row;
  }

  // Only the latest season asked for fills the list: an earlier answer
  // arriving late used to be appended to it as well.
  let episodeListRequest = 0;
  function loadSeasonEpisodes(seriesId, season, tabButton) {
    Array.prototype.forEach.call(seasonTabs.children, function (child) {
      child.classList.remove('jellio-player-sidepanel-tab-active');
    });
    if (tabButton) tabButton.classList.add('jellio-player-sidepanel-tab-active');
    episodeList.textContent = '';
    const request = ++episodeListRequest;
    getEpisodes(seriesId, season.Id)
      .then(function (episodes) {
        if (request !== episodeListRequest) return;
        episodeList.textContent = '';
        episodes.forEach(function (episode) {
          episodeList.appendChild(buildEpisodeRow(episode));
        });
        revealCurrentEpisode();
      })
      .catch(function (err) {
        console.warn('Jellio: could not load episodes for player episode panel', err);
      });
  }

  function isSpecialsSeason(season) {
    if (season.IndexNumber === 0) return true;
    return /special/i.test(season.Name || '');
  }

  if (isEpisodeItem && item.SeriesId) {
    getSeasons(item.SeriesId)
      .then(function (seasons) {
        if (!seasons.length) return;
        episodesButton.disabled = false;
        const orderedSeasons = seasons.slice().sort(function (a, b) {
          return (isSpecialsSeason(a) ? 1 : 0) - (isSpecialsSeason(b) ? 1 : 0);
        });
        let currentSeasonLoaded = false;
        orderedSeasons.forEach(function (season) {
          const tab = el('button', 'jellio-player-sidepanel-tab', season.Name || '');
          tab.type = 'button';
          tab.addEventListener('click', function () {
            loadSeasonEpisodes(item.SeriesId, season, tab);
          });
          seasonTabs.appendChild(tab);
          if (season.Id === item.SeasonId) {
            currentSeasonLoaded = true;
            loadSeasonEpisodes(item.SeriesId, season, tab);
          }
        });
        if (!currentSeasonLoaded && orderedSeasons[0]) {
          loadSeasonEpisodes(item.SeriesId, orderedSeasons[0], seasonTabs.firstChild);
        }
      })
      .catch(function (err) {
        console.warn('Jellio: could not load seasons for player episode panel', err);
      });
  }

  // The playing episode (highlighted) and its season tab scrolled into
  // view whenever the panel is open.
  function revealCurrentEpisode() {
    if (episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) return;
    const activeTab = seasonTabs.querySelector('.jellio-player-sidepanel-tab-active');
    if (activeTab && seasonTabs) {
      const targetLeft = activeTab.offsetLeft - (seasonTabs.clientWidth / 2) + (activeTab.offsetWidth / 2);
      seasonTabs.scrollTo({ left: Math.max(0, targetLeft), behavior: 'auto' });
    }
    const activeRow = episodeList.querySelector('.jellio-player-episode-row-active');
    if (activeRow && episodeList) {
      const targetTop = activeRow.offsetTop - (episodeList.clientHeight / 2) + (activeRow.offsetHeight / 2);
      episodeList.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    }
  }

  episodesButton.addEventListener('click', function () {
    closePopovers(null);
    const willOpen = episodesPanel.classList.contains('jellio-player-sidepanel-hidden');
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    sourceButton.setAttribute('aria-expanded', 'false');
    if (willOpen) {
      episodesPanel.classList.remove('jellio-player-sidepanel-hidden');
      episodesButton.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(revealCurrentEpisode);
    } else {
      episodesPanel.classList.add('jellio-player-sidepanel-hidden');
      episodesButton.setAttribute('aria-expanded', 'false');
    }
    wakeControls();
  });

  let toastTimer = null;
  function showPlayerToast(message) {
    let toast = root.querySelector('.jellio-player-toast');
    if (!toast) {
      toast = el('div', 'jellio-player-toast');
      root.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('jellio-player-toast-visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('jellio-player-toast-visible');
    }, 4000);
  }

  function attemptPlay(isRetry) {
    armStartTimer();
    const playResult = video.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(function (err) {
        if (!isRetry) {
          console.warn('Jellio: could not start playback, retrying once', err);
          window.setTimeout(function () {
            attemptPlay(true);
          }, 3000);
          return;
        }
        console.warn('Jellio: could not start playback', err);
        if (hasReportedStart) {
          hideLoadingLogo();
        }
        showPlayerToast('Could not start playback. Try pressing play again.');
      });
    }
  }

  const PREBUFFER_TARGET_SECONDS = 8;
  const PREBUFFER_TIMEOUT_MS = 12000;
  const CONFIRMED_CACHED_TARGET_SECONDS = 1;
  const CONFIRMED_CACHED_TIMEOUT_MS = 2500;
  function isConfirmedCachedSource() {
    return !!(mediaSource && mediaSource.Formats && mediaSource.Formats.indexOf('gelato-cached') !== -1);
  }
  function waitForPlayableBuffer(callback, targetOverride, timeoutOverride) {
    let settled = false;
    const prebuffer = prebufferSettings();
    const raised = prebuffer.startSeconds > PREBUFFER_TARGET_SECONDS;
    const confirmedCached = !raised && isConfirmedCachedSource();
    const targetSeconds = targetOverride || (confirmedCached ? CONFIRMED_CACHED_TARGET_SECONDS : Math.max(PREBUFFER_TARGET_SECONDS, prebuffer.startSeconds));
    const timeoutMs = timeoutOverride || (confirmedCached ? CONFIRMED_CACHED_TIMEOUT_MS : Math.max(PREBUFFER_TIMEOUT_MS, prebuffer.startTimeoutMs));
    function bufferedAheadSeconds() {
      const start = video.currentTime || 0;
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= start && buffered.end(i) >= start) {
          return buffered.end(i) - start;
        }
      }
      return 0;
    }
    function settle() {
      if (settled) return;
      settled = true;
      video.removeEventListener('progress', check);
      video.removeEventListener('canplaythrough', check);
      window.clearTimeout(fallbackTimer);
      callback();
    }
    function check() {
      // readyState 4 only means the browser expects to play through at the
      // current rate; with a raised target the seconds have to be there.
      if (bufferedAheadSeconds() >= targetSeconds || (!raised && !targetOverride && video.readyState >= 4)) settle();
      else if (video.duration && video.currentTime + bufferedAheadSeconds() >= video.duration - 0.5) settle();
    }
    const fallbackTimer = window.setTimeout(settle, timeoutMs);
    video.addEventListener('progress', check);
    video.addEventListener('canplaythrough', check);
    check();
  }

  async function seekToAbsoluteSeconds(targetSeconds) {
    if (streamIsTranscoded && supportsNativeHls()) {
      video.currentTime = targetSeconds;
      return;
    }

    const targetTicks = Math.max(0, Math.round(targetSeconds * TICKS_PER_SECOND));
    const wasPlaying = !video.paused;
    const burnedInSubtitleIndex = activeTrack ? null : activeSubtitleStreamIndex;
    try {
      reportPlaybackStopped(itemId, mediaSource.Id, targetTicks);
      const info = await getPlaybackInfo(itemId, targetTicks, mediaSource.Id, currentAudioStreamIndex, burnedInSubtitleIndex);
      const negotiated = pickNegotiatedSource(info, mediaSource.Id);
      if (!negotiated) {
        showPlayerToast('Could not seek, that stream is no longer available.');
        return;
      }
      mediaSource = negotiated;
      playSessionId = info.PlaySessionId;
      streamIsTranscoded = true;
      const seekUsesHls = willUseHls(mediaSource, true);
      needsStartOffset = !seekUsesHls;
      streamOffsetTicks = needsStartOffset ? targetTicks : 0;
      pendingNativeSeekSeconds = seekUsesHls ? targetSeconds : null;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, targetTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        burnInSubtitleStreamIndex: burnedInSubtitleIndex,
        forceTranscode: true,
        playSessionId: playSessionId,
      });
      video.load();
      showLoadingLogo();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
    } catch (err) {
      console.warn('Jellio: seek failed', err);
      showPlayerToast('Seek failed: ' + (err && err.message ? err.message : err));
    }
  }

  function performSeek(targetSeconds) {
    lastUserSeekAt = Date.now();
    if (getActiveCast()) {
      sendRemoteSeek(Math.round(targetSeconds * TICKS_PER_SECOND)).catch(function (err) {
        console.warn('Jellio: could not send Cast seek', err);
      });
      return;
    }
    if (syncPlaylistItemId) {
      if (partyLayer && partyLayer.shouldAsk()) {
        partyLayer.ask('seek', Math.round(targetSeconds * TICKS_PER_SECOND));
        return;
      }
      requestSyncSeek(Math.round(targetSeconds * TICKS_PER_SECOND)).catch(function (err) {
        console.warn('Jellio: could not send Group Watch seek', err);
      });
      return;
    }
    seekToAbsoluteSeconds(targetSeconds);
  }

  skipBackButton.addEventListener('click', function () {
    if (typeof triggerRipple === 'function' && typeof rippleLeft !== 'undefined') triggerRipple(rippleLeft);
    performSeek(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0) - 10);
  });
  skipForwardButton.addEventListener('click', function () {
    if (typeof triggerRipple === 'function' && typeof rippleRight !== 'undefined') triggerRipple(rippleRight);
    performSeek(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0) + 10);
  });

  let switchCard = null;
  let switchToken = 0;

  function showSwitchCard(label, step) {
    if (!switchCard) {
      switchCard = el('div', 'jellio-player-switch');
      switchCard.setAttribute('role', 'status');
      switchCard.appendChild(el('div', 'jellio-player-switch-spinner'));
      const text = el('div', 'jellio-player-switch-text');
      text.appendChild(el('div', 'jellio-player-switch-title'));
      text.appendChild(el('div', 'jellio-player-switch-step'));
      switchCard.appendChild(text);
      root.appendChild(switchCard);
    }
    switchCard.querySelector('.jellio-player-switch-title').textContent = t('player_buffer_switching', { label: label });
    switchCard.querySelector('.jellio-player-switch-step').textContent = step;
  }

  function closeSwitchCard() {
    if (switchCard) switchCard.remove();
    switchCard = null;
  }

  function confirmSwitchWhenPlaying(token, label, wasPlaying) {
    const eventName = wasPlaying ? 'playing' : 'canplay';
    function done() {
      video.removeEventListener(eventName, done);
      if (token !== switchToken || screenTornDown) return;
      closeSwitchCard();
      showPlayerToast(t('player_switch_done', { label: label }));
    }
    video.addEventListener(eventName, done);
  }

  async function switchSource(source) {
    if (switchingSource) return;
    switchingSource = true;
    const token = ++switchToken;
    const label = sourceLabel(source);
    showSwitchCard(label, t('player_switch_connecting'));
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    const previousAudioLanguage = activeAudioLanguageCode();
    const knownAudio = getAudioStreams(source).length > 1;
    const wantedAudioIndex = previousAudioLanguage && knownAudio ? matchAudioStreamIndex(source, previousAudioLanguage) : null;
    let previousSubtitleLanguage = null;
    if (mediaSource && activeSubtitleStreamIndex != null) {
      const subStreams = (mediaSource.MediaStreams || []).filter(function (s) {
        return s.Type === 'Subtitle';
      });
      const activeSub = subStreams.find(function (s) {
        return s.Index === activeSubtitleStreamIndex;
      });
      previousSubtitleLanguage = activeSub && activeSub.Language ? activeSub.Language.toLowerCase() : null;
    }
    reportPlaybackStopped(itemId, mediaSource.Id, resumeTicks);
    try {
      const info = await getPlaybackInfo(itemId, resumeTicks, source.Id, wantedAudioIndex == null ? undefined : wantedAudioIndex);
      const negotiated = pickNegotiatedSource(info, source.Id);
      if (!negotiated) {
        closeSwitchCard();
        showPlayerToast('That stream is no longer available.');
        return;
      }
      mediaSource = negotiated;
      playSessionId = info.PlaySessionId;
      if (activeTrack) {
        activeTrack.remove();
        activeTrack = null;
      }
      hasReportedStart = false;
      currentAudioStreamIndex = wantedAudioIndex;
      activeSubtitleStreamIndex = null;
      bufferStalls.length = 0;
      bufferStallStartedAt = 0;

      if (!knownAudio && previousAudioLanguage && getAudioStreams(mediaSource).length > 1) {
        const matchedAudioIndex = matchAudioStreamIndex(mediaSource, previousAudioLanguage);
        if (matchedAudioIndex != null) {
          try {
            const rematched = await getPlaybackInfo(itemId, resumeTicks, source.Id, matchedAudioIndex);
            const rematchedSource = pickNegotiatedSource(rematched, source.Id);
            if (rematchedSource) {
              mediaSource = rematchedSource;
              playSessionId = rematched.PlaySessionId;
              currentAudioStreamIndex = matchedAudioIndex;
            }
          } catch (e) {
            console.warn('Jellio: could not rematch audio track on stream switch', e);
          }
        }
      }

      // Preserve active subtitle language across stream switch if available
      if (previousSubtitleLanguage) {
        const matchedSub = matchSubtitleStream(mediaSource, previousSubtitleLanguage);
        if (matchedSub) {
          activeSubtitleStreamIndex = matchedSub.Index;
          attachSubtitleTrack(matchedSub, 0);
        }
      }

      const sourceForceTranscode = resumeTicks > 0 || currentAudioStreamIndex != null;
      streamIsTranscoded = sourceForceTranscode || !canBrowserDirectPlay(mediaSource);
      const switchSourceUsesHls = willUseHls(mediaSource, sourceForceTranscode);
      needsStartOffset = streamIsTranscoded && !switchSourceUsesHls;
      streamOffsetTicks = needsStartOffset ? resumeTicks : 0;
      pendingNativeSeekSeconds = resumeTicks > 0 && !needsStartOffset ? resumeTicks / TICKS_PER_SECOND : null;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        forceTranscode: sourceForceTranscode,
        playSessionId: playSessionId,
      });
      video.load();
      showLoadingLogo();
      showSwitchCard(label, t('player_switch_loading'));
      confirmSwitchWhenPlaying(token, label, wasPlaying);
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      topbarMeta.textContent = sourceLabel(mediaSource);
      rebuildSubtitleMenu();
      rebuildAudioMenu();
      rebuildSourceMenu();
    } catch (err) {
      console.warn('Jellio: could not switch source', err);
      closeSwitchCard();
      showPlayerToast('Could not switch streams. Check your connection and try again.');
    } finally {
      switchingSource = false;
    }
  }

  getMediaSources(itemId)
    .then(function (sources) {
      if (sources.length > 1) {
        sourceOptions = sources;
        sourceButton.disabled = false;
        rebuildSourceFilter();
        rebuildSourceMenu();
      }
    })
    .catch(function (err) {
      console.warn('Jellio: could not load alternate sources', err);
    });

  shell.appendChild(topbar);
  shell.appendChild(centerControls);
  shell.appendChild(seekRow);
  shell.appendChild(pill);
  // Party overlays sit just above the seek row and below the top bar.
  overlayInsets = new ResizeObserver(function () {
    const box = root.getBoundingClientRect();
    if (!box.height) return;
    root.style.setProperty('--jellio-player-bottom-inset', Math.max(0, box.bottom - seekRow.getBoundingClientRect().top) + 'px');
    root.style.setProperty('--jellio-player-top-inset', Math.max(0, topbar.getBoundingClientRect().bottom - box.top) + 'px');
  });
  overlayInsets.observe(root);
  overlayInsets.observe(seekRow);
  overlayInsets.observe(pill);
  overlayInsets.observe(topbar);
  shell.appendChild(volumeMenu);
  shell.appendChild(speedMenu);
  shell.appendChild(subtitleMenu);
  shell.appendChild(audioMenu);
  shell.appendChild(sleepMenu);
  shell.appendChild(castMenu);
  shell.appendChild(settingsMenu);
  shell.appendChild(sourcePanel);
  shell.appendChild(episodesPanel);
  shell.appendChild(shortcutsModal);
  shell.appendChild(castBanner);

  const rippleLeft = el('div', 'jellio-player-seek-ripple jellio-player-seek-ripple-left');
  rippleLeft.innerHTML = '<span class="material-icons">replay_10</span><span class="jellio-player-seek-ripple-text">10s</span>';
  const rippleRight = el('div', 'jellio-player-seek-ripple jellio-player-seek-ripple-right');
  rippleRight.innerHTML = '<span class="material-icons">forward_10</span><span class="jellio-player-seek-ripple-text">10s</span>';
  shell.appendChild(rippleLeft);
  shell.appendChild(rippleRight);

  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  function triggerRipple(rippleEl) {
    rippleEl.classList.remove('jellio-player-seek-ripple-active');
    void rippleEl.offsetWidth;
    rippleEl.classList.add('jellio-player-seek-ripple-active');
    window.setTimeout(function () {
      rippleEl.classList.remove('jellio-player-seek-ripple-active');
    }, 700);
  }

  shell.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, .jellio-player-popover, .jellio-player-sidepanel, .jellio-player-chat-panel, .jellio-player-progress-bar-container, .jellio-player-bar, .jellio-player-pill-center, .jellio-player-pill')) {
      return;
    }
    const now = Date.now();
    const rect = shell.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dist = Math.hypot(x - lastTapX, y - lastTapY);

    if (now - lastTapTime < 320 && dist < 60) {
      lastTapTime = 0;
      const width = rect.width;
      if (x < width * 0.4) {
        triggerRipple(rippleLeft);
        skipBackButton.click();
      } else if (x > width * 0.6) {
        triggerRipple(rippleRight);
        skipForwardButton.click();
      }
    } else {
      lastTapTime = now;
      lastTapX = x;
      lastTapY = y;
    }
  });

  let idleTimer = null;
  function hideControls() {
    const blocked =
      video.paused ||
      !hasReportedStart ||
      !shortcutsModal.classList.contains('jellio-player-shortcuts-modal-hidden') ||
      popovers.some(function (entry) {
        return !entry.menu.classList.contains('jellio-player-popover-hidden');
      }) ||
      !sourcePanel.classList.contains('jellio-player-sidepanel-hidden') ||
      !episodesPanel.classList.contains('jellio-player-sidepanel-hidden');
    if (blocked) {
      idleTimer = window.setTimeout(hideControls, IDLE_HIDE_MS);
      return;
    }
    shell.classList.add('jellio-player-shell-idle');
  }
  function wakeControls() {
    if (screenTornDown) return;
    shell.classList.remove('jellio-player-shell-idle');
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(hideControls, IDLE_HIDE_MS);
  }
  function onRootWake() {
    if (screenTornDown) return;
    wakeControls();
  }
  const rootWakeEvents = ['mousemove', 'touchstart', 'keydown', 'click'];
  rootWakeEvents.forEach(function (eventName) {
    root.addEventListener(eventName, onRootWake);
  });
  function onPlayerDblClick(event) {
    if (screenTornDown) return;
    if (event.target && event.target.closest && event.target.closest('button, input, select, textarea, .jellio-player-popover, .jellio-player-sidepanel, .jellio-player-shortcuts-modal, .jellio-player-chat-panel')) {
      return;
    }
    if (fullscreenButton) fullscreenButton.click();
  }
  function onPlayerWheel(event) {
    if (screenTornDown) return;
    if (event.target && event.target.closest && event.target.closest('.jellio-player-popover, .jellio-player-sidepanel, .jellio-player-shortcuts-modal, .jellio-player-chat-panel')) {
      return;
    }
    event.preventDefault();
    wakeControls();
    adjustVolume(event.deltaY < 0 ? 0.05 : -0.05);
  }
  root.addEventListener('dblclick', onPlayerDblClick);
  root.addEventListener('wheel', onPlayerWheel, { passive: false });
  wakeControls();

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!target.isContentEditable;
  }
  function adjustVolume(delta) {
    if (getActiveCast()) {
      const newVol = Math.min(100, Math.max(0, Math.round(video.volume * 100 + delta * 100)));
      video.volume = newVol / 100;
      sendRemoteVolume(newVol).catch(function () {});
      syncVolumeUI();
      showPlayerToast('TV Volume ' + newVol + '%');
      return;
    }
    video.muted = false;
    video.volume = Math.min(1, Math.max(0, video.volume + delta));
    syncVolumeUI();
    showPlayerToast('Volume ' + Math.round(video.volume * 100) + '%');
  }
  function toggleMute() {
    video.muted = !video.muted;
    syncVolumeUI();
    showPlayerToast(video.muted ? 'Muted' : 'Unmuted');
  }
  function onPlayerKeydown(event) {
    if (screenTornDown || isTypingTarget(event.target)) return;
    if (endScreenModalInstance) {
      if (event.key === 'Escape') {
        event.preventDefault();
        endScreenModalInstance.cleanup();
        endScreenModalInstance = null;
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (endScreenModalInstance.primaryBtn) {
          endScreenModalInstance.primaryBtn.click();
        }
        return;
      }
      return;
    }
    if (event.altKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      toggleCastMenu();
      return;
    }
    if (event.key === 'MediaPlayPause') {
      event.preventDefault();
      playPauseButton.click();
      return;
    }
    if (event.key === 'MediaTrackNext' || event.key === 'MediaNextTrack') {
      event.preventDefault();
      skipForwardButton.click();
      return;
    }
    if (event.key === 'MediaTrackPrevious' || event.key === 'MediaPreviousTrack') {
      event.preventDefault();
      skipBackButton.click();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    switch (event.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
      case 'K':
        event.preventDefault();
        playPauseButton.click();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault();
        skipBackButton.click();
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        event.preventDefault();
        skipForwardButton.click();
        break;
      case 'ArrowUp':
        event.preventDefault();
        adjustVolume(0.1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        adjustVolume(-0.1);
        break;
      case 'f':
      case 'F':
        if (fullscreenButton) fullscreenButton.click();
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'c':
      case 'C':
        subtitleButton.click();
        break;
      case 'z':
      case 'Z':
        event.preventDefault();
        updateSubtitleOffset(-0.1);
        break;
      case 'x':
      case 'X':
        event.preventDefault();
        updateSubtitleOffset(0.1);
        break;
      case ',':
        if (video.paused) {
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 0.04);
        }
        break;
      case '.':
        if (video.paused) {
          event.preventDefault();
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.04);
        }
        break;
      case '>':
        event.preventDefault();
        stepPlaybackSpeed(1);
        break;
      case '<':
        event.preventDefault();
        stepPlaybackSpeed(-1);
        break;
      case 's':
      case 'S':
        if (!skipOverlay.overlay.classList.contains('jellio-player-skip-hidden')) {
          performSeek(skipTargetSeconds);
        }
        break;
      case '?':
        event.preventDefault();
        toggleShortcutsModal();
        break;
      case 'Escape': {
        if (!shortcutsModal.classList.contains('jellio-player-shortcuts-modal-hidden')) {
          closeShortcutsModal();
          break;
        }
        const openPopover = popovers.find(function (entry) {
          return !entry.menu.classList.contains('jellio-player-popover-hidden');
        });
        if (openPopover) {
          openPopover.menu.classList.add('jellio-player-popover-hidden');
        } else if (!sourcePanel.classList.contains('jellio-player-sidepanel-hidden') || !episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) {
          closeSidePanels();
        } else {
          closeChatPanel();
        }
        break;
      }
      default:
        break;
    }
  }
  document.addEventListener('keydown', onPlayerKeydown);

  const syncWaitBanner = el('div', 'jellio-player-sync-wait');
  syncWaitBanner.appendChild(el('span', 'jellio-player-sync-wait-dot'));
  const syncWaitText = el('span', null, '');
  syncWaitBanner.appendChild(syncWaitText);

  const pauseOverlay = el('div', 'jellio-player-pause-overlay');
  const pauseArt = fullscreenArtCss();
  if (pauseArt) pauseOverlay.style.backgroundImage = pauseArt;
  const pauseContent = el('div', 'jellio-player-pause-content');
  pauseContent.appendChild(el('div', 'jellio-player-pause-eyebrow', t('player_youre_watching')));
  pauseContent.appendChild(el('div', 'jellio-player-pause-title', isEpisodeItem ? item.SeriesName : item.Name || ''));
  const pauseMeta = el('div', 'jellio-player-pause-meta');
  if (item.CommunityRating) pauseMeta.appendChild(buildRatingBadge(item.CommunityRating));
  if (item.ProductionYear) pauseMeta.appendChild(el('span', null, String(item.ProductionYear)));
  if (item.OfficialRating) pauseMeta.appendChild(el('span', null, item.OfficialRating));
  pauseContent.appendChild(pauseMeta);
  if (isEpisodeItem) {
    const hasCode = typeof item.ParentIndexNumber === 'number' && typeof item.IndexNumber === 'number';
    if (hasCode) {
      pauseContent.appendChild(el('div', 'jellio-player-pause-episode-code', 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber));
    }
    pauseContent.appendChild(el('div', 'jellio-player-pause-episode-title', item.Name || ''));
  }
  if (item.Overview) {
    pauseContent.appendChild(el('p', 'jellio-player-pause-overview', item.Overview));
  }
  pauseOverlay.appendChild(pauseContent);

  function buildSkipOverlay(onSkip, onDismiss) {
    const overlay = el('div', 'jellio-player-skip jellio-player-skip-hidden');

    const body = el('div', 'jellio-player-skip-body');
    const eyebrow = el('div', 'jellio-player-skip-eyebrow', '');
    body.appendChild(eyebrow);
    const title = el('div', 'jellio-player-skip-title', '');
    body.appendChild(title);

    const actions = el('div', 'jellio-player-skip-actions');
    const skipActionButton = el('button', 'jellio-player-skip-play', t('player_skip'));
    skipActionButton.type = 'button';
    skipActionButton.addEventListener('click', onSkip);
    const dismissButton = el('button', 'jellio-player-skip-dismiss', t('player_dismiss'));
    dismissButton.type = 'button';
    dismissButton.setAttribute('aria-label', t('player_dismiss_skip'));
    dismissButton.addEventListener('click', onDismiss);
    actions.appendChild(skipActionButton);
    actions.appendChild(dismissButton);
    body.appendChild(actions);
    overlay.appendChild(body);

    return { overlay: overlay, eyebrowEl: eyebrow, titleEl: title };
  }

  let skipSegments = null;
  let skipTargetSeconds = 0;

  function chapterFallbackSegments(chapters, runTimeTicks) {
    if (!chapters || !chapters.length) {
      console.warn('Jellio: item has no Chapters to fall back on', itemId, chapters);
      return null;
    }
    function ticksToSeconds(ticks) {
      return (ticks || 0) / TICKS_PER_SECOND;
    }
    function findSegment(nameRegex) {
      const index = chapters.findIndex(function (chapter) {
        return chapter.Name && nameRegex.test(chapter.Name);
      });
      if (index === -1) return null;
      const start = ticksToSeconds(chapters[index].StartPositionTicks);
      const nextTicks = index + 1 < chapters.length ? chapters[index + 1].StartPositionTicks : runTimeTicks;
      const end = ticksToSeconds(nextTicks);
      return end > start ? { Start: start, End: end } : null;
    }
    const introduction = findSegment(/^(intro|introduction|opening)/i);
    // "Opening Credits" is the intro, not the end credits.
    const credits = findSegment(/^(?!.*open).*(credit|outro|ending)/i);
    if (!introduction && !credits) {
      console.warn(
        'Jellio: item has Chapters but none matched an intro/credits name',
        itemId,
        chapters.map(function (chapter) {
          return chapter.Name;
        }),
      );
      return null;
    }
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  }

  function activeSkipSegment(currentTime) {
    if (!skipSegments) return null;
    const intro = skipSegments.Introduction;
    if (intro && intro.End > 0 && currentTime >= intro.Start && currentTime < intro.End) {
      return { eyebrow: 'Introduction', label: 'Skip Intro', target: intro.End };
    }
    const credits = skipSegments.Credits;
    if (credits && credits.End > 0 && currentTime >= credits.Start && currentTime < credits.End) {
      return { eyebrow: 'Credits', label: 'Skip Credits', target: credits.End };
    }
    return null;
  }

  function shouldShowUpNextNow(currentTime, duration) {
    if (!duration) return false;
    const credits = skipSegments && skipSegments.Credits;
    if (credits && credits.End > 0 && credits.Start >= 0) {
      return currentTime >= credits.Start;
    }
    return false;
  }

  let dismissedSkipKind = null;
  const skipOverlay = buildSkipOverlay(
    function () {
      performSeek(skipTargetSeconds);
    },
    function () {
      dismissedSkipKind = skipOverlay.eyebrowEl.textContent;
      skipOverlay.overlay.classList.add('jellio-player-skip-hidden');
    },
  );

  function isValidSegment(segment) {
    return !!(segment && segment.End > 0 && segment.End > segment.Start);
  }

  function isValidCredits(segment) {
    if (!isValidSegment(segment)) return false;
    const runtimeSeconds = (item.RunTimeTicks || 0) / TICKS_PER_SECOND;
    return !runtimeSeconds || segment.Start >= runtimeSeconds * 0.5;
  }

  function mergeSkipSegments(current, candidate) {
    if (!candidate) return current;
    return {
      Introduction: isValidSegment(current && current.Introduction) ? current.Introduction : candidate.Introduction,
      Credits: isValidCredits(current && current.Credits)
        ? current.Credits
        : isValidCredits(candidate.Credits) ? candidate.Credits : { Start: 0, End: 0 },
    };
  }

  function segmentsComplete(segments) {
    return !!(segments && isValidSegment(segments.Introduction) && isValidCredits(segments.Credits));
  }

  getCommunitySkipSegments(itemId).then(function (community) {
    skipSegments = mergeSkipSegments(skipSegments, community);
    if (segmentsComplete(skipSegments)) return;

    getIntroSkipperSegments(itemId).then(function (result) {
      skipSegments = mergeSkipSegments(skipSegments, result);
      if (segmentsComplete(skipSegments)) return;

      const fromChapters = chapterFallbackSegments(item.Chapters, item.RunTimeTicks);
      skipSegments = mergeSkipSegments(skipSegments, fromChapters);
      if (segmentsComplete(skipSegments)) return;

      getJellioIntroCredits(itemId).then(function (analyzed) {
        skipSegments = mergeSkipSegments(skipSegments, analyzed);
      });
    });
  });

  root.appendChild(video);
  showLoadingLogo();
  root.appendChild(pauseOverlay);
  root.appendChild(syncWaitBanner);
  root.appendChild(skipOverlay.overlay);
  root.appendChild(shell);
  if (pip) root.insertBefore(pip.placeholder, shell);

  if (hasResumePosition) {
    const percent =
      item.UserData && item.UserData.PlayedPercentage != null
        ? Math.round(item.UserData.PlayedPercentage)
        : null;
    const resumePrompt = buildResumePrompt(
      percent,
      function () {
        resumePrompt.overlay.remove();
        waitForPlayableBuffer(attemptPlay);
      },
      function () {
        resumePrompt.overlay.remove();
        hasReportedStart = false;
        getPlaybackInfo(itemId, 0, mediaSource.Id, currentAudioStreamIndex)
          .then(function (info) {
            const negotiated = pickNegotiatedSource(info, mediaSource.Id);
            if (!negotiated) {
              showPlayerToast('Could not start over, that stream is no longer available.');
              return;
            }
            mediaSource = negotiated;
            playSessionId = info.PlaySessionId;
            streamOffsetTicks = 0;
            needsStartOffset = false;
            pendingNativeSeekSeconds = null;
            video.src = buildStreamUrl(itemId, mediaSource, 0, {
              audioStreamIndex: currentAudioStreamIndex,
              forceTranscode: true,
              playSessionId: playSessionId,
            });
            video.load();
            showLoadingLogo();
            waitForPlayableBuffer(attemptPlay);
          })
          .catch(function (err) {
            console.warn('Jellio: could not start over', err);
            showPlayerToast('Could not start over: ' + (err && err.message ? err.message : err));
          });
      },
    );
    root.appendChild(resumePrompt.overlay);
    resumePrompt.resumeButton.focus();
  } else if ((!syncPlaylistItemId && !getCurrentGroup()) || initialSyncTarget.isPlaying) {
    waitForPlayableBuffer(attemptPlay);
  }

  let nextEpisode = null;
  let upNextOverlay = null;
  let upNextPlayButton = null;
  let upNextShown = false;
  let upNextDismissed = false;
  let upNextCountdownInterval = null;
  let upNextCountdownRemaining = getUpNextCountdownSeconds();
  let isNavigatingNext = false;
  let endScreenModalInstance = null;

  function activeAudioLanguageCode() {
    if (!mediaSource) return null;
    const audioStreams = (mediaSource.MediaStreams || []).filter(function (stream) {
      return stream.Type === 'Audio';
    });
    const wantedIndex = currentAudioStreamIndex != null ? currentAudioStreamIndex : mediaSource.DefaultAudioStreamIndex;
    const active = audioStreams.find(function (stream) {
      return stream.Index === wantedIndex;
    });
    return active && active.Language ? active.Language.toLowerCase() : null;
  }

  let preloadedNextMediaSourceId = null;
  let preloadedNextVideoEl = null;
  let hasInitiatedNextPreload = false;

  function preloadNextEpisodeStream() {
    if (hasInitiatedNextPreload || !nextEpisode || screenTornDown) return;
    hasInitiatedNextPreload = true;
    const target = nextEpisode;
    const languageCode = activeAudioLanguageCode();
    getMediaSources(target.Id)
      .then(async function (sources) {
        if (screenTornDown || !sources || !sources.length) return;
        let matched = null;
        if (languageCode) {
          matched = sources.find(function (source) {
            return sourceAudioLanguages(source).indexOf(languageCode) !== -1;
          });
        }
        const source = matched || sources[0];
        if (source) {
          preloadedNextMediaSourceId = source.Id;
          try {
            const info = await getPlaybackInfo(target.Id, 0, source.Id);
            if (!screenTornDown && info && info.MediaSources && info.MediaSources[0]) {
              const nextSource = info.MediaSources[0];
              if (!preloadedNextVideoEl) {
                preloadedNextVideoEl = document.createElement('video');
                preloadedNextVideoEl.preload = 'auto';
                preloadedNextVideoEl.muted = true;
                preloadedNextVideoEl.playsInline = true;
                preloadedNextVideoEl.src = buildStreamUrl(target.Id, nextSource, 0, {
                  playSessionId: info.PlaySessionId,
                });
              }
            }
          } catch (e) {
            // Silently ignore preload network failures
          }
        }
      })
      .catch(function () {});
  }

  async function playNextEpisode() {
    if (isNavigatingNext) return;
    isNavigatingNext = true;
    if (upNextCountdownInterval) {
      window.clearInterval(upNextCountdownInterval);
      upNextCountdownInterval = null;
    }
    if (endScreenModalInstance) {
      endScreenModalInstance.cleanup();
      endScreenModalInstance = null;
    }
    const target = nextEpisode;
    if (!target) return;
    nextEpisode = null;

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

    if (preloadedNextVideoEl) {
      try {
        preloadedNextVideoEl.src = '';
        preloadedNextVideoEl.load();
      } catch (e) {}
      preloadedNextVideoEl = null;
    }

    navigateTo(playHash(target.Id, mediaSourceId));
  }

  function replayCurrentItem() {
    if (endScreenModalInstance) {
      endScreenModalInstance.cleanup();
      endScreenModalInstance = null;
    }
    hasReportedStart = false;
    if (streamOffsetTicks > 0 || needsStartOffset) {
      getPlaybackInfo(itemId, 0, mediaSource ? mediaSource.Id : null, currentAudioStreamIndex)
        .then(function (info) {
          const negotiated = info && info.MediaSources && info.MediaSources[0];
          if (negotiated) {
            mediaSource = negotiated;
            playSessionId = info.PlaySessionId;
            streamOffsetTicks = 0;
            needsStartOffset = false;
            pendingNativeSeekSeconds = null;
            video.src = buildStreamUrl(itemId, mediaSource, 0, {
              audioStreamIndex: currentAudioStreamIndex,
              forceTranscode: true,
              playSessionId: playSessionId,
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
    if (endScreenModalInstance || isNavigatingNext) return;
    hideUpNext();

    const countdownSetting = getUpNextCountdownSeconds();
    const shouldCountdown = !upNextDismissed && countdownSetting > 0;
    const initialCountdown = shouldCountdown
      ? (upNextShown && upNextCountdownRemaining > 0 ? upNextCountdownRemaining : countdownSetting)
      : null;

    endScreenModalInstance = buildEndScreenModal({
      item: item,
      nextEpisode: nextEpisode,
      onPlayNext: function () {
        if (endScreenModalInstance) {
          endScreenModalInstance.cleanup();
          endScreenModalInstance = null;
        }
        playNextEpisode();
      },
      onReplay: function () {
        if (endScreenModalInstance) {
          endScreenModalInstance.cleanup();
          endScreenModalInstance = null;
        }
        replayCurrentItem();
      },
      onClose: function () {
        if (endScreenModalInstance) {
          endScreenModalInstance.cleanup();
          endScreenModalInstance = null;
        }
      },
      onBack: function () {
        if (endScreenModalInstance) {
          endScreenModalInstance.cleanup();
          endScreenModalInstance = null;
        }
        if (item.SeriesId) {
          navigateTo('#/item?id=' + item.SeriesId);
        } else {
          navigateTo('#/home');
        }
      },
      initialCountdown: initialCountdown,
    });

    root.appendChild(endScreenModalInstance.overlay);
    if (endScreenModalInstance.primaryBtn) {
      endScreenModalInstance.primaryBtn.focus();
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
    if (upNextShown || upNextDismissed || !upNextOverlay) return;
    upNextShown = true;
    preloadNextEpisodeStream();
    markRealWatchComplete();
    reportRealDurationIfUseful(currentPositionTicks() / TICKS_PER_SECOND);
    upNextOverlay.classList.remove('jellio-player-upnext-hidden');
    const countdownSecs = getUpNextCountdownSeconds();
    if (countdownSecs > 0) {
      upNextCountdownRemaining = countdownSecs;
      updateUpNextCountdown();
      upNextCountdownInterval = window.setInterval(function () {
        upNextCountdownRemaining -= 1;
        updateUpNextCountdown();
        if (upNextCountdownRemaining <= 0) {
          window.clearInterval(upNextCountdownInterval);
          upNextCountdownInterval = null;
          playNextEpisode();
        }
      }, 1000);
    } else {
      upNextCountdownRemaining = 0;
      updateUpNextCountdown();
    }
  }

  function hideUpNext() {
    if (upNextCountdownInterval) {
      window.clearInterval(upNextCountdownInterval);
      upNextCountdownInterval = null;
    }
    upNextShown = false;
    if (upNextOverlay) upNextOverlay.classList.add('jellio-player-upnext-hidden');
  }

  function dismissUpNext() {
    hideUpNext();
    upNextDismissed = true;
  }

  if (item.Type === 'Episode') {
    getNextEpisode(item)
      .then(function (result) {
        if (!result) return;
        nextEpisode = result;
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

  let hasReportedStart = false;

  const START_TIMEOUT_MS =
    avoidingVideoTranscodes() && sourceClassification.needsVideoTranscode
      ? Math.max(prebufferSettings().startTimeoutMs, 12000)
      : 25000;
  const failoverLanguage = params.get('lang') || '';
  let failoverStarted = false;
  let startTimer = null;
  const expectedRuntimeSeconds = item && item.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_SECOND : 0;

  async function streamLanguage() {
    if (failoverLanguage) return failoverLanguage;
    let audioPreference = '';
    try {
      const user = await currentUserPromise;
      audioPreference = (user && user.Configuration && user.Configuration.AudioLanguagePreference) || '';
    } catch (err) {}
    return preferredStreamLanguage(audioPreference, getDisplayLanguage());
  }

  // The streams left to try, in the order to try them.
  async function nextStreams(tried, language) {
    let sources = [];
    try {
      sources = await getMediaSources(itemId, { forceFresh: true });
    } catch (err) {}
    const candidates = sources.filter(function (source) {
      return tried.indexOf(source.Id) === -1 && !isBadSource(itemId, source);
    });
    function byLanguage(list) {
      return orderByLanguage(list, language, sourceAudioLanguages);
    }
    let ordered = byLanguage(candidates);
    if (avoidingVideoTranscodes()) {
      const needsReencode = function (source) {
        return !!videoInfoOf(source) && classifySource(source, canBrowserDirectPlay(source)).needsVideoTranscode;
      };
      const copyable = candidates.filter(function (source) {
        return !needsReencode(source);
      });
      const reencode = getVideoTranscodePolicy() === 'Block' ? [] : candidates.filter(needsReencode);
      ordered = byLanguage(copyable).concat(byLanguage(reencode));
    }
    return ordered;
  }

  async function failoverToNextStream(reason) {
    if (failoverStarted || screenTornDown || getCurrentGroup()) return false;
    failoverStarted = true;
    if (startTimer) window.clearTimeout(startTimer);
    console.warn('Jellio: stream failed (' + reason + '), trying the next one', mediaSource && mediaSource.Id);
    markBadSource(itemId, mediaSource, { soft: /^(no picture after|placeholder: stalled)/.test(reason) });
    const tried = failoverTried.concat(mediaSource && mediaSource.Id ? [mediaSource.Id] : []);
    const language = await streamLanguage();
    const ordered = await nextStreams(tried, language);
    if (screenTornDown) return true;
    if (!ordered.length) {
      cleanup();
      renderPlaybackError(
        root,
        itemId,
        tried.length > 1
          ? 'None of the ' + tried.length + ' streams tried for this title worked. Try again later or pick one from Change Stream.'
          : 'This stream could not be played and there is no other one to try. Pick one from Change Stream or try again later.',
      );
      return true;
    }
    navigateTo(
      playHash(itemId, ordered[0].Id) +
        '&tried=' + encodeURIComponent(tried.join(',')) +
        (language ? '&lang=' + encodeURIComponent(language) : ''),
    );
    return true;
  }

  // Update the failover overlay label once the negotiated mediaSource is known.
  if (failoverOverlay && mediaSource) {
    const textEl = failoverOverlay.querySelector('.jellio-player-failover-text');
    if (textEl) {
      textEl.textContent = t('player_failover_attempt', { attempt: failoverTried.length + 1, label: sourceLabel(mediaSource) });
    }
    const stop = failoverOverlay.querySelector('.jellio-player-failover-stop');
    if (stop) {
      stop.onclick = function () {
        failoverStarted = true;
        screenTornDown = true;
        if (startTimer) window.clearTimeout(startTimer);
        cleanup();
        navigateTo('#/item?id=' + itemId);
      };
    }
  }

  function hideFailoverOverlay() {
    if (!failoverOverlay) return;
    failoverOverlay.remove();
    failoverOverlay = null;
    showPlayerToast('Now playing: ' + sourceLabel(mediaSource));
  }

  // No picture within START_TIMEOUT_MS of the first play attempt.
  function armStartTimer() {
    if (startTimer || failoverStarted) return;
    startTimer = window.setTimeout(function () {
      startTimer = null;
      if (screenTornDown || hasReportedStart || video.readyState >= 3) return;
      failoverToNextStream('no picture after ' + START_TIMEOUT_MS / 1000 + 's');
    }, START_TIMEOUT_MS);
  }

  // The served file's own length against the title's runtime. Only for a
  // file played as is: a transcode's or HLS stream's duration grows as it encodes.
  function checkForPlaceholder() {
    if (failoverStarted || streamIsTranscoded || supportsNativeHls()) return;
    if (looksLikePlaceholder(video.duration, expectedRuntimeSeconds)) {
      failoverToNextStream('placeholder clip of ' + Math.round(video.duration) + 's');
    }
  }
  video.addEventListener('loadedmetadata', checkForPlaceholder);
  video.addEventListener('durationchange', checkForPlaceholder);

  // The same clip behind a remux or HLS reports the title's full length, so
  // these watch what actually plays instead, on every path.
  function flagPlaceholder(reason) {
    if (failoverStarted || screenTornDown || getCurrentGroup()) return;
    const key = itemId + '|' + (mediaSource && mediaSource.Id);
    if (placeholderFlagged.has(key)) return;
    placeholderFlagged.add(key);
    failoverToNextStream(reason);
  }

  let slideshowTimer = null;
  function armSlideshowCheck(attempt) {
    if (expectedRuntimeSeconds < 600 || typeof video.getVideoPlaybackQuality !== 'function') return;
    const tries = attempt || 0;
    slideshowTimer = window.setTimeout(function () {
      if (screenTornDown || failoverStarted) return;
      const sampledAt = Date.now();
      const startFrames = video.getVideoPlaybackQuality().totalVideoFrames;
      const startTime = video.currentTime;
      slideshowTimer = window.setTimeout(function () {
        if (screenTornDown || failoverStarted) return;
        const seconds = video.currentTime - startTime;
        const frames = video.getVideoPlaybackQuality().totalVideoFrames - startFrames;
        if (lastUserSeekAt >= sampledAt || seconds < 3 || seconds > 12) {
          if (tries < 3) armSlideshowCheck(tries + 1);
          return;
        }
        if (looksLikeSilentSlideshow(frames, seconds, hasNoAudio(video), expectedRuntimeSeconds)) {
          flagPlaceholder('placeholder: 1 fps, no audio');
        }
      }, 6000);
    }, 1000);
  }

  let earlyStallTimer = null;
  function clearEarlyStall() {
    if (earlyStallTimer) window.clearTimeout(earlyStallTimer);
    earlyStallTimer = null;
  }
  video.addEventListener('waiting', function () {
    if (!hasReportedStart || video.paused || earlyStallTimer || Date.now() - lastUserSeekAt < 4000) return;
    earlyStallTimer = window.setTimeout(function () {
      earlyStallTimer = null;
      if (screenTornDown || video.paused || video.readyState >= 3) return;
      const position = streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0);
      if (stoppedTooEarly(position, expectedRuntimeSeconds)) {
        flagPlaceholder('placeholder: stalled ' + PLACEHOLDER_STALL_MS / 1000 + 's at ' + Math.round(position) + 's');
      }
    }, PLACEHOLDER_STALL_MS);
  });
  ['playing', 'pause', 'seeking', 'emptied'].forEach(function (type) {
    video.addEventListener(type, clearEarlyStall);
  });
  function hideFailoverIfPlaying() {
    if (failoverOverlay && !video.paused && video.currentTime > 0 && video.readyState >= 2) hideFailoverOverlay();
  }
  video.addEventListener('timeupdate', hideFailoverIfPlaying);
  video.addEventListener('playing', hideFailoverIfPlaying);
  if (failoverOverlay) {
    let lastSeen = { element: null, time: 0 };
    const failoverWatch = window.setInterval(function () {
      if (!failoverOverlay || screenTornDown) {
        window.clearInterval(failoverWatch);
        return;
      }
      const current = root.querySelector('video') || video;
      if (lastSeen.element === current && !current.paused && current.currentTime > lastSeen.time + 0.3) {
        hideFailoverOverlay();
        window.clearInterval(failoverWatch);
        return;
      }
      lastSeen = { element: current, time: current.currentTime };
    }, 1000);
  }
  let hasCreditedGroupWatch = false;
  let hasCreditedRealWatch = false;
  let lastReportedDurationSeconds = 0;
  function reportRealDurationIfUseful(candidateSeconds, exact) {
    if (!candidateSeconds || !isFinite(candidateSeconds) || candidateSeconds <= 0) return;
    if (candidateSeconds < lastReportedDurationSeconds + 5) return;
    lastReportedDurationSeconds = candidateSeconds;
    reportRealDuration(itemId, candidateSeconds * TICKS_PER_SECOND, exact).catch(function () {
    });
  }

  function markRealWatchComplete() {
    if (hasCreditedRealWatch) return;
    hasCreditedRealWatch = true;
    creditRealWatch(itemId).catch(function () {
    });
    setPlayed(itemId, true).catch(function () {
    });
    if (isAutoDeleteWatchedEnabled()) {
      findAnyDownload(itemId)
        .then((record) => (record ? removeDownload(record.Id) : null))
        .catch(() => null);
    }
    const seriesId = item && item.SeriesId;
    if (seriesId) {
      const key = 's:' + String(seriesId).replace(/-/g, '').toLowerCase();
      const epNum = typeof item.IndexNumber === 'number' ? item.IndexNumber : null;
      if (epNum && epNum > 0) {
        syncTracker(key, null, epNum);
      }
    }
  }
  let seeking = false;
  let lastReportedTicks = startTicks;

  function currentPositionTicks() {
    return streamOffsetTicks + Math.round((video.currentTime || 0) * TICKS_PER_SECOND);
  }

  let durationProbeRequested = false;
  function requestProbedDuration() {
    if (durationProbeRequested || videoDurationIsFinal()) return;
    durationProbeRequested = true;
    probeRealDuration(itemId)
      .then(function (ticks) {
        if (!ticks || screenTornDown) return;
        fallbackDurationSeconds = ticks / TICKS_PER_SECOND;
        if (!videoDurationIsFinal()) {
          durationSeconds = fallbackDurationSeconds;
          paintDuration();
        }
      })
      .catch(function () {
        // The library's own length (or none) stays in use.
      });
  }

  function reconcileDuration() {
    const real = video.duration;
    if (!(real && isFinite(real) && real > 0)) return;
    // A length that keeps growing while it plays is not a length, even
    // on a stream that looked final.
    if (lastVideoDuration && real > lastVideoDuration + 1 && (video.currentTime || 0) > 5) {
      videoDurationStrikes += 1;
      if (videoDurationStrikes >= 3 && !videoDurationGrowing) {
        videoDurationGrowing = true;
        durationSeconds = fallbackDurationSeconds;
        paintDuration();
        requestProbedDuration();
      }
    }
    lastVideoDuration = real;
    if (!videoDurationIsFinal()) return;
    durationSeconds = streamOffsetTicks / TICKS_PER_SECOND + real;
    paintDuration();
    reportRealDurationIfUseful(durationSeconds, true);
  }

  let retriedWithTranscode = false;
  video.addEventListener('error', function () {
    if (screenTornDown) return;
    var mediaError = video.error;
    console.error(
      'Jellio: video error',
      mediaError ? 'code=' + mediaError.code + (mediaError.message ? ' message=' + mediaError.message : ' (no message)') : '(no MediaError on the element)',
      'src=' + video.currentSrc,
    );
    if (hasReportedStart) {
      showPlayerToast('Playback stopped unexpectedly. Try a different stream.');
      return;
    }
    if (!streamIsTranscoded && !retriedWithTranscode && !failoverStarted && getVideoTranscodePolicy() !== 'Block') {
      retriedWithTranscode = true;
      streamIsTranscoded = true;
      if (startTimer) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      showLoadingLogo();
      getPlaybackInfo(itemId, startTicks, mediaSource.Id, currentAudioStreamIndex)
        .then(function (info) {
          if (screenTornDown || failoverStarted) return;
          const negotiated = pickNegotiatedSource(info, mediaSource.Id);
          if (negotiated) {
            mediaSource = negotiated;
            playSessionId = info.PlaySessionId;
          }
          const fallbackUsesHls = willUseHls(mediaSource, true);
          needsStartOffset = !fallbackUsesHls;
          streamOffsetTicks = needsStartOffset ? startTicks : 0;
          pendingNativeSeekSeconds = fallbackUsesHls && startTicks > 0 ? startTicks / TICKS_PER_SECOND : null;
          video.src = buildStreamUrl(itemId, mediaSource, startTicks, {
            audioStreamIndex: currentAudioStreamIndex,
            forceTranscode: true,
            playSessionId: playSessionId,
          });
          video.load();
          showLoadingLogo();
          waitForPlayableBuffer(attemptPlay);
        })
        .catch(function () {
          if (screenTornDown || failoverStarted) return;
          failoverToNextStream('transcode fallback negotiation failed').then(function (handled) {
            if (handled) return;
            cleanup();
            renderPlaybackError(
              root,
              itemId,
              'This stream could not be played. Try a different one from Change Stream.',
            );
          });
        });
      return;
    }
    failoverToNextStream('error before the first frame').then(function (handled) {
      if (handled) return;
      cleanup();
      renderPlaybackError(
        root,
        itemId,
        'This stream could not be played. Try a different one from Change Stream.',
      );
    });
  });

  video.addEventListener('loadedmetadata', function () {
    if (pendingNativeSeekSeconds != null) {
      video.currentTime = pendingNativeSeekSeconds;
      pendingNativeSeekSeconds = null;
    }
    reconcileDuration();
    paintDuration();
  });

  video.addEventListener('durationchange', reconcileDuration);

  video.addEventListener('ended', function () {
    if (!hasReportedStart) return;
    // Ending far short of the runtime is a placeholder clip, not the end
    // of the title: no end screen, no watched mark, try the next stream.
    const endedAtSeconds = streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0);
    if ((looksLikePlaceholder(endedAtSeconds, expectedRuntimeSeconds) || stoppedTooEarly(endedAtSeconds, expectedRuntimeSeconds)) && !getCurrentGroup()) {
      flagPlaceholder('placeholder: ended after ' + Math.round(endedAtSeconds) + 's');
      if (failoverStarted) return;
    }
    reportRealDurationIfUseful(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0), true);
    markRealWatchComplete();
    showEndScreenModal();
  });

  video.addEventListener('timeupdate', function () {
    if (seeking) return;
    const positionSeconds = streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0);
    if (durationSeconds) {
      seekBar.value = String((positionSeconds / durationSeconds) * 100);
    }
    currentTimeLabel.textContent = formatTime(positionSeconds);
    syncMediaPosition();

    if (!hasReportedStart) {
      hasReportedStart = true;
      armSlideshowCheck();
      unmarkBadSource(itemId, mediaSource);
      reportPlaybackStart(itemId, mediaSource.Id, currentPositionTicks());
      requestProbedDuration();
      if (deferredAutoSubtitleStream) {
        const sub = deferredAutoSubtitleStream;
        deferredAutoSubtitleStream = null;
        if (activeSubtitleStreamIndex === sub.Index && !activeTrack) {
          attachSubtitleTrack(sub, 0);
        }
      }
    }

    const activeGroup = getCurrentGroup();
    if (
      !hasCreditedGroupWatch &&
      durationSeconds &&
      positionSeconds / durationSeconds >= GROUP_WATCH_COMPLETION_THRESHOLD &&
      activeGroup &&
      (activeGroup.Participants || []).length >= 2
    ) {
      hasCreditedGroupWatch = true;
      creditGroupWatchTogether().catch(function () {
      });
    }

    if (!hasCreditedRealWatch && durationSeconds && positionSeconds / durationSeconds >= REAL_WATCH_COMPLETION_THRESHOLD) {
      markRealWatchComplete();
    }

    if (nextEpisode && !hasInitiatedNextPreload && durationSeconds > 60 && positionSeconds >= durationSeconds - 55) {
      preloadNextEpisodeStream();
    }

    if (nextEpisode && !upNextShown && !upNextDismissed && shouldShowUpNextNow(positionSeconds, durationSeconds)) {
      if (sleepTimerEpisodesRemaining != null) {
        sleepTimerEpisodesRemaining -= 1;
        if (sleepTimerEpisodesRemaining <= 0) {
          sleepTimerEpisodesRemaining = null;
          syncSleepActive(false);
          dismissUpNext();
        } else {
          showUpNext();
        }
      } else {
        showUpNext();
      }
    }

    const activeSegment = activeSkipSegment(positionSeconds);
    if (activeSegment && activeSegment.eyebrow !== dismissedSkipKind) {
      dismissedSkipKind = null;
    }
    if (activeSegment && !upNextShown && activeSegment.eyebrow !== dismissedSkipKind) {
      if (autoSkipEnabled && activeSegment.eyebrow === 'Introduction') {
        dismissedSkipKind = activeSegment.eyebrow;
        skipOverlay.overlay.classList.add('jellio-player-skip-hidden');
        performSeek(activeSegment.target);
        showPlayerToast('Skipped Intro');
        return;
      }
      skipTargetSeconds = activeSegment.target;
      skipOverlay.eyebrowEl.textContent = activeSegment.eyebrow;
      skipOverlay.titleEl.textContent = activeSegment.label;
      skipOverlay.overlay.classList.remove('jellio-player-skip-hidden');
    } else {
      skipOverlay.overlay.classList.add('jellio-player-skip-hidden');
    }
  });

  seekBar.addEventListener('input', function () {
    seeking = true;
    if (durationSeconds) {
      const target = (Number(seekBar.value) / 100) * durationSeconds;
      currentTimeLabel.textContent = formatTime(target);
    }
  });
  seekBar.addEventListener('change', function () {
    if (durationSeconds) {
      performSeek((Number(seekBar.value) / 100) * durationSeconds);
    }
    seeking = false;
  });

  video.addEventListener('play', function () {
    stallHold = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    playPauseIcon.className = 'material-icons pause';
    playPauseButton.setAttribute('aria-label', t('action_pause'));
    pauseOverlay.classList.remove('jellio-player-pause-overlay-visible');
  });
  video.addEventListener('pause', function () {
    if (stallHold) return;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    playPauseIcon.className = 'material-icons play_arrow';
    playPauseButton.setAttribute('aria-label', t('action_play'));
    // Ending playback also fires pause, the overlay would just be in the
    // way of whatever screen comes next rather than useful here.
    if (hasReportedStart && !video.ended) {
      pauseOverlay.classList.add('jellio-player-pause-overlay-visible');
    }
  });

  const pauseGate = createPauseGate(PAUSE_IDLE_STOP_MS);
  const progressInterval = startProgressTimer(function () {
    if (screenTornDown) {
      stopProgressTimer(progressInterval);
      return;
    }
    if (!hasReportedStart) return;
    lastReportedTicks = currentPositionTicks();
    const action = pauseGate.tick(video.paused, Date.now());
    if (action === 'progress') {
      reportPlaybackProgress(itemId, mediaSource.Id, lastReportedTicks, video.paused);
    } else if (action === 'stop') {
      reportPlaybackStopped(itemId, mediaSource.Id, lastReportedTicks);
      hasReportedStart = false;
    }
  }, PROGRESS_REPORT_MS);

  const SYNC_DRIFT_THRESHOLD_SECONDS = 1.5;
  let scheduledSyncTimeout = null;
  function clearScheduledSync() {
    if (scheduledSyncTimeout) {
      window.clearTimeout(scheduledSyncTimeout);
      scheduledSyncTimeout = null;
    }
  }

  function syncDriftSeconds(command) {
    const targetTicks = estimateCurrentTicks(command.PositionTicks || 0, command.When);
    return Math.abs(currentPositionTicks() - targetTicks) / TICKS_PER_SECOND;
  }

  // Every command bumps this; work a command left waiting (a reload, a
  // buffer wait) checks it so a newer command always wins.
  let syncGeneration = 0;
  let lastAppliedSyncCommand = null;

  function syncSeekThenReady(targetSeconds, generation) {
    const playlistItemId = syncPlaylistItemId;
    video.pause();
    notifyBuffering(currentPositionTicks(), false, playlistItemId).catch(function () {});
    seekToAbsoluteSeconds(Math.max(0, targetSeconds)).then(function () {
      waitForPlayableBuffer(function () {
        if (generation !== syncGeneration || playlistItemId !== syncPlaylistItemId) return;
        notifyReady(currentPositionTicks(), false, playlistItemId).catch(function () {});
      });
    });
  }

  function applySyncCommand(command) {
    if (command.PlaylistItemId !== syncPlaylistItemId) return;
    lastAppliedSyncCommand = command;
    clearScheduledSync();
    const generation = ++syncGeneration;

    function run() {
      if (generation !== syncGeneration) return;
      switch (command.Command) {
        case 'Unpause':
          if (syncDriftSeconds(command) > SYNC_DRIFT_THRESHOLD_SECONDS) {
            syncSeekThenReady(estimateCurrentTicks(command.PositionTicks || 0, command.When) / TICKS_PER_SECOND, generation);
          } else {
            attemptPlay();
          }
          break;
        case 'Pause':
          video.pause();
          if (syncDriftSeconds(command) > SYNC_DRIFT_THRESHOLD_SECONDS) {
            seekToAbsoluteSeconds(Math.max(0, (command.PositionTicks || 0) / TICKS_PER_SECOND));
          }
          break;
        case 'Seek':
          // The server waits for every member's Ready after a seek; a seek
          // inside the buffer fires no canplay, so Ready is sent here.
          syncSeekThenReady((command.PositionTicks || 0) / TICKS_PER_SECOND, generation);
          break;
        case 'Stop':
          video.pause();
          break;
        default:
          break;
      }
    }

    const delay = remoteToLocal(command.When).getTime() - Date.now();
    if (delay > 0) {
      scheduledSyncTimeout = window.setTimeout(run, delay);
    } else {
      run();
    }
  }

  let unsubscribeSyncCommand = null;
  let unsubscribeSyncGroupChange = null;
  let syncQueuePublishAttempted = false;
  console.debug('Jellio: player sync check, group is', getCurrentGroup(), 'syncPlaylistItemId is', syncPlaylistItemId);

  unsubscribeSyncCommand = onSyncCommand(applySyncCommand);

  partyLayer = createPartyLayer({
    root: root,
    itemId: itemId,
    getPlaylistItemId: function () {
      return syncPlaylistItemId;
    },
    getPositionTicks: currentPositionTicks,
    getUserId: getSyncUserId,
    toast: showPlayerToast,
  });

  // Joining well into the group's title: follow the group or start alone.
  if (isInitialGroupCatchUp && startTicks > 120 * TICKS_PER_SECOND) {
    askCatchUp(root, startTicks / TICKS_PER_SECOND).then(function (choice) {
      if (choice !== 'solo' || screenTornDown) return;
      if (joinSyncGroupId) clearJoinSync(joinSyncGroupId).catch(function () {});
      leaveSyncGroup()
        .catch(function () {})
        .then(function () {
          navigateTo('#/play?id=' + encodeURIComponent(itemId) + '&fromStart=1');
        });
    });
  }

  function maybePublishQueue() {
    if (syncQueuePublishAttempted || !getCurrentGroup() || isGroupJoinNavigation) return;
    syncQueuePublishAttempted = true;
    publishSyncQueue(itemId, startTicks)
      .then(function () {
        console.debug('Jellio: published Group Watch queue for', itemId);
        const syncGroup = getCurrentGroup();
        if (syncGroup) {
          const watchingName = isEpisodeItem ? item.SeriesName : item.Name;
          sendGroupWatchMessage(syncGroup.GroupId, 'The group started watching ' + (watchingName || 'something'), itemId).catch(function () {});
        }
        if (!(partyLayer && partyLayer.published())) {
          waitForPlayableBuffer(function () {
            requestSyncUnpause().catch(function (err) {
              console.warn('Jellio: could not send initial Group Watch unpause', err);
            });
          });
        }
        window.setTimeout(function () {
          if (!syncPlaylistItemId) {
            showPlayerToast('Group Watch could not sync this. Check everyone in the group has library access to this title.');
          }
        }, 6000);
      })
      .catch(function (err) {
        console.warn('Jellio: could not publish Group Watch queue', err);
      });
  }

  unsubscribeSyncGroupChange = onSyncGroupChange(function () {
    const target = getCurrentPlaylistTarget();
    const previousPlaylistItemId = syncPlaylistItemId;
    syncPlaylistItemId = target && sameSyncId(target.itemId, itemId) ? target.playlistItemId : null;
    // A command for this queue item can arrive before this player knew it
    // was the group's: apply the last one now instead of losing it.
    if (syncPlaylistItemId && syncPlaylistItemId !== previousPlaylistItemId) {
      const missed = getLastSyncCommand();
      if (missed && missed !== lastAppliedSyncCommand && missed.PlaylistItemId === syncPlaylistItemId
        && Date.now() - remoteToLocal(missed.When).getTime() < 60000) {
        applySyncCommand(missed);
      }
    }
    if (syncPlaylistItemId && video.readyState >= 3) {
      notifyReady(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
      if (partyLayer) partyLayer.markReady(syncPlaylistItemId);
    } else if (syncPlaylistItemId && !joinSyncActive && target && target.isPlaying) {
      joinSyncActive = true;
      joinSyncGroupId = getCurrentGroup().GroupId;
      notifyBuffering(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
      startJoinSync(joinSyncGroupId, syncPlaylistItemId).catch(function () {});
    }
    maybePublishQueue();
  });

  maybePublishQueue();

  video.addEventListener('waiting', function () {
    const stallSeconds = prebufferSettings().stallSeconds;
    if (!stallSeconds || syncPlaylistItemId || stallHold || video.paused || !hasReportedStart) return;
    stallHold = true;
    video.pause();
    waitForPlayableBuffer(
      function () {
        if (!stallHold) return;
        stallHold = false;
        attemptPlay();
      },
      stallSeconds,
      prebufferSettings().stallTimeoutMs,
    );
  });
  video.addEventListener('waiting', function () {
    if (!syncPlaylistItemId) return;
    notifyBuffering(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
  });

  // A stream that keeps stopping to buffer: offer the next one (or switch
  // straight away when that's the setting), resuming at the same spot.
  const BUFFER_WINDOW_MS = 120000;
  const BUFFER_STALL_TOTAL_MS = 12000;
  const BUFFER_STALL_COUNT = 4;
  const BUFFER_PROMPT_SNOOZE_MS = 10 * 60000;
  const bufferStalls = [];
  let bufferStallStartedAt = 0;
  let bufferStallTimer = null;
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
    const ongoing = bufferStallStartedAt ? now - bufferStallStartedAt : 0;
    const total = stalls.reduce(function (sum, stall) {
      return sum + stall.ms;
    }, ongoing);
    const count = stalls.length + (bufferStallStartedAt ? 1 : 0);
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
    if (bufferSwitching || screenTornDown || getCurrentGroup()) return;
    bufferSwitching = true;
    const tried = failoverTried.concat(mediaSource && mediaSource.Id ? [mediaSource.Id] : []);
    const language = await streamLanguage();
    const ordered = await nextStreams(tried, language);
    if (screenTornDown) return;
    if (!ordered.length) {
      bufferSwitching = false;
      bufferPromptSnoozedUntil = Date.now() + BUFFER_PROMPT_SNOOZE_MS;
      showPlayerToast(t('player_buffer_no_other'));
      return;
    }
    markBadSource(itemId, mediaSource, { soft: true });
    if (mediaSource && mediaSource.Id && failoverTried.indexOf(mediaSource.Id) === -1) failoverTried.push(mediaSource.Id);
    await switchSource(ordered[0]);
    bufferSwitching = false;
  }

  video.addEventListener('waiting', function () {
    if (!hasReportedStart || video.paused || syncPlaylistItemId || bufferStallStartedAt) return;
    if (Date.now() - lastUserSeekAt < 4000) return;
    bufferStallStartedAt = Date.now();
    if (bufferStallTimer) window.clearInterval(bufferStallTimer);
    bufferStallTimer = window.setInterval(function () {
      if (screenTornDown || !bufferStallStartedAt) {
        window.clearInterval(bufferStallTimer);
        bufferStallTimer = null;
        return;
      }
      checkBuffering();
    }, 1000);
  });
  video.addEventListener('playing', function () {
    if (!bufferStallStartedAt) return;
    bufferStalls.push({ at: Date.now(), ms: Date.now() - bufferStallStartedAt });
    bufferStallStartedAt = 0;
    if (bufferStallTimer) window.clearInterval(bufferStallTimer);
    bufferStallTimer = null;
    checkBuffering();
  });
  video.addEventListener('canplay', function () {
    if (!syncPlaylistItemId) return;
    notifyReady(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
    if (partyLayer) partyLayer.markReady(syncPlaylistItemId);
    if (joinSyncActive) {
      joinSyncActive = false;
      clearJoinSync(joinSyncGroupId).catch(function () {});
    }
  });

  const SYNC_WAIT_POLL_MS = 3000;
  let syncWaitVisible = false;
  function describeSyncWait(entries) {
    const names = entries.map(function (entry) {
      return entry.UserName || 'Someone';
    });
    if (names.length === 1) return 'Waiting for ' + names[0] + ' to finish loading in…';
    if (names.length === 2) return 'Waiting for ' + names[0] + ' and ' + names[1] + ' to finish loading in…';
    return 'Waiting for ' + names[0] + ' and ' + (names.length - 1) + ' others to finish loading in…';
  }
  function pollSyncWait() {
    const group = getCurrentGroup();
    if (!group || !syncPlaylistItemId) {
      if (syncWaitVisible) {
        syncWaitVisible = false;
        syncWaitBanner.classList.remove('jellio-player-sync-wait-visible');
      }
      return;
    }
    getJoinSync(group.GroupId, syncPlaylistItemId)
      .then(function (entries) {
        const myUserId = getSyncUserId();
        const others = (entries || []).filter(function (entry) {
          return entry.UserId !== myUserId;
        });
        if (others.length) {
          syncWaitText.textContent = describeSyncWait(others);
          syncWaitVisible = true;
          syncWaitBanner.classList.add('jellio-player-sync-wait-visible');
        } else if (syncWaitVisible) {
          syncWaitVisible = false;
          syncWaitBanner.classList.remove('jellio-player-sync-wait-visible');
        }
      })
      .catch(function () {});
  }
  const syncWaitPollTimer = window.setInterval(pollSyncWait, SYNC_WAIT_POLL_MS);
  pollSyncWait();

  async function cleanup() {
    if (overlayInsets) overlayInsets.disconnect();
    window.clearTimeout(slideshowTimer);
    clearEarlyStall();
    if (bufferStallTimer) window.clearInterval(bufferStallTimer);
    closeBufferPrompt();
    setPlaybackActive(false);
    holdAwake(false);
    document.removeEventListener('visibilitychange', onWakeVisibility);
    notifyNativePlayback(false);
    if (unsubscribeCast) unsubscribeCast();
    if (getActiveCast()) disconnectCast().catch(function () {});
    document.removeEventListener('visibilitychange', onTabVisibility);
    window.clearTimeout(frozenCheck);
    if (pip) pip.destroy();
    if (screenTornDown) return;
    screenTornDown = true;
    if (preloadedNextVideoEl) {
      try {
        preloadedNextVideoEl.src = '';
        preloadedNextVideoEl.load();
      } catch (e) {}
      preloadedNextVideoEl = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    window.clearInterval(logoWatchdog);
    document.removeEventListener('keydown', onPlayerKeydown);
    rootWakeEvents.forEach(function (eventName) {
      root.removeEventListener(eventName, onRootWake);
    });
    root.removeEventListener('dblclick', onPlayerDblClick);
    root.removeEventListener('wheel', onPlayerWheel);
    exitFullscreenOnCleanup();
    if ('mediaSession' in navigator && mediaSessionOwner === playerToken) {
      mediaSessionOwner = null;
      try {
        navigator.mediaSession.metadata = null;
        ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'stop', 'nexttrack', 'previoustrack'].forEach(function (act) {
          navigator.mediaSession.setActionHandler(act, null);
        });
        navigator.mediaSession.playbackState = 'none';
      } catch (e) {}
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      } catch (e) {}
    }
    if (syncPlaylistItemId) {
      requestSyncPause().catch(function () {});
    }
    if (joinSyncActive) {
      joinSyncActive = false;
      clearJoinSync(joinSyncGroupId).catch(function () {});
    }
    window.clearInterval(syncWaitPollTimer);
    clearScheduledSync();
    if (unsubscribeSyncCommand) unsubscribeSyncCommand();
    if (unsubscribeSyncGroupChange) unsubscribeSyncGroupChange();
    stopChatOnCleanup();
    if (partyLayer) partyLayer.destroy();
    video.textTracks.removeEventListener('change', enforceSubtitleTrackModes);
    if (subtitleStyleTag) {
      subtitleStyleTag.remove();
      subtitleStyleTag = null;
    }
    stopProgressTimer(progressInterval);
    if (upNextCountdownInterval) window.clearInterval(upNextCountdownInterval);
    if (endScreenModalInstance) {
      endScreenModalInstance.cleanup();
      endScreenModalInstance = null;
    }
    if (idleTimer) window.clearTimeout(idleTimer);
    if (hasReportedStart) {
      await reportPlaybackStopped(itemId, mediaSource.Id, hasCreditedRealWatch ? 0 : currentPositionTicks());
      invalidateHomeSections();
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  return cleanup;
}
