import { t, getDisplayLanguage } from '../runtime/i18n.js';
import { preferredStreamLanguage, orderByLanguage } from '../runtime/streamLanguage.js';
import { createPauseGate, startProgressTimer, stopProgressTimer, PAUSE_IDLE_STOP_MS } from '../runtime/playbackGuard.js';
import { attachPictureInPicture } from '../components/pictureInPicture.js';
import { isOffline, findAnyDownload, removeDownload, isAutoDeleteWatchedEnabled } from '../runtime/offline.js';
import { renderOfflinePlayer } from './offlinePlayer.js';
import {
  initGoogleCast,
  sendRemotePlayPause,
  sendRemoteSeek,
  sendRemoteVolume,
  disconnectCast,
  getActiveCast,
} from '../runtime/cast.js';
import { getItemDetails, getPlaybackInfo, getMediaSources, getLastMediaSources, logFailoverDecision, isPlaceholderSource, buildStreamUrl, canBrowserDirectPlay, loadVideoTranscodePolicy, logPlaybackDecision, supportsNativeHls, reportPlaybackStart, reportPlaybackProgress, reportPlaybackStopped, startSleepTimer, cancelSleepTimer, getSleepTimerStatus, getImageUrl, getAudioStreams, matchAudioStreamIndex, matchSubtitleStream, getCommunitySkipSegments, getIntroSkipperSegments, getJellioIntroCredits, getCurrentUser, TICKS_PER_SECOND, creditRealWatch, reportRealDuration, probeRealDuration, setPlayed, setPlaybackActive, autoCompletePreviousEpisodesIfSkipped } from '../runtime/api.js';
import { creditGroupWatchTogether, startJoinSync, clearJoinSync } from '../runtime/apiSocial.js';
import { syncTracker } from '../runtime/apiBooks.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { invalidateHome } from '../runtime/homeInvalidate.js';
import { markBadSource, unmarkBadSource, isBadSource, badSourceKind, looksLikePlaceholder, hasNoAudio, looksLikeSilentSlideshow, stoppedTooEarly, PLACEHOLDER_STALL_MS } from '../runtime/streamHealth.js';
import { avoidingVideoTranscodes, classifySource, describeTranscodeReason, getVideoTranscodePolicy } from '../runtime/transcodePolicy.js';
import { videoInfoOf } from '../runtime/transcodeClassifier.js';
import { loadFailoverSources, planFailover, failoverOutcome, describeFailover, isSourceNotReady } from '../runtime/failoverSources.js';
import { sourceLabel, sourceAudioLanguages, playHash } from '../components/streamPicker.js';
import { renderLoading } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { buildRatingBadge } from '../components/ratingBadge.js';
import {
  getCurrentGroup,
  getCurrentPlaylistTarget,
  notifyBuffering,
  notifyReady,
  requestSeek as requestSyncSeek,
  requestUnpause as requestSyncUnpause,
  requestPause as requestSyncPause,
  sameId as sameSyncId,
} from '../runtime/syncPlay.js';
import { el } from '../runtime/dom.js';
import { prebufferSettings, startBufferTarget } from '../runtime/bufferSettings.js';
import { cssUrl } from '../runtime/safeUrl.js';
import { loadVolumePreference, saveVolumePreference, loadSubtitleStyle, subtitleStyleTag, applySubtitleStyle } from '../runtime/playerPrefs.js';
import { buildResumePrompt, renderPlaybackError } from '../components/playerOverlays.js';
import { logPlayStart, getWarmSources, getCachedItemSync } from '../runtime/api.js';
import { prefetchedPlayback, prewarmedPlayback, negotiationFits } from '../runtime/playbackPrefetch.js';
import { createPlayStartTrace, buildPlayStartRecord, playStartClient, playStartTrigger, takePlayTrigger, wantsAudioIndex, audioRematchNeeded } from '../runtime/playStart.js';
import { normalizeId } from '../runtime/readySources.js';
import { readString, writeString } from '../runtime/storage.js';
import { formatClock } from '../runtime/format.js';
import { createScope } from '../runtime/teardown.js';
import { buildAudioMenu } from '../components/player/audioMenu.js';
import { wireBufferPrompt } from '../components/player/bufferPrompt.js';
import { buildCastControls } from '../components/player/castControls.js';
import { startSyncWaitPoll, wireGroupSync } from '../components/player/groupSync.js';
import { createPlayerKeydown } from '../components/player/keyboard.js';
import { wireMediaSession } from '../components/player/mediaSession.js';
import { buildPartyChat } from '../components/player/partyChat.js';
import { buildSettingsMenu } from '../components/player/settingsMenu.js';
import { buildSidePanels } from '../components/player/sidePanels.js';
import { buildSubtitleControls } from '../components/player/subtitles.js';
import { wireUpNext } from '../components/player/upNext.js';
import * as skipRules from '../runtime/skipSegments.js';

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

function willUseHls(source, forceTranscode) {
  const directPlay = !forceTranscode && canBrowserDirectPlay(source);
  return !directPlay && supportsNativeHls();
}

let mediaSessionOwner = null;

// The next stream to try once one failed, with one decision line in the
// console and the server log.
async function chooseNextStream(itemId, tried, language, reason, fresh) {
  const loaded = await loadFailoverSources({
    skipRecent: !!fresh,
    lastList: function () {
      return getLastMediaSources(itemId);
    },
    fetchSources: function (timeoutMs) {
      return getMediaSources(itemId, { forceFresh: true, timeoutMs: timeoutMs });
    },
  });
  const avoiding = avoidingVideoTranscodes();
  const plan = planFailover(loaded.sources, tried, {
    isBad: function (source) {
      return badSourceKind(itemId, source);
    },
    byLanguage: function (list) {
      return orderByLanguage(list, language, sourceAudioLanguages);
    },
    needsReencode: avoiding
      ? function (source) {
          return !!videoInfoOf(source) && classifySource(source, canBrowserDirectPlay(source)).needsVideoTranscode;
        }
      : null,
    blockReencode: getVideoTranscodePolicy() === 'Block',
  });
  const outcome = failoverOutcome(loaded, plan);
  const entry = { itemId: itemId, failedSourceId: tried[tried.length - 1], reason: reason, counts: plan.counts, loaded: loaded, outcome: outcome };
  console.warn(describeFailover(entry));
  logFailoverDecision(entry);
  return { outcome: outcome, plan: plan };
}

function failoverHash(itemId, sourceId, tried, language) {
  return (
    playHash(itemId, sourceId) +
    '&tried=' + encodeURIComponent(tried.join(',')) +
    (language ? '&lang=' + encodeURIComponent(language) : '')
  );
}

// Out of streams, or the list of them could not be loaded: the latter says
// so and can be tried again.
function renderFailoverEnd(root, itemId, outcome, tried, language, reason) {
  if (outcome.action === 'list-failed') {
    renderPlaybackError(
      root,
      itemId,
      t(outcome.kind === 'timeout' ? 'player_failover_list_timeout' : 'player_failover_list_error'),
      async function () {
        const message = root.querySelector('.jellio-service-empty');
        if (message) message.textContent = t('status_loading');
        const choice = await chooseNextStream(itemId, tried, language, reason + ' (tried again)');
        if (choice.outcome.action === 'navigate') {
          navigateTo(failoverHash(itemId, choice.outcome.sourceId, tried, language));
          return;
        }
        renderFailoverEnd(root, itemId, choice.outcome, tried, language, reason);
      },
    );
    return;
  }
  renderPlaybackError(
    root,
    itemId,
    tried.length > 1
      ? t('player_failover_none_worked', { count: tried.length })
      : t('player_failover_no_other'),
  );
}

export async function renderPlayer(root, params) {
  let screenTornDown = false;
  // Listeners, timers and observers that live as long as this screen.
  const scope = createScope();
  // Live views of this screen's changing state, for components/player.
  const playerLive = {
    get activeSubtitleStreamIndex() { return activeSubtitleStreamIndex; },
    set activeSubtitleStreamIndex(value) { activeSubtitleStreamIndex = value; },
    get activeTrack() { return activeTrack; },
    set activeTrack(value) { activeTrack = value; },
    get audioCtx() { return audioCtx; },
    set audioCtx(value) { audioCtx = value; },
    get autoSkipEnabled() { return autoSkipEnabled; },
    set autoSkipEnabled(value) { autoSkipEnabled = value; },
    get bufferStallStartedAt() { return bufferStallStartedAt; },
    set bufferStallStartedAt(value) { bufferStallStartedAt = value; },
    get bufferStallTimer() { return bufferStallTimer; },
    set bufferStallTimer(value) { bufferStallTimer = value; },
    get closeChatPanel() { return closeChatPanel; },
    set closeChatPanel(value) { closeChatPanel = value; },
    get closeShortcutsModal() { return closeShortcutsModal; },
    set closeShortcutsModal(value) { closeShortcutsModal = value; },
    get currentAudioStreamIndex() { return currentAudioStreamIndex; },
    set currentAudioStreamIndex(value) { currentAudioStreamIndex = value; },
    get deferredAutoSubtitleStream() { return deferredAutoSubtitleStream; },
    set deferredAutoSubtitleStream(value) { deferredAutoSubtitleStream = value; },
    get durationSeconds() { return durationSeconds; },
    get endScreenModalInstance() { return endScreenModalInstance; },
    set endScreenModalInstance(value) { endScreenModalInstance = value; },
    get fullscreenButton() { return fullscreenButton; },
    get hasInitiatedNextPreload() { return hasInitiatedNextPreload; },
    set hasInitiatedNextPreload(value) { hasInitiatedNextPreload = value; },
    get hasReportedStart() { return hasReportedStart; },
    set hasReportedStart(value) { hasReportedStart = value; },
    get item() { return item; },
    get joinSyncActive() { return joinSyncActive; },
    set joinSyncActive(value) { joinSyncActive = value; },
    get joinSyncGroupId() { return joinSyncGroupId; },
    set joinSyncGroupId(value) { joinSyncGroupId = value; },
    get lastUserSeekAt() { return lastUserSeekAt; },
    get mediaSource() { return mediaSource; },
    set mediaSource(value) { mediaSource = value; },
    get needsStartOffset() { return needsStartOffset; },
    set needsStartOffset(value) { needsStartOffset = value; },
    get nextEpisode() { return nextEpisode; },
    set nextEpisode(value) { nextEpisode = value; },
    get openShortcutsModal() { return openShortcutsModal; },
    set openShortcutsModal(value) { openShortcutsModal = value; },
    get partyLayer() { return partyLayer; },
    set partyLayer(value) { partyLayer = value; },
    get pendingNativeSeekSeconds() { return pendingNativeSeekSeconds; },
    set pendingNativeSeekSeconds(value) { pendingNativeSeekSeconds = value; },
    get playSessionId() { return playSessionId; },
    set playSessionId(value) { playSessionId = value; },
    get preloadedNextVideoEl() { return preloadedNextVideoEl; },
    set preloadedNextVideoEl(value) { preloadedNextVideoEl = value; },
    get rebuildAudioMenu() { return rebuildAudioMenu; },
    get screenTornDown() { return screenTornDown; },
    get seeking() { return seeking; },
    get selectedSubtitleLanguage() { return selectedSubtitleLanguage; },
    set selectedSubtitleLanguage(value) { selectedSubtitleLanguage = value; },
    get skipOverlay() { return skipOverlay; },
    get skipTargetSeconds() { return skipTargetSeconds; },
    get sleepOption() { return sleepOption; },
    set sleepOption(value) { sleepOption = value; },
    get sourceOptions() { return sourceOptions; },
    get startTicks() { return startTicks; },
    get stopChatOnCleanup() { return stopChatOnCleanup; },
    set stopChatOnCleanup(value) { stopChatOnCleanup = value; },
    get streamIsTranscoded() { return streamIsTranscoded; },
    set streamIsTranscoded(value) { streamIsTranscoded = value; },
    get streamOffsetTicks() { return streamOffsetTicks; },
    set streamOffsetTicks(value) { streamOffsetTicks = value; },
    get subtitleStyle() { return subtitleStyle; },
    set subtitleStyle(value) { subtitleStyle = value; },
    get syncMediaPosition() { return syncMediaPosition; },
    set syncMediaPosition(value) { syncMediaPosition = value; },
    get syncMediaSession() { return syncMediaSession; },
    set syncMediaSession(value) { syncMediaSession = value; },
    get syncPlaylistItemId() { return syncPlaylistItemId; },
    set syncPlaylistItemId(value) { syncPlaylistItemId = value; },
    get toggleCastMenu() { return toggleCastMenu; },
    set toggleCastMenu(value) { toggleCastMenu = value; },
    get toggleShortcutsModal() { return toggleShortcutsModal; },
    set toggleShortcutsModal(value) { toggleShortcutsModal = value; },
    get unsubscribeSyncCommand() { return unsubscribeSyncCommand; },
    set unsubscribeSyncCommand(value) { unsubscribeSyncCommand = value; },
    get unsubscribeSyncGroupChange() { return unsubscribeSyncGroupChange; },
    set unsubscribeSyncGroupChange(value) { unsubscribeSyncGroupChange = value; },
    get upNextCountdownInterval() { return upNextCountdownInterval; },
    set upNextCountdownInterval(value) { upNextCountdownInterval = value; },
    get upNextDismissed() { return upNextDismissed; },
    set upNextDismissed(value) { upNextDismissed = value; },
    get upNextShown() { return upNextShown; },
    set upNextShown(value) { upNextShown = value; },
  };
  const playerToken = {};
  mediaSessionOwner = playerToken;
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-player';

  const itemId = params.get('id');
  if (!itemId) {
    renderPlaybackError(root, null, t('player_nothing_to_play'));
    return undefined;
  }

  // Downloaded videos (screens/offlinePlayer.js): when the server can't
  // be reached, or when opened from Downloads.
  if (params.get('local') === '1' || isOffline()) return renderOfflinePlayer(root, params);

  const isGroupJoinNavigation = params.get('groupJoin') === '1';
  const playTrace = createPlayStartTrace(function () {
    return performance.now();
  });
  const notedTrigger = takePlayTrigger(itemId);
  let playStartFrom = 'fresh';
  // Ids of the sources the server has warm; null until it answers or when it can't say.
  let warmSourceIds = null;
  getWarmSources(itemId)
    .then(function (warm) {
      if (warm) warmSourceIds = Object.keys(warm).map(normalizeId);
    })
    .catch(function () {});

  renderLoading(root);

  const currentUserPromise = getCurrentUser();
  const detailsPromise = getItemDetails(itemId, { includePlaybackFields: true });
  detailsPromise.catch(function () {});
  const preferredMediaSourceId = params.get('mediaSourceId') || undefined;
  const failoverTried = (params.get('tried') || '').split(',').filter(Boolean);
  // Start over, and a buffering switch that carries the position over,
  // override the saved position before anything is negotiated.
  const startFromBeginning = params.get('fromStart') === '1';
  const reloadedAtTicks = Number(params.get('at')) || 0;
  function overrideStartTicks(ticks, inSyncPlaylist) {
    if (startFromBeginning) ticks = 0;
    if (reloadedAtTicks > 0 && !inSyncPlaylist) ticks = reloadedAtTicks;
    return ticks;
  }

  // The reader's audio language for the stream asked for, when its tracks
  // are already known here, so the first PlaybackInfo can ask for it.
  function predictAudioIndex(user) {
    const preferredLanguage = user && user.Configuration && user.Configuration.AudioLanguagePreference;
    const known = preferredMediaSourceId && preferredLanguage ? getLastMediaSources(itemId) : null;
    const source = known && (known.sources || []).find(function (s) {
      return s && s.Id === preferredMediaSourceId;
    });
    if (!source) return null;
    const matched = matchAudioStreamIndex(source, preferredLanguage);
    return wantsAudioIndex(matched, getAudioStreams(source).length) ? matched : null;
  }

  function cachedNegotiation(ticks) {
    if (failoverTried.length) return null;
    const prewarmed = prewarmedPlayback.take(itemId, preferredMediaSourceId, ticks);
    if (prewarmed) return { from: 'prewarmed', ticks: ticks, audioIndex: prewarmed.audioIndex, promise: prewarmed.promise };
    const prefetched = prefetchedPlayback.take(itemId, preferredMediaSourceId, ticks);
    if (prefetched) return { from: 'prefetched', ticks: ticks, audioIndex: prefetched.audioIndex, promise: prefetched.promise };
    return null;
  }

  function requestNegotiation(ticks, audioIndex, from) {
    const promise = getPlaybackInfo(itemId, ticks, preferredMediaSourceId, audioIndex);
    promise.catch(function () {});
    return { from: from, ticks: ticks, audioIndex: audioIndex, promise: promise };
  }

  // PlaybackInfo starts alongside the details when the start position is
  // already known (a cached item or the group's position); the details
  // only confirm it.
  const earlySyncTarget = getCurrentPlaylistTarget();
  const preview = getCachedItemSync(itemId);
  let earlyTicks = null;
  const earlyInSync = !!(earlySyncTarget && sameSyncId(earlySyncTarget.itemId, itemId));
  if (earlyInSync) earlyTicks = earlySyncTarget.startPositionTicks || 0;
  else if (preview && preview.UserData) earlyTicks = preview.UserData.PlaybackPositionTicks || 0;
  if (earlyTicks != null) earlyTicks = overrideStartTicks(earlyTicks, earlyInSync);
  let earlyNegotiation = null;
  if (earlyTicks != null) {
    earlyNegotiation = cachedNegotiation(earlyTicks);
    if (!earlyNegotiation) {
      const quickUser = await Promise.race([
        currentUserPromise.catch(function () {
          return null;
        }),
        new Promise(function (resolve) {
          window.setTimeout(resolve, 100);
        }),
      ]);
      earlyNegotiation = requestNegotiation(earlyTicks, predictAudioIndex(quickUser), 'early');
    }
  }

  let item;
  try {
    item = await detailsPromise;
  } catch (err) {
    console.warn('Jellio: could not load item for playback', err);
    renderPlaybackError(root, itemId, describeNetworkFailure('this title', err), function () {
      renderPlayer(root, params);
    });
    return undefined;
  }
  playTrace.mark('details');

  let syncPlaylistItemId = null;
  // The watch party layer (components/partyLayer.js), set once the
  // player is built.
  let partyLayer = null;
  const initialSyncTarget = getCurrentPlaylistTarget();
  let startTicks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
  if (initialSyncTarget && sameSyncId(initialSyncTarget.itemId, itemId)) {
    syncPlaylistItemId = initialSyncTarget.playlistItemId;
    startTicks = initialSyncTarget.startPositionTicks || 0;
  }
  startTicks = overrideStartTicks(startTicks, !!syncPlaylistItemId);

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
    if (backdropId) layers.push(cssUrl(getImageUrl(backdropId, 'Backdrop', { maxWidth: 1920 })));
    if (posterUrl) layers.push(cssUrl(posterUrl));
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
    preLogo.style.backgroundImage = cssUrl(logoUrl);
    root.appendChild(preLogo);
  }

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
      el('div', 'jellio-player-failover-text', t('player_failover_trying_next', { n: failoverTried.length + 1 })),
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

  async function streamLanguage() {
    const fromHash = params.get('lang') || '';
    if (fromHash) return fromHash;
    let audioPreference = '';
    try {
      const user = await currentUserPromise;
      audioPreference = (user && user.Configuration && user.Configuration.AudioLanguagePreference) || '';
    } catch (e) {}
    return preferredStreamLanguage(audioPreference, getDisplayLanguage());
  }

  let playbackInfo;
  let negotiation = earlyNegotiation && earlyNegotiation.ticks === startTicks ? earlyNegotiation : cachedNegotiation(startTicks);
  try {
    // One negotiated a while ago is used only while it still has the stream;
    // the early one asked exactly what a fresh one would.
    if (negotiation && negotiation.from !== 'early') {
      const cachedInfo = await negotiation.promise.catch(function () {
        return null;
      });
      if (!negotiationFits(cachedInfo, preferredMediaSourceId)) negotiation = null;
    }
    if (!negotiation) {
      let user = null;
      try {
        user = await currentUserPromise;
      } catch (e) {}
      negotiation = requestNegotiation(startTicks, predictAudioIndex(user), 'fresh');
    }
    playbackInfo = await negotiation.promise;
    playStartFrom = negotiation.from;
  } catch (err) {
    if (screenTornDown) return undefined;
    console.warn('Jellio: could not negotiate playback', err);
    const isTimeoutOrAbort = err && (err.name === 'AbortError' || /timeout/i.test(err.message || ''));
    const notReady = isSourceNotReady(err);
    if (!getCurrentGroup() && !isTimeoutOrAbort && preferredMediaSourceId) {
      if (!notReady) markBadSource(itemId, { Id: preferredMediaSourceId });
      const tried = failoverTried.concat([preferredMediaSourceId]);
      const language = await streamLanguage();
      const choice = await chooseNextStream(
        itemId,
        tried,
        language,
        notReady ? 'could not start: source not ready' : 'could not start: ' + ((err && err.message) || 'error').split(':')[0],
        notReady,
      );
      if (screenTornDown) return undefined;
      if (choice.outcome.action === 'navigate') {
        navigateTo(failoverHash(itemId, choice.outcome.sourceId, tried, language));
        return undefined;
      }
      if (choice.outcome.action === 'list-failed') {
        renderFailoverEnd(root, itemId, choice.outcome, tried, language, 'could not start');
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
  // The server knows no stream by that id any more: the title's streams were
  // fetched again and got new ids. Go on with the fresh list.
  if (!playbackSources.length && preferredMediaSourceId && !getCurrentGroup()) {
    const tried = failoverTried.concat([preferredMediaSourceId]);
    const language = await streamLanguage();
    const choice = await chooseNextStream(itemId, tried, language, 'stream id unknown to the server', true);
    if (screenTornDown) return undefined;
    if (choice.outcome.action === 'navigate') {
      navigateTo(failoverHash(itemId, choice.outcome.sourceId, tried, language));
      return undefined;
    }
  }
  if (!mediaSource || (!preferredMediaSourceId && playbackSources.length === 1 && isPlaceholderSource(mediaSource))) {
    console.warn('Jellio: no playable media source for', itemId);
    renderPlaybackError(
      root,
      itemId,
      preferredMediaSourceId
        ? t('player_stream_gone_pick')
        : t('player_no_playable_stream'),
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
    const audioCount = getAudioStreams(mediaSource).length;
    const requestedAudioIndex = negotiation && mediaSource.Id === preferredMediaSourceId ? negotiation.audioIndex : null;
    if (!audioRematchNeeded(matchedIndex, audioCount, requestedAudioIndex)) {
      if (wantsAudioIndex(matchedIndex, audioCount)) currentAudioStreamIndex = matchedIndex;
    } else {
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
  playTrace.mark('playbackInfo');

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
    durationLabel.textContent = durationSeconds ? formatClock(durationSeconds) : '--:--';
  }

  // A buffering switch carries the position over and plays straight on.
  let lastUserSeekAt = 0;
  const hasResumePosition = startTicks > 0 && !syncPlaylistItemId && !reloadedAtTicks;

  const video = document.createElement('video');
  video.className = 'jellio-player-video';
  // Ask the browser to keep loading ahead, paused included.
  video.preload = 'auto';
  // Set by the stall wait (Pre-buffer More/Maximum): playback is held, not
  // paused by the reader, so no pause screen.
  let stallHold = false;
  video.src = streamUrl;
  playTrace.mark('playerReady');
  const playStartTriggerValue = playStartTrigger(notedTrigger, failoverTried.length > 0, startTicks);
  const playStartWarm = warmSourceIds;
  let playStartSent = false;
  function sendPlayStart() {
    if (playStartSent || screenTornDown) return;
    playStartSent = true;
    playTrace.mark('firstFrame');
    const sourceId = mediaSource && mediaSource.Id;
    const warmIds = playStartWarm || warmSourceIds;
    logPlayStart(
      buildPlayStartRecord(
        {
          itemId: itemId,
          mediaSourceId: sourceId,
          client: playStartClient(window),
          trigger: playStartTriggerValue,
          from: playStartFrom,
          warmAtPlay: warmIds && sourceId ? warmIds.indexOf(normalizeId(sourceId)) !== -1 : null,
          directPlay: !streamIsTranscoded,
        },
        playTrace,
      ),
    );
  }
  ['loadedmetadata', 'progress'].forEach(function (type) {
    video.addEventListener(type, function () {
      playTrace.mark('firstByte');
    }, { once: true });
  });
  video.addEventListener('playing', function () {
    if (playStartSent) return;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(sendPlayStart);
    else sendPlayStart();
  });
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
      loadingBackdrop.style.backgroundImage = cssUrl(posterUrl);
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
      loadingLogo.style.backgroundImage = cssUrl(logoUrl);
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
  scope.listen(document, 'visibilitychange', onWakeVisibility);

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
  scope.listen(document, 'visibilitychange', onTabVisibility);
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

  let stopChatOnCleanup = function () {};
  let closeChatPanel = function () {};
  const currentSyncGroup = getCurrentGroup();
  buildPartyChat({ currentSyncGroup, root, topbarActions, wakeControls }, playerLive);

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
  let seeking = false;
  let isScrubHovering = false;

  const seekRow = el('div', 'jellio-player-seek-row');
  const currentTimeLabel = el('span', 'jellio-player-time', formatClock(startTicks / TICKS_PER_SECOND));
  const seekWrap = el('div', 'jellio-player-seek-wrap');
  const seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.className = 'jellio-player-seek';
  seekBar.min = '0';
  seekBar.max = '100';
  seekBar.value = '0';
  seekBar.setAttribute('aria-label', t('player_seek'));
  const durationLabel = el('span', 'jellio-player-time', durationSeconds ? formatClock(durationSeconds) : '--:--');

  const scrubTip = el('div', 'jellio-player-scrub-tip');
  const scrubTime = el('span', 'jellio-player-scrub-time');
  const scrubChapter = el('span', 'jellio-player-scrub-chapter');
  scrubChapter.style.display = 'none';
  scrubTip.appendChild(scrubTime);
  scrubTip.appendChild(scrubChapter);

  function getChapterNameAt(seconds) {
    if (!item || !Array.isArray(item.Chapters) || !item.Chapters.length) return null;
    const targetTicks = seconds * TICKS_PER_SECOND;
    let candidate = null;
    for (let i = 0; i < item.Chapters.length; i++) {
      const ch = item.Chapters[i];
      if (typeof ch.StartPositionTicks === 'number' && ch.StartPositionTicks <= targetTicks) {
        if (!candidate || ch.StartPositionTicks >= candidate.StartPositionTicks) {
          candidate = ch;
        }
      }
    }
    return candidate && candidate.Name ? candidate.Name.trim() : null;
  }

  function updateScrubTipAtClientX(clientX) {
    if (!durationSeconds || durationSeconds <= 0) {
      hideScrubTip();
      return;
    }
    const rect = seekWrap.getBoundingClientRect();
    if (!rect.width) return;
    const clampedX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = clampedX / rect.width;
    const hoverSeconds = ratio * durationSeconds;

    scrubTime.textContent = formatClock(hoverSeconds);

    const chapterName = getChapterNameAt(hoverSeconds);
    if (chapterName) {
      scrubChapter.textContent = chapterName;
      scrubChapter.style.display = '';
    } else {
      scrubChapter.textContent = '';
      scrubChapter.style.display = 'none';
    }

    scrubTip.classList.add('jellio-player-scrub-tip-visible');

    const tipWidth = scrubTip.offsetWidth || 56;
    const halfWidth = tipWidth / 2;
    const minLeft = halfWidth;
    const maxLeft = Math.max(minLeft, rect.width - halfWidth);
    const tipLeft = Math.max(minLeft, Math.min(maxLeft, clampedX));
    scrubTip.style.left = tipLeft + 'px';
  }

  function updateScrubTipForValue(sliderValue) {
    if (!durationSeconds || durationSeconds <= 0) {
      hideScrubTip();
      return;
    }
    const rect = seekWrap.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, Number(sliderValue) / 100));
    const clientX = rect.left + ratio * rect.width;
    updateScrubTipAtClientX(clientX);
  }

  function hideScrubTip() {
    scrubTip.classList.remove('jellio-player-scrub-tip-visible');
  }

  seekWrap.addEventListener('pointerenter', function (e) {
    if (e.pointerType === 'touch') return;
    isScrubHovering = true;
    updateScrubTipAtClientX(e.clientX);
  });
  seekWrap.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    isScrubHovering = true;
    updateScrubTipAtClientX(e.clientX);
  });
  seekWrap.addEventListener('pointerleave', function () {
    isScrubHovering = false;
    if (!seeking) hideScrubTip();
  });

  seekWrap.appendChild(seekBar);
  seekWrap.appendChild(scrubTip);
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
  const savedSpeed = parseFloat(readString('jellioPlayerSpeed')) || 1;
  const speedMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');

  function applyPlaybackSpeed(speed) {
    video.playbackRate = speed;
    writeString('jellioPlayerSpeed', String(speed));
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
      showPlayerToast(t('player_toast_speed', { speed: newSpeed }));
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

  let activeTrack = null;
  let selectedSubtitleLanguage = null;
  let activeSubtitleStreamIndex = null;
  let deferredAutoSubtitleStream = null;
  const { rebuildSubtitleMenu, subtitleMenu, updateSubtitleOffset, attachSubtitleTrack } = buildSubtitleControls(
    {
      attemptPlay, closePopovers, currentPositionTicks, currentUserPromise, itemId, registerPopover, scope,
      showLoadingLogo, showPlayerToast, subtitleButton, video, waitForPlayableBuffer, willUseHls,
    },
    playerLive,
  );

  let audioCtx = null;
  const { audioMenu, rebuildAudioMenu } = buildAudioMenu(
    {
      attemptPlay, audioButton, closePopovers, currentPositionTicks, itemId, pickNegotiatedSource,
      rebuildSubtitleMenu, registerPopover, showLoadingLogo, showPlayerToast, video, waitForPlayableBuffer,
      willUseHls,
    },
    playerLive,
  );

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

  const { castMenu, castBanner, unsubscribeCast } = buildCastControls(
    {
      castButton, currentTimeLabel, itemId, playPauseButton, playPauseIcon, positionPopover, registerPopover,
      seekBar, seekToAbsoluteSeconds, showPlayerToast, skipBackButton, skipForwardButton, video,
    },
    playerLive,
  );

  let autoSkipEnabled = false;
  const { settingsMenu, shortcutsModal } = buildSettingsMenu(
    {
      closePopovers, positionPopover, registerPopover, settingsButton, showPlayerToast, sleepButton,
      sleepMenu, wakeControls,
    },
    playerLive,
  );

  // Declared before the media session wiring, which reads it from events
  // that can fire while this function is still awaiting.
  let nextEpisode = null;
  wireMediaSession(
    {
      attemptPlay, backButton, isEpisodeItem, performSeek, seriesAwareArtworkUrl, skipBackButton, video,
    },
    playerLive,
  );

  syncMediaSession();

  let sourceOptions = [mediaSource];
  let switchingSource = false;
  const { sourcePanel, episodesPanel, closeSidePanels, rebuildSourceMenu, rebuildSourceFilter } = buildSidePanels(
    {
      closePopovers, episodesButton, isEpisodeItem, itemId, root, shell, showPlayerToast, sourceButton,
      switchSource, wakeControls,
    },
    playerLive,
  );

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
        showPlayerToast(t('player_start_failed'));
      });
    }
  }

  function isConfirmedCachedSource() {
    return !!(mediaSource && mediaSource.Formats && mediaSource.Formats.indexOf('gelato-cached') !== -1);
  }
  function startBufferSource() {
    return {
      confirmedCached: isConfirmedCachedSource(),
      ready: !!(warmSourceIds && mediaSource && warmSourceIds.indexOf(normalizeId(mediaSource.Id)) !== -1),
      localFile: !!(mediaSource && mediaSource.Protocol === 'File' && !mediaSource.IsRemote),
      transcoded: streamIsTranscoded,
    };
  }
  function waitForPlayableBuffer(callback, targetOverride, timeoutOverride) {
    let settled = false;
    const startTarget = startBufferTarget(prebufferSettings(), startBufferSource());
    const targetSeconds = targetOverride || startTarget.targetSeconds;
    const timeoutMs = timeoutOverride || startTarget.timeoutMs;
    const acceptReadyState = startTarget.acceptReadyState && !targetOverride;
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
      if (bufferedAheadSeconds() >= targetSeconds || (acceptReadyState && video.readyState >= 4)) settle();
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
        showPlayerToast(t('player_seek_gone'));
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
      showPlayerToast(t('player_seek_failed', { error: err && err.message ? err.message : err }));
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
        showPlayerToast(t('player_stream_gone'));
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
      showPlayerToast(t('player_switch_failed'));
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
  const overlayInsets = scope.observe(new ResizeObserver(function () {
    const box = root.getBoundingClientRect();
    if (!box.height) return;
    root.style.setProperty('--jellio-player-bottom-inset', Math.max(0, box.bottom - seekRow.getBoundingClientRect().top) + 'px');
    root.style.setProperty('--jellio-player-top-inset', Math.max(0, topbar.getBoundingClientRect().bottom - box.top) + 'px');
  }));
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
      seeking ||
      isScrubHovering ||
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
    hideScrubTip();
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
    scope.listen(root, eventName, onRootWake);
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
  scope.listen(root, 'dblclick', onPlayerDblClick);
  scope.listen(root, 'wheel', onPlayerWheel, { passive: false });
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
      showPlayerToast(t('player_tv_volume', { percent: newVol }));
      return;
    }
    video.muted = false;
    video.volume = Math.min(1, Math.max(0, video.volume + delta));
    syncVolumeUI();
    showPlayerToast(t('player_toast_volume', { percent: Math.round(video.volume * 100) }));
  }
  function toggleMute() {
    video.muted = !video.muted;
    syncVolumeUI();
    showPlayerToast(t(video.muted ? 'player_muted' : 'player_unmuted'));
  }
  const { onPlayerKeydown } = createPlayerKeydown(
    {
      adjustVolume, closeSidePanels, episodesPanel, isTypingTarget, performSeek, playPauseButton, popovers,
      shortcutsModal, skipBackButton, skipForwardButton, sourcePanel, stepPlaybackSpeed, subtitleButton,
      toggleMute, updateSubtitleOffset, video,
    },
    playerLive,
  );
  scope.listen(document, 'keydown', onPlayerKeydown);

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

  function skipRuntimeSeconds() {
    return (item.RunTimeTicks || 0) / TICKS_PER_SECOND;
  }

  function chapterFallbackSegments(chapters, runTimeTicks) {
    const result = skipRules.chapterFallbackSegments(chapters, runTimeTicks, TICKS_PER_SECOND);
    if (!result) console.warn('Jellio: no intro/credits chapters to fall back on', itemId);
    return result;
  }

  function activeSkipSegment(currentTime) {
    const active = skipRules.activeSkipSegment(skipSegments, currentTime);
    if (!active) return null;
    return active.kind === 'intro'
      ? { eyebrow: 'Introduction', label: 'Skip Intro', target: active.target }
      : { eyebrow: 'Credits', label: 'Skip Credits', target: active.target };
  }

  function shouldShowUpNextNow(currentTime, duration) {
    return skipRules.shouldShowUpNextNow(skipSegments, currentTime, duration);
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

  const isValidSegment = skipRules.isValidSegment;

  function isValidCredits(segment) {
    return skipRules.isValidCredits(segment, skipRuntimeSeconds());
  }

  function mergeSkipSegments(current, candidate) {
    return skipRules.mergeSkipSegments(current, candidate, skipRuntimeSeconds());
  }

  function segmentsComplete(segments) {
    return skipRules.skipSegmentsComplete(segments, skipRuntimeSeconds());
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
    playTrace.hold();
    const resumePrompt = buildResumePrompt(
      percent,
      function () {
        playTrace.release();
        resumePrompt.overlay.remove();
        waitForPlayableBuffer(attemptPlay);
      },
      function () {
        playTrace.release();
        resumePrompt.overlay.remove();
        hasReportedStart = false;
        getPlaybackInfo(itemId, 0, mediaSource.Id, currentAudioStreamIndex)
          .then(function (info) {
            const negotiated = pickNegotiatedSource(info, mediaSource.Id);
            if (!negotiated) {
              showPlayerToast(t('player_start_over_gone'));
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
            showPlayerToast(t('player_start_over_failed', { error: err && err.message ? err.message : err }));
          });
      },
    );
    root.appendChild(resumePrompt.overlay);
    resumePrompt.resumeButton.focus();
  } else if ((!syncPlaylistItemId && !getCurrentGroup()) || (initialSyncTarget && initialSyncTarget.isPlaying)) {
    waitForPlayableBuffer(attemptPlay);
  }

  let upNextShown = false;
  let upNextDismissed = false;
  let upNextCountdownInterval = null;
  let endScreenModalInstance = null;
  let preloadedNextVideoEl = null;
  let hasInitiatedNextPreload = false;
  const { activeAudioLanguageCode, showEndScreenModal, preloadNextEpisodeStream, dismissUpNext, showUpNext } = wireUpNext(
    {
      attemptPlay, currentPositionTicks, currentUserPromise, itemId, markRealWatchComplete, performSeek,
      pickNegotiatedSource, reportRealDurationIfUseful, root, showLoadingLogo, video, waitForPlayableBuffer,
      wakeControls,
    },
    playerLive,
  );

  let hasReportedStart = false;

  const START_TIMEOUT_MS =
    avoidingVideoTranscodes() && sourceClassification.needsVideoTranscode
      ? Math.max(prebufferSettings().startTimeoutMs, 12000)
      : 25000;
  let failoverStarted = false;
  let startTimer = null;
  const expectedRuntimeSeconds = item && item.RunTimeTicks ? item.RunTimeTicks / TICKS_PER_SECOND : 0;

  // The streams left to try, in the order to try them.
  async function nextStreams(tried, language, reason) {
    return (await chooseNextStream(itemId, tried, language, reason || 'switching')).plan.ordered;
  }

  async function failoverToNextStream(reason) {
    if (failoverStarted || screenTornDown || getCurrentGroup()) return false;
    failoverStarted = true;
    if (startTimer) window.clearTimeout(startTimer);
    console.warn('Jellio: stream failed (' + reason + '), trying the next one', mediaSource && mediaSource.Id);
    markBadSource(itemId, mediaSource, { soft: /^(no picture after|placeholder: stalled)/.test(reason) });
    const tried = failoverTried.concat(mediaSource && mediaSource.Id ? [mediaSource.Id] : []);
    const language = await streamLanguage();
    const choice = await chooseNextStream(itemId, tried, language, reason);
    if (screenTornDown) return true;
    if (choice.outcome.action === 'navigate') {
      navigateTo(failoverHash(itemId, choice.outcome.sourceId, tried, language));
      return true;
    }
    cleanup();
    renderFailoverEnd(root, itemId, choice.outcome, tried, language, reason);
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
    showPlayerToast(t('player_now_playing', { name: sourceLabel(mediaSource) }));
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
  let failoverWatch = 0;
  if (failoverOverlay) {
    let lastSeen = { element: null, time: 0 };
    failoverWatch = window.setInterval(function () {
      if (!failoverOverlay || screenTornDown) {
        window.clearInterval(failoverWatch);
        failoverWatch = 0;
        return;
      }
      const current = root.querySelector('video') || video;
      if (lastSeen.element === current && !current.paused && current.currentTime > lastSeen.time + 0.3) {
        hideFailoverOverlay();
        window.clearInterval(failoverWatch);
        failoverWatch = 0;
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
  seeking = false;
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
      showPlayerToast(t('player_stopped_unexpectedly'));
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
              t('player_stream_failed_change'),
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
        t('player_stream_failed_change'),
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
    currentTimeLabel.textContent = formatClock(positionSeconds);
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
        showPlayerToast(t('player_skipped_intro'));
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
      currentTimeLabel.textContent = formatClock(target);
      updateScrubTipForValue(seekBar.value);
    }
  });
  seekBar.addEventListener('change', function () {
    if (durationSeconds) {
      performSeek((Number(seekBar.value) / 100) * durationSeconds);
    }
    seeking = false;
    if (!isScrubHovering) {
      hideScrubTip();
    }
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
  let hasCheckedPreviousEpisodes = false;
  const progressInterval = startProgressTimer(function () {
    if (screenTornDown) {
      stopProgressTimer(progressInterval);
      return;
    }
    if (!hasReportedStart) return;
    lastReportedTicks = currentPositionTicks();
    if (!hasCheckedPreviousEpisodes && lastReportedTicks >= 5 * TICKS_PER_SECOND) {
      hasCheckedPreviousEpisodes = true;
      if (isEpisodeItem) {
        autoCompletePreviousEpisodesIfSkipped(item).catch(function (err) {
          console.warn('Jellio: could not check previous episodes', err);
        });
      }
    }
    const action = pauseGate.tick(video.paused, Date.now());
    if (action === 'progress') {
      reportPlaybackProgress(itemId, mediaSource.Id, lastReportedTicks, video.paused);
    } else if (action === 'stop') {
      reportPlaybackStopped(itemId, mediaSource.Id, lastReportedTicks);
      hasReportedStart = false;
    }
  }, PROGRESS_REPORT_MS);

  let unsubscribeSyncCommand = null;
  let unsubscribeSyncGroupChange = null;
  const { clearScheduledSync } = wireGroupSync(
    {
      attemptPlay, currentPositionTicks, isEpisodeItem, isGroupJoinNavigation, isInitialGroupCatchUp, itemId,
      root, seekToAbsoluteSeconds, showPlayerToast, video, waitForPlayableBuffer,
    },
    playerLive,
  );

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

  let bufferStallStartedAt = 0;
  let bufferStallTimer = null;
  const { bufferStalls, closeBufferPrompt } = wireBufferPrompt(
    {
      failoverTried, itemId, nextStreams, root, showPlayerToast, streamLanguage, switchSource, video,
    },
    playerLive,
  );
  video.addEventListener('canplay', function () {
    if (!syncPlaylistItemId) return;
    notifyReady(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
    if (partyLayer) partyLayer.markReady(syncPlaylistItemId);
    if (joinSyncActive) {
      joinSyncActive = false;
      clearJoinSync(joinSyncGroupId).catch(function () {});
    }
  });

  startSyncWaitPoll({ scope, syncWaitBanner, syncWaitText }, playerLive);

  async function cleanup() {
    scope.dispose();
    window.clearTimeout(slideshowTimer);
    if (failoverWatch) { window.clearInterval(failoverWatch); failoverWatch = 0; }
    if (toastTimer) { window.clearTimeout(toastTimer); toastTimer = 0; }
    if (startTimer) { window.clearTimeout(startTimer); startTimer = 0; }
    clearEarlyStall();
    if (bufferStallTimer) window.clearInterval(bufferStallTimer);
    closeBufferPrompt();
    setPlaybackActive(false);
    holdAwake(false);
    notifyNativePlayback(false);
    if (unsubscribeCast) unsubscribeCast();
    if (getActiveCast()) disconnectCast().catch(function () {});
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
    clearScheduledSync();
    if (unsubscribeSyncCommand) unsubscribeSyncCommand();
    if (unsubscribeSyncGroupChange) unsubscribeSyncGroupChange();
    stopChatOnCleanup();
    if (partyLayer) partyLayer.destroy();
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
      invalidateHome();
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  return cleanup;
}
