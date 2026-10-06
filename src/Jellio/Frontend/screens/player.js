// Real playback: PlaybackInfo negotiation, a bare <video> element, and
// real session reporting, the same mechanism JMSFusion's own player uses
// (confirmed against its real source before writing any of this), not
// jellyfin-web's own playbackManager, which this runtime cannot reach.
// Also owns a pause screen overlay (Jellyfin-PauseScreen's technique), an
// up next episode preview (no native jellyfin-web up next dialog to
// reskin the way the original Jellio codebase's own InPlayer Episode
// Preview slice could, that dialog only exists inside jellyfin-web's own
// player bundle, unreachable from a runtime with its own <video>
// element, so this is a real overlay built from scratch instead), and a
// skip intro/credits button, a soft dependency on the community Intro
// Skipper plugin's own real REST API (confirmed against its source
// before writing this, see runtime/api.js's own getIntroSkipperSegments)
// rather than jellyfin-web's own player chrome hooks, unreachable here
// for the same reason as everything else in this file.
import { isAutoPipEnabled } from '../runtime/pipSettings.js';
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
import {
  getItemDetails,
  getPlaybackInfo,
  getMediaSources,
  buildStreamUrl,
  canBrowserDirectPlay,
  supportsNativeHls,
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  startSleepTimer,
  cancelSleepTimer,
  getSleepTimerStatus,
  getImageUrl,
  getSubtitleStreams,
  getAudioStreams,
  matchAudioStreamIndex,
  matchSubtitleStream,
  buildSubtitleUrl,
  getNextEpisode,
  getCommunitySkipSegments,
  getIntroSkipperSegments,
  getJellioIntroCredits,
  getSeasons,
  getEpisodes,
  getCurrentUser,
  getTrickplayTileUrl,
  getScrubPreviewUrl,
  pickTrickplayInfo,
  TICKS_PER_SECOND,
  getGroupWatchMessages,
  sendGroupWatchMessage,
  creditGroupWatchTogether,
  creditRealWatch,
  reportRealDuration,
  probeRealDuration,
  setPlayed,
  voteRankingSession,
  startJoinSync,
  clearJoinSync,
  getJoinSync,
  prefetchStreams,
  syncTracker,
} from '../runtime/api.js';
import { getUpNextTriggerSeconds, getUpNextCountdownSeconds } from '../runtime/upNextSettings.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { invalidateHomeSections } from './home.js';
import { sourceLabel, buildSourceCard, buildLanguageFilterRow, sourceAudioLanguages, playHash } from '../components/streamPicker.js';
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
} from '../runtime/syncPlay.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { fetchRankingSession, renderRankingSession, stopRankingCountdown } from '../components/groupWatchRanking.js';
import { el } from '../runtime/dom.js';

const PROGRESS_REPORT_MS = 5000;
// Same real 0.9 threshold Services/AchievementService.cs's own
// IsRealWatch() uses server side.
const GROUP_WATCH_COMPLETION_THRESHOLD = 0.9;
// Same real 0.9 figure, own real constant rather than reusing the one
// above: this one is compared against durationSeconds (this real
// <video>'s own real duration once 'durationchange' settles), not
// item.RunTimeTicks, exactly so a reality show's own metadata runtime
// (routinely the original broadcast slot, ads included, well past the
// real ad-stripped file Gelato actually resolved) never has to agree
// with the real file for a genuine full watch to still register.
const REAL_WATCH_COMPLETION_THRESHOLD = 0.9;
const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];
// Services/SleepTimerService.cs's own header already scopes that real
// service to duration timers only, an episode count timer needing
// wiring into playback stop/start events for correctness there instead.
// Handled here purely client side instead: an episode boundary is
// already a real client side event (the Up Next overlay's own
// shouldShowUpNextNow trigger below), and dismissUpNext() already ends
// playback without auto-advancing, real feedback's own explicit
// description of what this mode should do, so no server side timer or
// stop command is needed for this mode at all.
const EPISODE_SLEEP_TIMER_OPTIONS = [1, 2, 3, 5];
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// How long the reader can sit idle mid playback before the whole
// control shell fades out, ported from the same real convention every
// mainstream streaming app already uses (Netflix, Nuvio's own
// screenshot included): controls stay up the instant something
// actually needs attention (paused, still negotiating) regardless of
// this timer.
const IDLE_HIDE_MS = 3000;
const VOLUME_KEY = 'jellioPlayerVolume';

// Real feedback: no visible volume control existed at all, ArrowUp/
// ArrowDown/M already adjusted the real <video> element itself (this
// file's own adjustVolume/toggleMute below, already wired into
// onPlayerKeydown further down) but nothing showed the current level
// or gave a reader with no keyboard a way to reach it. Persisted the
// same real way subtitle style already is below: a plain client side
// preference, carried across episodes/titles the same real way every
// mainstream player already remembers volume rather than resetting to
// 100% on every new video element.
function loadVolumePreference() {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (!raw) return { volume: 1, muted: false };
    const parsed = JSON.parse(raw);
    const volume = typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1 ? parsed.volume : 1;
    return { volume: volume, muted: !!parsed.muted };
  } catch (err) {
    return { volume: 1, muted: false };
  }
}

function saveVolumePreference(volume, muted) {
  try {
    window.localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: volume, muted: muted }));
  } catch (err) {
    // A private/full storage quota is not worth surfacing here, the
    // chosen volume still applies for the rest of this playback session.
  }
}

const SUBTITLE_STYLE_KEY = 'jellioSubtitleStyle';
const SUBTITLE_SIZES = [
  { value: 'small', label: 'Small', rem: 1 },
  { value: 'medium', label: 'Medium', rem: 1.3 },
  { value: 'large', label: 'Large', rem: 1.7 },
  { value: 'xlarge', label: 'Extra large', rem: 2.1 },
];
const SUBTITLE_BACKGROUNDS = [
  { value: 'none', label: 'None', color: 'transparent' },
  { value: 'semi', label: 'Semi', color: 'rgb(0 0 0 / 0.5)' },
  { value: 'solid', label: 'Solid', color: 'rgb(0 0 0 / 0.9)' },
];
const DEFAULT_SUBTITLE_STYLE = { size: 'medium', background: 'semi' };

// Persisted the same way this runtime persists anything client only
// (avatar picker's own preset choice, sleep timer's own real server
// side state aside): plain localStorage, no server round trip for a
// display preference nothing server side needs to know about.
function loadSubtitleStyle() {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_STYLE_KEY);
    if (!raw) return Object.assign({}, DEFAULT_SUBTITLE_STYLE);
    const parsed = JSON.parse(raw);
    return {
      size: SUBTITLE_SIZES.some((s) => s.value === parsed.size) ? parsed.size : DEFAULT_SUBTITLE_STYLE.size,
      background: SUBTITLE_BACKGROUNDS.some((b) => b.value === parsed.background)
        ? parsed.background
        : DEFAULT_SUBTITLE_STYLE.background,
    };
  } catch (err) {
    return Object.assign({}, DEFAULT_SUBTITLE_STYLE);
  }
}

function saveSubtitleStyle(style) {
  try {
    window.localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(style));
  } catch (err) {
    // A private/full storage quota is not worth surfacing here, the
    // style still applies for the rest of this playback session.
  }
}

// Real bug, found live on macOS Safari: this used to only ever set two
// CSS custom properties on the video element and lean on css/app.css's
// own .jellio-player-video::cue rule to read them back through var(),
// real behaviour every Chromium/Firefox WebVTT renderer gives a custom
// property, confirmed live that WebKit's own ::cue implementation does
// not reliably inherit a custom property from the element it renders
// on top of the same way, background changes and size changes alike
// silently doing nothing there no matter what this runtime set. A
// single real <style> element, rewritten with literal resolved values
// on every change instead of custom properties, has no such
// inheritance step to fail: ::cue reads a plain background-color/
// font-size straight off the one real rule this owns, same as any
// other stylesheet on the page. !important guards against Safari's own
// user-agent default cue background winning a tie this rule would
// otherwise lose on specificity alone.
let subtitleStyleTag = null;
function applySubtitleStyle(video, style) {
  const size = SUBTITLE_SIZES.filter((s) => s.value === style.size)[0] || SUBTITLE_SIZES[1];
  const background = SUBTITLE_BACKGROUNDS.filter((b) => b.value === style.background)[0] || SUBTITLE_BACKGROUNDS[1];
  if (!subtitleStyleTag) {
    subtitleStyleTag = document.createElement('style');
    document.head.appendChild(subtitleStyleTag);
  }
  subtitleStyleTag.textContent =
    '.jellio-player-video::cue { font-size: ' +
    size.rem +
    'rem !important; background-color: ' +
    background.color +
    ' !important; }';
}

// Fallback only, when Intro Skipper has no Credits segment for this
// episode: runtime/upNextSettings.js's own real default (45s before
// the end), readable and changeable from screens/settings.js's own
// Playback category. Real credits segments below make this the less
// common path, not the whole rule. Read fresh inside shouldShowUpNextNow
// below rather than cached once at module load: this whole file's own
// render function runs again for every new playback within the same
// real session, and a reader who just changed this in Settings should
// not need a full reload for the very next episode to honour it.
// Real feedback: 15s read as far too short, an inaccurate or early
// real Intro Skipper Credits detection (shouldShowUpNextNow below
// trusts that segment outright the moment it exists) already showing
// the card sooner than the episode actually warranted, then this same
// short a countdown cutting the current episode off before a reader
// even had a real chance to notice the card and dismiss it. A full
// real minute gives that same reader room to actually see and cancel
// it instead.
const UPNEXT_COUNTDOWN_SECONDS = 60;

function buildUpNextOverlay(episode, onPlayNow, onDismiss) {
  const overlay = el('div', 'jellio-player-upnext jellio-player-upnext-hidden');

  const thumbTag = (episode.ImageTags && episode.ImageTags.Primary) || episode.ParentThumbImageTag;
  const thumb = el('div', 'jellio-player-upnext-thumb');
  if (thumbTag) {
    thumb.style.backgroundImage = 'url(' + getImageUrl(episode.Id, 'Primary', { tag: thumbTag, maxWidth: 400 }) + ')';
  }
  overlay.appendChild(thumb);

  const body = el('div', 'jellio-player-upnext-body');
  body.appendChild(el('div', 'jellio-player-upnext-eyebrow', 'Next Episode'));
  const epLabel =
    episode.IndexNumber != null && episode.ParentIndexNumber != null
      ? 'S' + episode.ParentIndexNumber + ' E' + episode.IndexNumber + ' · '
      : '';
  body.appendChild(el('div', 'jellio-player-upnext-title', epLabel + (episode.Name || '')));

  const actions = el('div', 'jellio-player-upnext-actions');
  const playButton = el('button', 'jellio-player-upnext-play', 'Play now');
  playButton.type = 'button';
  playButton.addEventListener('click', onPlayNow);
  const dismissButton = el('button', 'jellio-player-upnext-dismiss', 'Dismiss');
  dismissButton.type = 'button';
  dismissButton.setAttribute('aria-label', 'Dismiss next episode preview');
  dismissButton.addEventListener('click', onDismiss);
  actions.appendChild(playButton);
  actions.appendChild(dismissButton);
  body.appendChild(actions);
  overlay.appendChild(body);

  return { overlay: overlay, playButton: playButton };
}

function buildEndScreenModal(options) {
  const item = options.item;
  const nextEpisode = options.nextEpisode;
  const onPlayNext = options.onPlayNext;
  const onReplay = options.onReplay;
  const onClose = options.onClose;
  const onBack = options.onBack;
  let countdownSecs = options.initialCountdown;

  const overlay = el('div', 'jellio-player-endscreen');
  const backdrop = el('div', 'jellio-player-endscreen-backdrop');
  backdrop.addEventListener('click', onClose);
  overlay.appendChild(backdrop);

  const card = el('div', 'jellio-player-endscreen-card');

  const closeButton = el('button', 'jellio-player-endscreen-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close end screen');
  const closeIcon = el('span', 'material-icons', 'close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', onClose);
  card.appendChild(closeButton);

  const header = el('div', 'jellio-player-endscreen-header');
  const badge = el('div', 'jellio-player-endscreen-badge');
  const badgeIcon = el('span', 'material-icons', nextEpisode ? 'skip_next' : 'check_circle');
  badgeIcon.setAttribute('aria-hidden', 'true');
  badge.appendChild(badgeIcon);
  badge.appendChild(el('span', '', nextEpisode ? 'Up Next' : 'Completed'));
  header.appendChild(badge);

  const seriesTitle = (nextEpisode && (nextEpisode.SeriesName || item.SeriesName)) || (item.Type === 'Episode' ? item.SeriesName : null);
  if (seriesTitle) {
    header.appendChild(el('div', 'jellio-player-endscreen-series', seriesTitle));
  }
  card.appendChild(header);

  const content = el('div', 'jellio-player-endscreen-content');

  const targetItem = nextEpisode || item;
  const thumbTag = (targetItem.ImageTags && (targetItem.ImageTags.Primary || targetItem.ImageTags.Thumb)) ||
                   targetItem.ParentThumbImageTag ||
                   (targetItem.BackdropImageTags && targetItem.BackdropImageTags[0]);

  const thumb = el('div', 'jellio-player-endscreen-thumb');
  if (thumbTag) {
    const imgType = (targetItem.ImageTags && targetItem.ImageTags.Primary) ? 'Primary' :
                    (targetItem.BackdropImageTags && targetItem.BackdropImageTags[0]) ? 'Backdrop' : 'Thumb';
    thumb.style.backgroundImage = 'url(' + getImageUrl(targetItem.Id, imgType, { tag: thumbTag, maxWidth: 640 }) + ')';
  }

  if (targetItem.RunTimeTicks) {
    const mins = Math.round(targetItem.RunTimeTicks / (TICKS_PER_SECOND * 60));
    if (mins > 0) {
      thumb.appendChild(el('span', 'jellio-player-endscreen-duration', mins + ' min'));
    }
  }
  content.appendChild(thumb);

  const info = el('div', 'jellio-player-endscreen-info');
  if (nextEpisode) {
    const epLabel = (nextEpisode.ParentIndexNumber != null && nextEpisode.IndexNumber != null)
      ? 'Season ' + nextEpisode.ParentIndexNumber + ' · Episode ' + nextEpisode.IndexNumber
      : '';
    if (epLabel) {
      info.appendChild(el('div', 'jellio-player-endscreen-sub', epLabel));
    }
    info.appendChild(el('h2', 'jellio-player-endscreen-title', nextEpisode.Name || 'Next Episode'));
    if (nextEpisode.Overview) {
      info.appendChild(el('p', 'jellio-player-endscreen-overview', nextEpisode.Overview));
    }
  } else {
    info.appendChild(el('h2', 'jellio-player-endscreen-title', item.Name || 'Completed'));
    const sub = item.Type === 'Episode'
      ? (item.SeriesName ? item.SeriesName + ' · Season Finale' : 'Season Finale')
      : (item.ProductionYear ? String(item.ProductionYear) : 'Feature Film');
    info.appendChild(el('div', 'jellio-player-endscreen-sub', sub));
    if (item.Overview) {
      info.appendChild(el('p', 'jellio-player-endscreen-overview', item.Overview));
    }
  }
  content.appendChild(info);
  card.appendChild(content);

  const actions = el('div', 'jellio-player-endscreen-actions');
  let primaryBtn = null;
  let countdownTimer = null;

  if (nextEpisode) {
    primaryBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-primary');
    primaryBtn.type = 'button';
    const playIcon = el('span', 'material-icons', 'play_arrow');
    playIcon.setAttribute('aria-hidden', 'true');
    primaryBtn.appendChild(playIcon);
    const playText = el('span', 'jellio-player-endscreen-btn-text', 'Play Next Episode');
    primaryBtn.appendChild(playText);

    function updateBtnCountdown() {
      if (countdownSecs > 0) {
        playText.textContent = 'Play Next Episode (' + countdownSecs + ')';
      } else {
        playText.textContent = 'Play Next Episode';
      }
    }

    if (countdownSecs > 0) {
      updateBtnCountdown();
      countdownTimer = window.setInterval(function () {
        countdownSecs -= 1;
        updateBtnCountdown();
        if (countdownSecs <= 0) {
          if (countdownTimer) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
          }
          onPlayNext();
        }
      }, 1000);
    }

    primaryBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onPlayNext();
    });
    actions.appendChild(primaryBtn);

    const replayBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-secondary');
    replayBtn.type = 'button';
    const replayIcon = el('span', 'material-icons', 'replay');
    replayIcon.setAttribute('aria-hidden', 'true');
    replayBtn.appendChild(replayIcon);
    replayBtn.appendChild(el('span', '', 'Replay'));
    replayBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onReplay();
    });
    actions.appendChild(replayBtn);

    const backBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-ghost');
    backBtn.type = 'button';
    const backIcon = el('span', 'material-icons', item.SeriesId ? 'arrow_back' : 'home');
    backIcon.setAttribute('aria-hidden', 'true');
    backBtn.appendChild(backIcon);
    backBtn.appendChild(el('span', '', item.SeriesId ? 'Back to Show' : 'Back to Home'));
    backBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onBack();
    });
    actions.appendChild(backBtn);
  } else {
    primaryBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-primary');
    primaryBtn.type = 'button';
    const replayIcon = el('span', 'material-icons', 'replay');
    replayIcon.setAttribute('aria-hidden', 'true');
    primaryBtn.appendChild(replayIcon);
    primaryBtn.appendChild(el('span', '', 'Replay'));
    primaryBtn.addEventListener('click', onReplay);
    actions.appendChild(primaryBtn);

    const backBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-secondary');
    backBtn.type = 'button';
    const backIcon = el('span', 'material-icons', item.SeriesId ? 'arrow_back' : 'home');
    backIcon.setAttribute('aria-hidden', 'true');
    backBtn.appendChild(backIcon);
    backBtn.appendChild(el('span', '', item.SeriesId ? 'Back to Show' : 'Back to Home'));
    backBtn.addEventListener('click', onBack);
    actions.appendChild(backBtn);
  }

  card.appendChild(actions);
  overlay.appendChild(card);

  card.addEventListener('click', function (e) {
    if (primaryBtn && !primaryBtn.contains(e.target) && countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
      const playText = primaryBtn.querySelector('.jellio-player-endscreen-btn-text');
      if (playText) playText.textContent = 'Play Next Episode';
    }
  });

  function cleanup() {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    overlay.remove();
  }

  return {
    overlay: overlay,
    primaryBtn: primaryBtn,
    cleanup: cleanup,
  };
}

// A real choice instead of always just seeking straight to the saved
// position, ported from Harbor's own player/resume-prompt.tsx idea:
// shown once, over the paused frame at that exact position (the video
// element is already seeked there by the time this appears, see
// renderPlayer's own loadedmetadata handler), Start Over is a real
// choice this runtime did not offer before rather than something to
// dig for elsewhere.
function buildResumePrompt(percent, onResume, onRestart) {
  const overlay = el('div', 'jellio-player-resume-overlay');
  const panel = el('div', 'jellio-player-resume-panel');
  panel.appendChild(el('div', 'jellio-player-resume-title', 'Resume playback?'));
  if (percent != null) {
    panel.appendChild(el('div', 'jellio-player-resume-subtitle', percent + '% watched'));
  }
  const actions = el('div', 'jellio-player-resume-actions');
  const resumeButton = el('button', 'jellio-player-resume-play', 'Resume');
  resumeButton.type = 'button';
  resumeButton.addEventListener('click', onResume);
  const restartButton = el('button', 'jellio-player-resume-restart', 'Start Over');
  restartButton.type = 'button';
  restartButton.addEventListener('click', onRestart);
  actions.appendChild(resumeButton);
  actions.appendChild(restartButton);
  panel.appendChild(actions);
  overlay.appendChild(panel);
  return { overlay: overlay, resumeButton: resumeButton };
}

// Every failure below this point used to just console.warn and return
// undefined, leaving root exactly as blank as root.textContent = ''
// left it: picking a stream Gelato could no longer actually resolve
// (a dead debrid link, an expired scrape) read as playback simply not
// starting, no different from working correctly and just taking a
// moment, the same silent-failure shape already found and fixed on
// the search screen and the boot splash. A real message plus a real
// way back out of the dead route is the same fix again here.
// onRetry, when given, is the negotiation calls above that actually
// failed (item lookup, PlaybackInfo, media source), run again against
// the same params: on a bad connection the exact same request often
// just needs asking a second time, not a trip back to Change Stream
// first. Left out for the two cases retrying cannot help either way
// (no id at all, or a source that already played and then failed to
// decode, same failure either retry attempt), same reasoning
// components/networkState.js's own renderRetry() documents.
function renderPlaybackError(root, itemId, message, onRetry) {
  root.textContent = '';
  const wrap = el('div', 'jellio-player-error');
  wrap.appendChild(el('p', 'jellio-service-empty', message));
  const actions = el('div', 'jellio-screen-retry-actions');
  if (onRetry) {
    const retry = el('button', 'jellio-player-error-back', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    actions.appendChild(retry);
  }
  const back = el('button', 'jellio-player-error-back', 'Back');
  back.type = 'button';
  back.addEventListener('click', function () {
    navigateTo(itemId ? '#/item?id=' + itemId : '#/home');
  });
  actions.appendChild(back);
  wrap.appendChild(actions);
  root.appendChild(wrap);
}

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

// Mirrors buildStreamUrl's own real directPlay/useHls computation
// (runtime/api.js) exactly, so this screen can know ahead of building
// a stream URL whether it is about to land on the one real path
// (confirmed directly against Jellyfin's own DynamicHlsController.cs)
// that can never honour a real StartTimeTicks: its own dynamic segment
// endpoint throws outright the instant it sees one, the master
// playlist always spanning a title's real position 0 onward instead,
// real seeking there only ever reachable through this runtime's own
// native video.currentTime assignment once metadata is ready, not a
// query param buildStreamUrl can still send.
function willUseHls(source, forceTranscode) {
  const directPlay = !forceTranscode && canBrowserDirectPlay(source);
  return !directPlay && supportsNativeHls();
}

export async function renderPlayer(root, params) {
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

  // Real, explicit signal (components/groupWatchInvites.js's own toast,
  // components/groupWatch.js's and this screen's own chat watch cards,
  // the only three real places that ever set it) that this exact
  // navigation is a reader following an already-started group's own
  // link, not a reader actually choosing to start something. Every
  // other real path here (the stream picker, this screen's own episode
  // list, Up Next, a card's own Play) carries no such param, real
  // feedback asked this to matter: a joiner should only ever join, a
  // reader who genuinely pressed Play should always publish and notify
  // the group, this exact title already playing there or not.
  const isGroupJoinNavigation = params.get('groupJoin') === '1';

  // Play already navigates here the instant it is pressed
  // (components/streamPicker.js's own real choice, or the detail
  // screen's own Play button skipping the picker outright): everything
  // below this point negotiates a real stream before a single frame can
  // show, real work that takes real time on a slow connection, so this
  // is the only thing telling the reader Play actually did something in
  // that gap rather than nothing at all.
  renderLoading(root);

  // Started immediately, alongside getItemDetails below: this has no
  // real dependency on it or on the PlaybackInfo negotiation further
  // down, only on the current session, but used to only ever start
  // once both had already fully resolved. Real cost found live: a
  // cold cache added a full extra round trip to the front of every
  // playback start just to check a language preference that rarely
  // even changes anything, consumed by the audio match below once it
  // actually needs it.
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

  // Real Jellyfin SyncPlay: set once this exact title is what the
  // reader's own current group already has on its real queue
  // (runtime/syncPlay.js's own getCurrentPlaylistTarget(), populated
  // from a real pushed PlayQueue update, confirmed against real
  // QueueCore.js before this was written), null otherwise, in which
  // case every real transport control below stays exactly what it
  // already was: a plain local action, no different from before this
  // existed. Mutable rather than a const snapshot: a reader can join a
  // group, or the group's own queue can populate, after this screen has
  // already mounted, see the onSyncGroupChange() subscription further
  // down. Checked this early, ahead of the real PlaybackInfo negotiation
  // below, so a reader joining a group already partway through this
  // title negotiates the real stream starting from the group's own
  // position, not this reader's own unrelated resume point.
  let syncPlaylistItemId = null;
  const initialSyncTarget = getCurrentPlaylistTarget();
  let startTicks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
  if (initialSyncTarget && initialSyncTarget.itemId === itemId) {
    syncPlaylistItemId = initialSyncTarget.playlistItemId;
    startTicks = initialSyncTarget.startPositionTicks || 0;
  }

  // Real feedback: a joiner's own slow stream negotiation (a real
  // debrid/usenet source still resolving, well before getPlaybackInfo
  // below ever returns) used to run with the rest of an already Playing
  // group none the wiser, everyone else's own playback carrying on while
  // this reader caught up alone. notifyBuffering() here is the exact
  // same real SyncPlay signal the 'waiting' listener further down this
  // file already sends for a later mid session stall (real
  // WaitingGroupState.cs already pauses and holds the whole group for
  // it, confirmed against real source before this was written), just
  // sent immediately rather than waiting on a real <video> 'waiting'
  // event that has nothing to fire on yet this early. startJoinSync
  // alongside it is Jellio's own real reason a reader now paused on the
  // other end of that can actually read (this file's own header on
  // runtime/api.js's startJoinSync explains why real SyncPlay carries no
  // reason of its own for it). isInitialGroupCatchUp only, deliberately
  // this file's one real mount time check: a later stall further down
  // this same file already covers itself independently through its own
  // 'waiting' listener, this only ever fires once, right here.
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

  // components/streamPicker.js's own real choice, when there was more
  // than one to choose from: negotiates that exact source instead of
  // whichever one GetPlaybackMediaSources would have defaulted to.
  // Absent on every other route that reaches here (a resumed Up Next
  // card, the hero's own Play button skipping the picker outright for
  // a one-source item), same default negotiation as before the picker
  // existed.
  const preferredMediaSourceId = params.get('mediaSourceId') || undefined;

  let playbackInfo;
  try {
    playbackInfo = await getPlaybackInfo(itemId, startTicks, preferredMediaSourceId);
  } catch (err) {
    console.warn('Jellio: could not negotiate playback', err);
    renderPlaybackError(root, itemId, describeNetworkFailure('the stream', err), function () {
      renderPlayer(root, params);
    });
    return undefined;
  }

  let mediaSource = playbackInfo && playbackInfo.MediaSources && playbackInfo.MediaSources[0];
  // Real field on Jellyfin's own PlaybackInfoResponse, kept for the
  // whole time this title stays open the same way every real
  // jellyfin-web session already does, real feedback traced a live
  // server log to prove out: without it on the stream URL, an audio
  // track switch's own new request had no way to tell Jellyfin's own
  // TranscodingJobHelper it was not just the same request arriving
  // twice, and no new real ffmpeg process ever started for it.
  let playSessionId = playbackInfo && playbackInfo.PlaySessionId;
  if (!mediaSource) {
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

  root.textContent = '';

  // Real feedback: a saved default audio language preference
  // (screens/settings.js's own Language section) only actually reaches
  // this MediaSource if Jellyfin's own PlaybackInfo negotiation
  // happened to compute the right DefaultAudioStreamIndex for it, not
  // guaranteed for a debrid resolved release the way it would be for a
  // real local file with its own already indexed MediaStreams.
  // runtime/api.js's own matchAudioStreamIndex() checks this directly
  // against the MediaSource negotiation already returned; a real match
  // that differs from what the server defaulted to triggers one more
  // real negotiation with that index explicit, the same real mechanism
  // a manual audio track switch further down already uses (a bare
  // stream URL query param change alone never starts a new real
  // transcode job server side, confirmed against a real server log
  // before that code was written, same real constraint here). Declared
  // here rather than down by the audio track popover below so this
  // same real variable carries the match forward into that popover's
  // own "what's active" check too, not just this file's first request.
  let currentAudioStreamIndex = null;
  try {
    const user = await currentUserPromise;
    const preferredLanguage = user && user.Configuration && user.Configuration.AudioLanguagePreference;
    const matchedIndex = preferredLanguage ? matchAudioStreamIndex(mediaSource, preferredLanguage) : null;
    // Real bug, found live: skipping this whenever matchedIndex already
    // equalled mediaSource.DefaultAudioStreamIndex assumed that field
    // meant the real encode would already select it, matching what the
    // audio menu itself showed as active. Confirmed live it does not:
    // DefaultAudioStreamIndex is only Jellyfin's own advisory pick, the
    // real ffmpeg track selection never actually reads it, only a real
    // explicit AudioStreamIndex on the stream request itself, the same
    // real constraint switchAudioTrack below already works around
    // unconditionally. Matched or not against the default, this now
    // always renegotiates with the real index explicit, the one thing
    // that actually gets a match to play rather than just look picked.
    // Gated on more than one real audio track existing at all: a single
    // track file has no real choice to make regardless of what it is
    // tagged as, forcing a transcode over it would only add real server
    // load and HLS/segment overhead a plain direct play never needed.
    if (matchedIndex != null && getAudioStreams(mediaSource).length > 1) {
      const rematched = await getPlaybackInfo(itemId, startTicks, mediaSource.Id, matchedIndex);
      const rematchedSource = rematched && rematched.MediaSources && rematched.MediaSources[0];
      if (rematchedSource) {
        mediaSource = rematchedSource;
        playSessionId = rematched.PlaySessionId;
        currentAudioStreamIndex = matchedIndex;
      }
    }
  } catch (err) {
    console.warn('Jellio: could not match preferred audio language', err);
  }

  // Real feedback found the same real gap this pass fixed for
  // mid-playback seeking already applies to a saved resume position
  // too: a Static direct play request's own StartTimeTicks only
  // actually seeks on a source that honours HTTP Range, never
  // guaranteed against a live Gelato proxy, so a resumed title on an
  // otherwise direct playable source needs the same forced transcode
  // every other real seek in this file now uses.
  // currentAudioStreamIndex != null alongside startTicks > 0: buildStreamUrl's
  // own forceTranscode auto-detection compares opts.audioStreamIndex against
  // mediaSource.DefaultAudioStreamIndex, but mediaSource above has already
  // been reassigned to the fresh negotiation for that exact index by the
  // time this runs, so that comparison is checking the negotiated source
  // against itself and never catches it. Real bug, found live: a matched
  // preferred-language track still went out over a Static request that
  // silently serves the file's own real default track regardless, German
  // playing despite an English preference. Forcing it explicitly here is
  // the same real fix switchAudioTrack/seekToAbsoluteSeconds below already
  // use for the identical reason.
  const forcedTranscode = startTicks > 0 || currentAudioStreamIndex != null;
  const streamUrl = buildStreamUrl(itemId, mediaSource, startTicks, {
    audioStreamIndex: currentAudioStreamIndex,
    forceTranscode: forcedTranscode,
    playSessionId: playSessionId,
  });

  // A forced transcode (runtime/api.js's own canBrowserDirectPlay veto,
  // or a real saved position above) only ever encodes forward from the
  // StartTimeTicks baked into streamUrl above, nothing earlier exists
  // in that output at all, so video.currentTime === 0 there is really
  // startTicks, not the title's own real start. Direct play serves the
  // whole file as is, so its own currentTime already is the real
  // position, offset 0. Real duration comes from item.RunTimeTicks for
  // the same reason: a live transcode has no complete moov atom yet
  // for video.duration to read.
  //
  // A native HLS engine (willUseHls() above) is neither of those two
  // cases: confirmed directly against Jellyfin's own
  // DynamicHlsController.cs, StartTimeTicks on the master playlist
  // request is never read at all, its own generated playlist always
  // spanning the title's real position 0 onward regardless, so
  // buildStreamUrl above never actually sends it there in the first
  // place (real ArgumentException from the server's own dynamic
  // segment endpoint the instant it tries). video.currentTime already
  // is the real absolute position for that case too then, same as
  // direct play, no offset needed, just a real native seek once
  // metadata is ready instead of relying on a server side start point
  // that was never asked for.
  let streamIsTranscoded = forcedTranscode || !canBrowserDirectPlay(mediaSource);
  const initialUsesHls = willUseHls(mediaSource, forcedTranscode);
  let needsStartOffset = streamIsTranscoded && !initialUsesHls;
  let streamOffsetTicks = needsStartOffset ? startTicks : 0;
  // Consumed once by the loadedmetadata listener further down, then
  // cleared: every later reload that needs the same real treatment
  // (switchAudioTrack, seekToAbsoluteSeconds's own HLS branch,
  // switchSource, selectBurnedInSubtitle) sets this fresh right before
  // its own video.load() rather than this screen keeping a second
  // parallel copy of the same real "where should this land" decision.
  let pendingNativeSeekSeconds = startTicks > 0 && !needsStartOffset ? startTicks / TICKS_PER_SECOND : null;
  // Catalog RunTimeTicks is the only real duration available up front
  // (the comment above explains why a live transcode's own moov atom
  // is not there yet), but for a remote, debrid backed source this
  // plugin never itself probed, that nominal figure can genuinely
  // disagree with the file actually being served, real feedback: the
  // scrubber running longer than the episode actually plays.
  // reconcileDuration() below swaps in the browser's own real
  // video.duration the moment it is known and finite, offset back by
  // streamOffsetTicks the same way currentPositionTicks() already
  // does for position, so a forced transcode's own truncated-from-
  // startTicks duration still reads as the title's full real length.
  // The negotiated source's own length (probed) before the catalog's.
  let durationSeconds = (mediaSource.RunTimeTicks || item.RunTimeTicks || 0) / TICKS_PER_SECOND;
  // The browser's own video.duration is the episode's length for a file
  // or an HLS stream, but for a converted stream it is only what has
  // been produced so far and grows as you watch, which made position
  // and length climb together and counted as 100% watched. So it is
  // only used where it is final, and the length comes from the source
  // (or the server's probe of it) otherwise.
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

  // A real saved position asks first rather than always silently
  // seeking there: autoplay stays off until the reader actually picks
  // Resume or Start Over below, the paused frame at the saved position
  // showing through behind that choice instead of playback already
  // running underneath it. Never shown for a real SyncPlay join
  // (syncPlaylistItemId set): startTicks there is the group's own
  // shared position, not this reader's own personal one, so there is
  // nothing of theirs to ask about, and Start Over's own real reset
  // would be wrong for everyone else already in the group.
  const hasResumePosition = startTicks > 0 && !syncPlaylistItemId;

  // Real feedback: this used to read straight off the item passed in,
  // which for an Episode is the episode's own real DTO, its own
  // BackdropImageTags almost always empty and its own ImageTags.Primary
  // the episode's own thumbnail, not the show's own real artwork every
  // other player chrome (Nuvio's own pause screen included) actually
  // shows here. SeriesId/ParentBackdropImageTags/SeriesPrimaryImageTag
  // are the real fields Jellyfin's own Episode DTO already carries for
  // exactly this, confirmed against BaseItemDto before writing this,
  // not guessed at; a movie has no series to prefer over its own.
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

  // Same real series-aware fallback as the backdrop above, the one
  // other real image type Jellyfin's own metadata providers save
  // against a title (ParentLogoImageTag for an Episode, ImageTags.Logo
  // for a movie or the series itself): a transparent title treatment,
  // not guaranteed to exist for every real title the way a backdrop
  // usually is, so this can come back null.
  function seriesAwareLogoUrl(maxWidth) {
    const artId = isEpisodeItem && item.SeriesId ? item.SeriesId : itemId;
    const tag = isEpisodeItem ? item.ParentLogoImageTag : item.ImageTags && item.ImageTags.Logo;
    if (!tag) return null;
    return getImageUrl(artId, 'Logo', { tag: tag, maxWidth: maxWidth });
  }

  const video = document.createElement('video');
  video.className = 'jellio-player-video';
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
  // A bare <video> with nothing decoded yet paints its own flat grey
  // frame, real feedback landed on this screen as the show's own real
  // artwork replaced by a blank box for however long the first real
  // frame takes to arrive.
  const posterUrl = seriesAwareArtworkUrl(1600);
  if (posterUrl) video.poster = posterUrl;

  // Ported from the same real Nuvio loading screen this whole pass
  // works from: the title's own real logo art breathing in place while
  // a stream is still loading, standing in for a plain spinner. Real
  // feedback: this used to only ever show once, for the very first
  // load, nothing telling the reader a later reload (an audio track or
  // subtitle switch, a source change, seekToAbsoluteSeconds's own mp4
  // fallback branch) was doing anything at all until it either finished
  // or the toast next to it timed out looking abandoned. showLoadingLogo
  // is now called at every one of those real reload points too, not
  // just the first one.
  let loadingLogo = null;
  const logoUrl = seriesAwareLogoUrl(800);
  let logoWatchdog = null;
  let logoLastTime = 0;
  let logoLastFrames = 0;
  let logoShownAt = 0;

  // The logo goes as soon as the video is really running, whichever way
  // that shows: 'playing', or the clock moving while unpaused. Checked
  // on a short timer as well as on events, since a reload that resumes
  // before the logo goes up, or a webview that fires few media events,
  // leaves the events with nothing to react to.
  function logoSeesPlayback() {
    if (!loadingLogo || video.paused || video.ended || video.seeking) return false;
    // Frames being drawn count too, whatever the clock and events say.
    const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
    if (quality) {
      if (quality.totalVideoFrames < logoLastFrames) logoLastFrames = quality.totalVideoFrames;
      else if (quality.totalVideoFrames - logoLastFrames >= 3) return true;
    }
    const moved = Math.abs(video.currentTime - logoLastTime) > 0.05;
    logoLastTime = video.currentTime;
    return moved || (video.readyState >= 3 && Date.now() - logoShownAt > 1500 && video.currentTime > 0);
  }

  function showLoadingLogo() {
    if (!logoUrl) return;
    if (loadingLogo) loadingLogo.remove();
    loadingLogo = el('div', 'jellio-player-loading-logo');
    loadingLogo.style.backgroundImage = 'url(' + logoUrl + ')';
    root.appendChild(loadingLogo);
    logoLastTime = video.currentTime;
    logoLastFrames = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
    logoShownAt = Date.now();
    if (typeof video.requestVideoFrameCallback === 'function') {
      const shown = loadingLogo;
      let frames = 0;
      const onFrame = function () {
        if (loadingLogo !== shown) return;
        if (!video.paused && ++frames >= 3) {
          hideLoadingLogo();
          return;
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    window.clearInterval(logoWatchdog);
    logoWatchdog = window.setInterval(function () {
      if (!loadingLogo) {
        window.clearInterval(logoWatchdog);
        return;
      }
      if (logoSeesPlayback()) hideLoadingLogo();
    }, 400);
  }

  video.addEventListener('playing', function () {
    if (loadingLogo && video.readyState >= 3) hideLoadingLogo();
  });
  ['timeupdate', 'seeked', 'canplay'].forEach(function (type) {
    video.addEventListener(type, function () {
      if (logoSeesPlayback()) hideLoadingLogo();
    });
  });

  // Real bug, found live: showLoadingLogo()'s own overlay only ever had
  // a success path, video's own real 'playing' event. A source slow
  // enough to time out at the proxy in front of this server (a real
  // 524 from a still-resolving Gelato/debrid source, confirmed against
  // a real browser console) aborts video.play() instead, 'playing'
  // never fires, and attemptPlay()'s own toast a few lines down used to
  // fire with this same real logo still sitting there over top of it,
  // covering the one real message telling a reader what happened.
  // attemptPlay's own final failure branch calls this directly now.
  function hideLoadingLogo() {
    window.clearInterval(logoWatchdog);
    if (loadingLogo) {
      loadingLogo.remove();
      loadingLogo = null;
    }
  }

  let subtitleStyle = loadSubtitleStyle();
  applySubtitleStyle(video, subtitleStyle);

  // === Auto hide shell: everything the reader can tap, faded out
  // together after IDLE_HIDE_MS of no activity while actually playing,
  // the same real convention every mainstream streaming app already
  // uses, confirmed against the real Nuvio screenshot this whole pass
  // works from. Always shown again the instant something needs
  // attention (paused, a fresh tap/move) rather than only on a timer.
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
  backButton.setAttribute('aria-label', 'Back');
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


  // Native browser API, no server involvement at all: video.poster
  // above and video.src set further down are the only real state a PiP
  // window needs, the same element just rendered in a second real OS
  // level window. Hidden outright rather than disabled on a browser
  // with no real support (document.pictureInPictureEnabled false, real
  // case: Safari's own older releases, some real WebViews), a dead
  // button is worse than one that is not there.
  if (document.pictureInPictureEnabled) {
    const pipButton = el('button', 'jellio-player-back jellio-player-pip');
    pipButton.type = 'button';
    pipButton.setAttribute('aria-label', 'Picture in picture');
    const pipIcon = el('span', 'material-icons picture_in_picture_alt');
    pipIcon.setAttribute('aria-hidden', 'true');
    pipButton.appendChild(pipIcon);
    pipButton.addEventListener('click', function () {
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(function () {});
      } else {
        video.requestPictureInPicture().catch(function (err) {
          console.warn('Jellio: could not enter picture in picture', err);
        });
      }
    });
    video.addEventListener('enterpictureinpicture', function () {
      pipButton.classList.add('jellio-player-pip-active');
    });
    video.addEventListener('leavepictureinpicture', function () {
      pipButton.classList.remove('jellio-player-pip-active');
    });
    topbarActions.appendChild(pipButton);
  }

  // Leaving the tab while playing moves the video into picture in
  // picture (a browser only allows that from a media session handler or
  // a user action, so both are tried), and coming back moves it home.
  // Either way, a picture that froze while away is nudged back to life.
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

  function enterPipForTabLeave() {
    if (!document.pictureInPictureEnabled || !isAutoPipEnabled()) return Promise.resolve();
    if (video.paused || video.ended || video.disablePictureInPicture || document.pictureInPictureElement) return Promise.resolve();
    return video.requestPictureInPicture().catch(function () {});
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', function () {
        enterPipForTabLeave();
      });
    } catch (err) {
      // Not every browser knows this action.
    }
  }
  document.addEventListener('visibilitychange', onTabVisibility);
  function onTabVisibility() {
    if (document.visibilityState === 'hidden') {
      enterPipForTabLeave();
      return;
    }
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(function () {});
    checkForFrozenPicture();
  }
  video.addEventListener('leavepictureinpicture', checkForFrozenPicture);

  // Absolute OS level fullscreen for the whole player shell, video
  // plus every real control this runtime draws on top of it, real
  // feedback asked for this directly: a bare <video> already gets a
  // native fullscreen affordance for free on some browsers, but only
  // for the video element itself, none of this runtime's own controls
  // along with it. document.exitFullscreen() rather than a fullscreen
  // rule scoped to just the video also gives Escape/the OS's own real
  // fullscreen chrome a single consistent real element to leave.
  // Feature detected and hidden outright rather than disabled the same
  // way the PiP button above already is: real case with no Fullscreen
  // API at all, iOS Safari, whose own native WKWebView fullscreen for
  // <video> already covers the same real job a different way this
  // runtime has no control over.
  let exitFullscreenOnCleanup = function () {};
  // Hoisted rather than left as the block's own local const: the
  // keyboard shortcut handler further down needs a real reference to
  // click, same reason skipBackButton/skipForwardButton/playPauseButton
  // are already declared at this same outer scope instead of buried
  // inside a conditional.
  let fullscreenButton = null;
  const fullscreenEnabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  if (fullscreenEnabled) {
    fullscreenButton = el('button', 'jellio-player-back jellio-player-fullscreen');
    fullscreenButton.type = 'button';
    fullscreenButton.setAttribute('aria-label', 'Fullscreen');
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
      // Leaving this screen still fullscreen would strand whatever
      // renders next behind the OS's own fullscreen chrome instead of
      // this runtime's own real shell, same reasoning cleanup() below
      // already tears down every other piece of this screen's own
      // state rather than letting it bleed into the next real one.
      if (isFullscreen()) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    };
    topbarActions.appendChild(fullscreenButton);
  }

  // Group Watch chat, right here in the player chrome rather than only
  // reachable through the sidebar's own separate overlay
  // (components/groupWatch.js), real feedback asked for exactly this:
  // a reader mid episode with a group open should not have to leave
  // playback to say something. Same real endpoints that panel already
  // polls (runtime/api.js's own getGroupWatchMessages/
  // sendGroupWatchMessage), scoped to whichever real group this reader
  // is actually in, not necessarily the one this exact title is synced
  // to (chatting stays open to any joined group, playback sync above
  // does not). Kept deliberately plainer than that panel's own version,
  // no avatars here, this is a quick glance while playback keeps
  // running, not a second real chat surface competing with it.
  const CHAT_POLL_MS = 3000;
  let stopChatOnCleanup = function () {};
  // Hoisted same real reason fullscreenButton above is: the keyboard
  // shortcut handler further down needs a real way to close this panel
  // on Escape without duplicating chatToggleButton's own click handler
  // (poll timer stop included) a second time.
  let closeChatPanel = function () {};
  const currentSyncGroup = getCurrentGroup();
  if (currentSyncGroup) {
    const chatToggleButton = el('button', 'jellio-player-back jellio-player-chat-toggle');
    chatToggleButton.type = 'button';
    chatToggleButton.setAttribute('aria-label', 'Group Watch chat');
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
    chatInput.placeholder = 'Message the group…';
    chatInput.maxLength = 500;
    const chatSendButton = el('button', 'jellio-player-chat-send');
    chatSendButton.type = 'button';
    chatSendButton.setAttribute('aria-label', 'Send');
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

    // Real bug, audit-found: same real unbounded DOM growth
    // components/groupWatch.js's own full chat panel had, a real
    // playback session left open long enough appends one row per poll
    // tick with nothing ever removed. Same real cap the backend's own
    // GroupWatchChatService.MaxMessagesPerGroup already enforces.
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
        if (message.ItemId) row.appendChild(el('span', 'jellio-player-chat-message-cta', 'Click to join'));
        chatMessages.appendChild(row);
        chatLastMessageId = Math.max(chatLastMessageId, message.Id);
      });
      while (chatMessages.children.length > MAX_CHAT_DOM_MESSAGES) {
        chatMessages.removeChild(chatMessages.firstChild);
      }
      if (messages.length) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // No Start a Pick trigger here, deliberately: this chat is already
    // "plainer than that panel's own version" by design (this file's
    // own header above), components/groupWatch.js's own full panel is
    // where a pick actually starts. Voting on one already under way
    // still belongs here though, real feedback's own reason this whole
    // chat exists in the first place: not leaving playback to act on
    // the group.
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
          // Same real tradeoff every other poll in this codebase already
          // makes, tries again next tick rather than surfacing an error
          // over a single missed real round trip.
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
  skipBackButton.setAttribute('aria-label', 'Back 10 seconds');
  const skipBackIcon = el('span', 'material-icons replay_10');
  skipBackIcon.setAttribute('aria-hidden', 'true');
  skipBackButton.appendChild(skipBackIcon);

  const playPauseButton = el('button', 'jellio-player-transport jellio-player-playpause-center');
  playPauseButton.type = 'button';
  playPauseButton.setAttribute('aria-label', 'Pause');
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
    // In an active real SyncPlay group, a plain local play()/pause()
    // here would only ever move this one reader's own player: real
    // SyncPlay instead has every group member, initiator included,
    // apply the action once the server broadcasts it back as a real
    // SyncPlayCommand (this screen's own onSyncCommand handler further
    // down), the same real round trip a native client in the same
    // group already makes. syncPlaylistItemId null (no group, or one
    // with nothing on the real queue for this title) falls straight
    // back to the plain local toggle this button always had.
    if (syncPlaylistItemId) {
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
  skipForwardButton.setAttribute('aria-label', 'Forward 10 seconds');
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
  seekBar.setAttribute('aria-label', 'Seek');
  const durationLabel = el('span', 'jellio-player-time', durationSeconds ? formatTime(durationSeconds) : '--:--');
  seekWrap.appendChild(seekBar);
  seekRow.appendChild(currentTimeLabel);
  seekRow.appendChild(seekWrap);
  seekRow.appendChild(durationLabel);

  // === Scrub preview: BaseItemDto.Trickplay's own tile sheets, real
  // endpoint confirmed against TrickplayController.cs before writing
  // this. Only ever real for a title Jellyfin's own background task
  // already generated one for, a real local ffmpeg pass over the whole
  // file: no real source this runtime ever plays is a local file (this
  // whole plugin's own header says as much, every one is a live Gelato
  // proxy in front of a debrid/usenet host), so this stays quietly
  // absent, no broken preview shown, on most titles until that changes
  // upstream. Real hover feature when the data is there, silent no-op
  // when it is not.
  const trickplayInfo = pickTrickplayInfo(item, mediaSource.Id);
  {
    // Without trickplay (every Gelato stream), frames come from
    // Jellio/scrub-preview, one per SCRUB_BUCKET_SECONDS, grabbed
    // server side and cached. If the first few can't be grabbed, the
    // preview falls back to just the time.
    const SCRUB_BUCKET_SECONDS = 10;
    const videoStream = (mediaSource.MediaStreams || []).find(function (stream) {
      return stream.Type === 'Video';
    });
    const aspect = videoStream && videoStream.Width && videoStream.Height ? videoStream.Width / videoStream.Height : 16 / 9;
    const previewWidth = trickplayInfo ? trickplayInfo.Width : 240;
    const previewHeight = trickplayInfo ? trickplayInfo.Height : Math.round(240 / aspect);

    const scrubPreview = el('div', 'jellio-player-scrub-preview');
    const scrubImage = el('div', 'jellio-player-scrub-preview-image');
    const scrubTime = el('div', 'jellio-player-scrub-preview-time', '0:00');
    scrubImage.style.width = previewWidth + 'px';
    scrubImage.style.height = previewHeight + 'px';
    scrubPreview.appendChild(scrubImage);
    scrubPreview.appendChild(scrubTime);
    seekWrap.appendChild(scrubPreview);

    const thumbsPerTile = trickplayInfo ? Math.max(1, trickplayInfo.TileWidth * trickplayInfo.TileHeight) : 1;
    let lastTileIndex = -1;
    let serverFrames = !trickplayInfo;
    let wantedBucket = -1;
    let shownBucket = -1;
    let bucketTimer = null;
    let failures = 0;
    let successes = 0;
    const loadedBuckets = new Set();
    if (serverFrames) scrubImage.classList.add('jellio-player-scrub-preview-image-empty');

    function showBucket(bucket) {
      if (bucket === shownBucket) return;
      shownBucket = bucket;
      scrubImage.style.backgroundImage = 'url("' + getScrubPreviewUrl(itemId, mediaSource.Id, bucket) + '")';
      scrubImage.style.backgroundSize = 'cover';
      scrubImage.style.backgroundPosition = 'center';
      scrubImage.classList.remove('jellio-player-scrub-preview-image-empty');
    }

    function loadBucket(bucket) {
      if (loadedBuckets.has(bucket)) {
        showBucket(bucket);
        return;
      }
      const image = new Image();
      image.onload = function () {
        successes++;
        loadedBuckets.add(bucket);
        if (wantedBucket === bucket) showBucket(bucket);
      };
      image.onerror = function () {
        failures++;
        if (!successes && failures >= 3) {
          serverFrames = false;
          scrubImage.hidden = true;
        }
      };
      image.src = getScrubPreviewUrl(itemId, mediaSource.Id, bucket);
    }

    function showScrubPreview(clientX) {
      const rect = seekBar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const hoveredSeconds = ratio * durationSeconds;

      if (trickplayInfo) {
        const thumbnailIndex = Math.max(0, Math.floor((hoveredSeconds * 1000) / trickplayInfo.Interval));
        const tileIndex = Math.floor(thumbnailIndex / thumbsPerTile);
        const indexInTile = thumbnailIndex % thumbsPerTile;
        const col = indexInTile % trickplayInfo.TileWidth;
        const row = Math.floor(indexInTile / trickplayInfo.TileWidth);

        if (tileIndex !== lastTileIndex) {
          lastTileIndex = tileIndex;
          scrubImage.style.backgroundImage =
            'url(' + getTrickplayTileUrl(itemId, mediaSource.Id, trickplayInfo.Width, tileIndex) + ')';
        }
        scrubImage.style.backgroundSize =
          trickplayInfo.TileWidth * trickplayInfo.Width + 'px ' + trickplayInfo.TileHeight * trickplayInfo.Height + 'px';
        scrubImage.style.backgroundPosition = -(col * trickplayInfo.Width) + 'px ' + -(row * trickplayInfo.Height) + 'px';
      } else if (serverFrames && durationSeconds > 0) {
        // Only ask once the pointer settles, so sweeping across the bar
        // doesn't start a frame grab for every bucket passed over.
        const bucket = Math.floor(hoveredSeconds / SCRUB_BUCKET_SECONDS) * SCRUB_BUCKET_SECONDS;
        if (bucket !== wantedBucket) {
          wantedBucket = bucket;
          if (bucketTimer) window.clearTimeout(bucketTimer);
          if (loadedBuckets.has(bucket)) showBucket(bucket);
          else
            bucketTimer = window.setTimeout(function () {
              bucketTimer = null;
              loadBucket(bucket);
            }, 150);
        }
      }
      scrubTime.textContent = formatTime(hoveredSeconds);

      const previewHalfWidth = (scrubImage.hidden ? scrubTime.offsetWidth : previewWidth) / 2;
      const left = Math.min(rect.width - previewHalfWidth, Math.max(previewHalfWidth, ratio * rect.width));
      scrubPreview.style.left = left + 'px';
      scrubPreview.classList.add('jellio-player-scrub-preview-visible');
    }

    function hideScrubPreview() {
      scrubPreview.classList.remove('jellio-player-scrub-preview-visible');
      if (bucketTimer) window.clearTimeout(bucketTimer);
      bucketTimer = null;
      wantedBucket = -1;
    }

    seekWrap.addEventListener('mousemove', function (event) {
      showScrubPreview(event.clientX);
    });
    seekWrap.addEventListener('mouseleave', hideScrubPreview);
    seekWrap.addEventListener(
      'touchmove',
      function (event) {
        if (event.touches[0]) showScrubPreview(event.touches[0].clientX);
      },
      { passive: true },
    );
    seekWrap.addEventListener('touchend', hideScrubPreview);
    seekWrap.addEventListener('touchcancel', hideScrubPreview);
  }

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

  // Small popovers (speed/subtitles/audio/sleep) all anchor above the
  // pill and close each other out on open; sourcePanel/episodesPanel
  // below are a different real shape entirely (a full height side
  // panel, matching the real Nuvio screenshot's own Quellen/Episoden
  // layout), tracked separately so opening one does not also have to
  // know about the other kind.
  const popovers = [];
  function closePopovers(except) {
    popovers.forEach(function (entry) {
      if (entry.menu === except) return;
      entry.menu.classList.add('jellio-player-popover-hidden');
      entry.button.setAttribute('aria-expanded', 'false');
    });
  }
  // Real bug, live-reported: app.css's own .jellio-player-popover carries
  // one fixed `right` anchor shared by every one of these, so every
  // popover actually opened in the exact same spot regardless of which
  // pill button was clicked. That only ever looked right for Audio, the
  // pill's own real rightmost small popover (Sleep sits further right
  // still, but as a "large" two column panel Audio's own width already
  // reached close to that same fixed anchor); Speed sits at the pill's
  // own left edge, its own real gap to that anchor the exact "opens on
  // the very right" reader complaint. Centering this on the real
  // clicked button instead, clamped to shell's own real bounds so a
  // popover opened from the pill's own left edge still cannot run off
  // screen to the left.
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

  // === Volume popover: a mute toggle beside a real range slider bound
  // straight to video.volume, the one real control this screen never
  // had - ArrowUp/ArrowDown/M already worked (adjustVolume/toggleMute
  // further down), nothing ever showed the current level or gave a
  // reader with no keyboard a way to reach it. syncVolumeUI() is the
  // one real place that keeps the pill's own icon/label, this slider,
  // and the mute button all in agreement, called from here and from
  // adjustVolume/toggleMute below so a keyboard shortcut and a slider
  // drag both always leave every real piece of this in the same state. ===
  const volumeMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden jellio-player-popover-volume');
  const volumeMuteButton = el('button', 'jellio-player-popover-volume-mute');
  volumeMuteButton.type = 'button';
  volumeMuteButton.setAttribute('aria-label', 'Mute');
  const volumeMuteIcon = el('span', 'material-icons volume_up');
  volumeMuteIcon.setAttribute('aria-hidden', 'true');
  volumeMuteButton.appendChild(volumeMuteIcon);
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'jellio-player-popover-volume-slider';
  volumeSlider.min = '0';
  volumeSlider.max = '100';
  volumeSlider.setAttribute('aria-label', 'Volume');
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

  // === Subtitles popover: a language column plus that language's own
  // track list, matching the real Nuvio Untertitel screenshot rather
  // than a single flat list, since a release can carry more than one
  // real track for the same language (SDH, forced, a second scraped
  // source) that a flat list would otherwise bury. ===
  const subtitleMenu = el('div', 'jellio-player-popover jellio-player-popover-large jellio-player-popover-hidden');
  const subtitleColumns = el('div', 'jellio-player-popover-columns');
  const subtitleLanguageList = el('div', 'jellio-player-popover-list jellio-player-popover-languages');
  const subtitleList = el('div', 'jellio-player-popover-list jellio-player-popover-tracks');
  subtitleColumns.appendChild(subtitleLanguageList);
  subtitleColumns.appendChild(subtitleList);
  subtitleMenu.appendChild(subtitleColumns);
  let activeTrack = null;
  let selectedSubtitleLanguage = null;
  // Real state, not just the option button's own class toggle: both
  // rebuildSubtitleMenu (a source switch handing back a whole new
  // track list) and this same reader's own language filter tear the
  // whole option list down and rebuild it from scratch, which would
  // otherwise lose which one was actually active. Index alone, not the
  // stream object itself, since a rebuild after a real source switch
  // hands back a whole new set of stream objects for what might still
  // be logically the same track.
  let activeSubtitleStreamIndex = null;

  // Real bug, found live on macOS Safari: a reader with the OS's own
  // Accessibility > Captions "Prefer closed captions and SDH" setting
  // on had a track this runtime had explicitly turned Off (activeTrack
  // null, no <track> element even in the DOM) showing anyway. Confirmed
  // against real WebKit behaviour, not this runtime's own guess: Safari
  // runs its own automatic caption track selection whenever
  // video.textTracks changes, independent of and after whatever mode
  // this runtime already set, and that selection can re-enable a track
  // this runtime never chose. video.textTracks itself fires a real
  // 'change' event every time that happens (spec behaviour, not
  // Safari-only), so reasserting this runtime's own real choice there
  // catches it the moment it happens rather than trusting a mode set
  // once at track creation to stay put. reentrant guards the loop
  // below: setting .mode fires this same 'change' event again, and
  // only assigning when a track's real mode already differs keeps that
  // from looping forever once every track already matches.
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

  // Real bug, found live: a release's own real WebVTT file (Jellyfin's
  // own subtitle conversion, whatever positioning the original
  // embedded/SSA track carried through with it) can set a real per-cue
  // position/align/line, on-screen text specifically often placed away
  // from the usual bottom-center dialogue spot. Confirmed live as the
  // box jumping left, center and right line to line: not a rendering
  // bug, that positioning is real, honoured by every browser's own
  // WebVTT engine exactly as authored. ::cue in CSS cannot override a
  // cue's own real position/align/line at all, only a cue's own real
  // JS properties can, so every cue this track just parsed gets pinned
  // to the same real bottom-center spot here instead, consistent
  // placement mattering more for a subtitle track than preserving
  // positioning this runtime has no picker for anyway.
  function normalizeCuePositions(textTrack) {
    const cues = textTrack.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (typeof VTTCue === 'undefined' || !(cue instanceof VTTCue)) continue;
      try {
        cue.align = 'center';
        cue.position = 'auto';
        // Real feedback, live: 'auto' line left cues sitting right on
        // the bottom safe area, and (worse) let two cues with close but
        // not identical real timestamps each get their own
        // browser-computed auto line, an inconsistent real gap between
        // them rather than a tight two line stack. A fixed real
        // percentage with snapToLines off is deterministic instead of
        // heuristic: every real cue box starts at the same real 82%
        // down the frame regardless of how many others are near it in
        // time, closing that gap and moving normal single line dialogue
        // up off the very bottom edge in the same real change.
        cue.snapToLines = false;
        cue.line = 82;
        cue.size = 100;
      } catch (err) {
        // A malformed value on one real cue is not worth losing every
        // other cue on the same track over.
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
      // Explicit disable ahead of the removal below: real WebKit
      // versions have kept whatever cue was actively rendering on
      // screen at the exact instant a <track> element left the DOM,
      // not clearing it until the next cue boundary or a real reload.
      // Disabling first, a real mode change the spec guarantees clears
      // active cues immediately, closes that gap.
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

  // Real feedback, live: an embedded subtitle track on one of Gelato's
  // own remote sources can take real minutes to actually show up (or
  // fail outright on anime specifically, reported live: real anime
  // releases are almost always muxed with a real soft ASS/SSA track,
  // Jellyfin's own SubtitleController has to demux that out of the
  // whole remote container itself, SubtitleEncoder's own real ffmpeg
  // work). That real extraction is cached server side once it actually
  // finishes (SubtitleEncoder.cs's own GetSubtitleCachePath, confirmed
  // against real source), so a request that dies part way through
  // (a reverse proxy's own real read timeout sitting in front of
  // Jellyfin, well short of what a slow remote extraction can take, is
  // the likely real cause here, not something this plugin's own client
  // code controls) is not necessarily a real dead end: a fresh request
  // either lands on that now-cached real result, or at minimum gives
  // the server another real attempt rather than this reader's own one
  // shot silently giving up. MAX_SUBTITLE_LOAD_ATTEMPTS below is that
  // real retry budget, a short real pause between attempts so a
  // genuinely bad stream index (an instant real 404, retrying that
  // is pure waste) does not spin as fast as it can rather than actually
  // waiting on anything.
  const MAX_SUBTITLE_LOAD_ATTEMPTS = 4;
  const SUBTITLE_RETRY_DELAY_MS = 4000;

  function attachSubtitleTrack(stream, attempt) {
    if (activeSubtitleStreamIndex !== stream.Index) return;
    // A retry's own failed predecessor otherwise sat in the DOM
    // indefinitely, one orphaned <track> (and TextTrack) per attempt,
    // enforceSubtitleTrackModes() left to disable each one it finds
    // rather than never having anything to clean up in the first place.
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
      // Same real guard 'error' below already has, missing here: switch
      // subtitles more than once before a slower .vtt fetch resolves and
      // every earlier track's own 'load' still fires later, each one
      // unconditionally setting track.track.mode = 'showing' on its own
      // now-orphaned TextTrack and calling enforceSubtitleTrackModes()
      // off a stale closure. Confirmed live as exactly the reported
      // symptom: switching around a while, a subtitle eventually shows
      // but from whichever stale load won the race, its own
      // normalizeCuePositions() pass having run against cues that are
      // not what enforceSubtitleTrackModes() actually left showing,
      // inconsistent line/position from switch to switch.
      if (activeTrack !== track) return;
      if (!track.track) return;
      normalizeCuePositions(track.track);
      if (subtitleOffsetSec !== 0) {
        applyCuesOffset(track.track, subtitleOffsetSec);
      }
      track.track.mode = 'showing';
      enforceSubtitleTrackModes();
    });
    // A <track> element has no equivalent of the main video's own
    // 'error' handling anywhere else in this file: a failed fetch (or a
    // fetched file the WebVTT parser rejects outright) used to fail
    // silently, real bug found live behind exactly this gap, nothing
    // ever telling a reader why a subtitle they picked just never
    // showed up.
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

  // An image based subtitle (PGS, VobSub) has no WebVTT form to hand
  // the <track> element selectSubtitle above uses, nothing this
  // runtime's own <video> can render on its own: the only real way to
  // show one at all is asking Jellyfin's own transcoder to draw it
  // directly into the video, the same real renegotiate-then-reload
  // switchAudioTrack below already does for the same real reason a
  // bare GET alone was proven not enough for a same MediaSourceId,
  // different stream index request like this one.
  async function selectBurnedInSubtitle(stream, optionButton) {
    if (activeTrack) {
      // Same real reason selectSubtitle's own Off path disables before
      // removing: clears whatever cue is actively rendering immediately
      // rather than leaving it on screen until the reload below lands.
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
      // Same real willUseHls() check switchAudioTrack/seekToAbsoluteSeconds
      // both make: a burned in subtitle still forces a real transcode,
      // but that can still land on native HLS, its own master playlist
      // never actually honouring the StartTimeTicks below either.
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

  // Rebuildable rather than built once: a source switch below can hand
  // back a mediaSource with an entirely different subtitle track list
  // (a different scraped file has its own real embedded/external
  // tracks), so the menu has to reflect whichever mediaSource is
  // actually loaded right now, not the one playback started on.
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
        // Image based tracks (PGS, VobSub) get a plain label suffix
        // rather than a whole second list: real feedback asked for
        // these to just work, not for a UI that makes the reader
        // think about the real format difference up front.
        const label =
          (stream.DisplayTitle || stream.Language || 'Subtitle') + (stream.IsTextSubtitleStream ? '' : ' (image)');
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
    const subtitleStreams = getSubtitleStreams(mediaSource);
    if (!subtitleStreams.length) {
      subtitleButton.disabled = true;
      return;
    }
    subtitleButton.disabled = false;
    selectedSubtitleLanguage = null;

    // Real feedback: labelled "None" this read as "no subtitles",
    // indistinguishable at a glance from the right column's own real
    // "Off" a reader could apparently also have active at once, same
    // real column this one's own real Language filter, not a subtitle
    // selection: "no language filter, every track" is what selecting
    // this actually does, "All languages" says that outright instead.
    const noneOption = el('button', 'jellio-player-popover-option jellio-player-popover-option-active', 'All languages');
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
  // Real feedback: a saved default subtitle language preference
  // (screens/settings.js's own Language section, the same
  // Configuration.SubtitleLanguagePreference field matchAudioStreamIndex's
  // own audio equivalent already reads above) never actually reached the
  // player - nothing here ever auto-attached a track, only a reader's own
  // manual pick into the Subtitles popover ever did, every single
  // episode, with the real .vtt fetch (runtime/api.js's own
  // buildSubtitleUrl, GelatoApiController's own prefetch now warms its
  // server side cache ahead of time but still has to be asked for) only
  // ever starting after that click, not before it. Matching and
  // attaching here instead, the moment this menu first builds, starts
  // that fetch as early as this screen possibly can - concurrent with
  // waitForPlayableBuffer's own buffering below, not gated behind it.
  (async function () {
    let matched = null;
    try {
      const user = await currentUserPromise;
      const preferredLanguage = user && user.Configuration && user.Configuration.SubtitleLanguagePreference;
      matched = preferredLanguage ? matchSubtitleStream(mediaSource, preferredLanguage) : null;
    } catch (err) {
      console.warn('Jellio: could not match preferred subtitle language', err);
    }
    if (matched) activeSubtitleStreamIndex = matched.Index;
    rebuildSubtitleMenu();
    if (matched) attachSubtitleTrack(matched, 0);
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
  syncSection.appendChild(el('div', 'jellio-player-style-group-label', 'Delay / Sync'));
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
  const resetBtn = el('button', 'jellio-player-popover-option', 'Reset');
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

  // currentAudioStreamIndex is declared much further up now, right
  // after this title's own first real negotiation resolves a
  // MediaSource: a real preferred-language match found there needs to
  // already be in this same real variable by the time this popover's
  // own rebuildAudioMenu() below asks "what's active", not reset back
  // to null here and silently overridden.
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
          // Real feedback: switching never seemed to reach the server at
          // all, confirmed against real Jellyfin logs, on a device with
          // no devtools available to see why. A visible toast the moment
          // a tap on a track is actually received, before anything else
          // runs, turns "does the request even leave the browser" into
          // something a reader can answer just by watching the screen.
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
      boostOption.textContent = 'Dialogue Boost / Night Mode: ' + (dialogueBoostEnabled ? 'On' : 'Off');
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

  // Static=true (a direct playable file) serves every embedded track
  // as is, no way to tell the server which one the browser should
  // decode: real Jellyfin behaviour, confirmed against jellyfin-web's
  // own playbackmanager.js before writing this, is that picking a non
  // default audio track forces a real transcode so the server can
  // actually mux just that one in, the same real reload seekToAbsoluteSeconds
  // and switchSource below already use for their own real reasons.
  async function switchAudioTrack(stream) {
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    // Real feedback, chased through a real server log all the way
    // down: a bare GET against the already live stream URL, only its
    // own AudioStreamIndex query param changed, reusing the exact same
    // PlaySessionId the title already opened on, never once produced a
    // genuinely new transcode job server side, no matter how correctly
    // that URL was built (confirmed directly, a blocking alert showing
    // the real URL) or how long a real gap sat between it and the old
    // session's own stop report (also tried). switchSource below never
    // had that problem, and the one real thing it does differently is
    // exactly this: a fresh PlaybackInfo negotiation, handing back a
    // fresh PlaySessionId of its own, the same real mechanism
    // jellyfin-web's own playbackmanager.js already uses for a track
    // switch too (confirmed against its source before writing this),
    // not a query param bolted onto whichever stream URL was already
    // live. Renegotiating the same real way now, MediaSourceId held to
    // the source already playing, AudioStreamIndex the one real new
    // thing being asked for.
    try {
      reportPlaybackStopped(itemId, mediaSource.Id, resumeTicks);
      const info = await getPlaybackInfo(itemId, resumeTicks, mediaSource.Id, stream.Index);
      const negotiated = info && info.MediaSources && info.MediaSources[0];
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
      // Real bug, found live: stream.Index !== mediaSource.DefaultAudioStreamIndex
      // never actually caught anything, since mediaSource was just
      // reassigned to the fresh negotiation for stream.Index two lines up,
      // so its own DefaultAudioStreamIndex already matches stream.Index by
      // the time this runs. That let forceTranscode below stay false
      // whenever resumeTicks was 0, going out as a Static direct play
      // request whose AudioStreamIndex query param a server ignores
      // entirely on that path (this file's own header above already
      // documents that real Jellyfin behaviour) - reported live as the
      // track silently not switching, or the stream dying outright once
      // whatever the file's own real default track was collided with the
      // rest of this reload. Same real fix seekToAbsoluteSeconds below
      // already proved out: force it unconditionally, an explicit track
      // switch always needs the real transcode this comment already says
      // it does, not just a resumed one.
      //
      // Real bug, found live against a real server log: forcing the
      // transcode above still was not enough on its own. A native HLS
      // engine's own master playlist request never actually reads
      // StartTimeTicks at all (DynamicHlsController.cs, confirmed
      // directly), always spanning the title's real position 0 onward
      // regardless of what streamOffsetTicks below assumed, so an audio
      // switch mid playback landed right back at the start the instant
      // this ran on Safari or the macOS Desktop app's own WKWebView.
      // willUseHls() below is the same real check the initial load and
      // seekToAbsoluteSeconds already make: an HLS destination gets a
      // real native seek once its own fresh metadata is ready instead
      // of a server side offset that request was never going to honour.
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

  // === Sleep timer popover ===
  // null whenever this mode is not the one active; the duration mode
  // above it stays a real Services/SleepTimerService.cs timer, this one
  // decremented from the timeupdate handler below instead, the two
  // never both armed at once (each option below clears the other
  // mode's own state before arming its own).
  let sleepTimerEpisodesRemaining = null;
  let sleepOption = null;
  function syncSleepActive(isActive) {
    sleepButton.classList.toggle('jellio-player-pill-btn-active', Boolean(isActive));
    if (sleepOption) {
      sleepOption.classList.toggle('jellio-player-popover-option-active', Boolean(isActive));
    }
  }
  const sleepMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const cancelOption = el('button', 'jellio-player-popover-option', 'Cancel timer');
  cancelOption.type = 'button';
  cancelOption.addEventListener('click', function () {
    sleepTimerEpisodesRemaining = null;
    cancelSleepTimer().then(function () {
      syncSleepActive(false);
      closePopovers(null);
    });
  });
  sleepMenu.appendChild(cancelOption);
  sleepMenu.appendChild(el('div', 'jellio-player-style-group-label', 'Stop after'));
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
  sleepMenu.appendChild(el('div', 'jellio-player-style-group-label', 'Or stop after'));
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
  castTitle.appendChild(el('span', null, 'Cast to TV / Device'));
  castHeader.appendChild(castTitle);

  const castRefreshBtn = el('button', 'jellio-player-cast-refresh');
  castRefreshBtn.type = 'button';
  castRefreshBtn.setAttribute('aria-label', 'Refresh available devices');
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
      disconnectBtn.appendChild(el('span', null, 'Disconnect'));
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
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-title', 'Looking for devices...'));
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-sub', 'Scanning your network for available Smart TVs'));
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
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', 'Smart TVs'));
        tvTargets.forEach(function (target) {
          castBody.appendChild(buildCastDeviceButton(target, 'tv'));
        });
      }

      if (otherTargets.length > 0) {
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', 'Other Jellyfin Clients'));
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

        const emptyTitle = el('div', 'jellio-player-cast-empty-title', 'No available devices found');
        emptyBox.appendChild(emptyTitle);

        const emptySub = el('div', 'jellio-player-cast-empty-sub', hasWireless
          ? 'No Smart TVs or Jellyfin apps were detected on your local network. You can still stream via the wireless options below.'
          : 'Make sure your Smart TV or Chromecast is turned on and connected to the same Wi-Fi network.');
        emptyBox.appendChild(emptySub);
        castBody.appendChild(emptyBox);
      }

      // Wireless display & AirPlay section
      if (hasWireless) {
        const wirelessTitle = el('div', 'jellio-player-cast-section-title', 'Wireless Display & Streaming');
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
          info.appendChild(el('div', 'jellio-player-cast-device-sub', 'Opens browser menu to connect to Chromecast or Google TV'));
          gcastBtn.appendChild(info);

          gcastBtn.addEventListener('click', async function () {
            try {
              castMenu.classList.add('jellio-player-popover-hidden');
              const currentSec = (streamOffsetTicks / TICKS_PER_SECOND) + (video.currentTime || 0);
              const castStreamUrl = buildStreamUrl(itemId, mediaSource, 0, {
                audioStreamIndex: currentAudioStreamIndex,
              });

              if (window.cast && window.cast.framework) {
                await castToGoogleCast(castStreamUrl, item, currentSec);
                video.pause();
                showPlayerToast('Streaming via Google Cast');
              } else if (typeof video.remote !== 'undefined' && typeof video.remote.prompt === 'function') {
                await promptRemotePlayback(video);
                showPlayerToast('Streaming via Wireless Display');
              } else {
                await castToGoogleCast(castStreamUrl, item, currentSec);
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
          info.appendChild(el('div', 'jellio-player-cast-device-name', 'Apple AirPlay'));
          info.appendChild(el('div', 'jellio-player-cast-device-sub', 'Opens AirPlay menu to stream to Apple TV or AirPlay 2 Smart TV'));
          airplayBtn.appendChild(info);

          airplayBtn.addEventListener('click', function () {
            castMenu.classList.add('jellio-player-popover-hidden');
            try {
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
      errBox.appendChild(el('div', 'jellio-player-cast-empty-title', 'Could not search for devices'));
      errBox.appendChild(el('div', 'jellio-player-cast-empty-sub', 'Check your connection to the Jellyfin server and try again.'));
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
      btn.appendChild(el('span', 'jellio-player-cast-device-badge', 'Smart TV'));
    }

    btn.addEventListener('click', async function () {
      try {
        const currentTicks = Math.round((streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0)) * TICKS_PER_SECOND);
        video.pause();
        castMenu.classList.add('jellio-player-popover-hidden');
        showPlayerToast('Streaming to ' + target.name + '...');
        await castToJellyfinSession(target, itemId, currentTicks, mediaSource, currentAudioStreamIndex, currentSubtitleStreamIndex);
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
  const castBannerText = el('span', 'jellio-player-cast-banner-text', 'Streaming to Smart TV');

  const castBannerControls = el('div', 'jellio-player-cast-banner-controls');
  const bannerSkipBack = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipBack.type = 'button';
  bannerSkipBack.setAttribute('aria-label', 'Skip back 10 seconds');
  bannerSkipBack.appendChild(el('span', 'material-icons replay_10'));
  bannerSkipBack.addEventListener('click', function () {
    skipBackButton.click();
  });

  const bannerPlayPause = el('button', 'jellio-player-cast-banner-btn');
  bannerPlayPause.type = 'button';
  bannerPlayPause.setAttribute('aria-label', 'Play or pause on TV');
  const bannerPlayPauseIcon = el('span', 'material-icons pause');
  bannerPlayPause.appendChild(bannerPlayPauseIcon);
  bannerPlayPause.addEventListener('click', function () {
    playPauseButton.click();
  });

  const bannerSkipForward = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipForward.type = 'button';
  bannerSkipForward.setAttribute('aria-label', 'Skip forward 30 seconds');
  bannerSkipForward.appendChild(el('span', 'material-icons forward_30'));
  bannerSkipForward.addEventListener('click', function () {
    skipForwardButton.click();
  });

  const bannerDisconnect = el('button', 'jellio-player-cast-banner-disconnect', 'Resume Here');
  bannerDisconnect.type = 'button';
  bannerDisconnect.setAttribute('aria-label', 'Stop casting and resume locally');
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
      castBannerText.textContent = 'Streaming to ' + (castState.name || 'Smart TV');
      bannerPlayPauseIcon.textContent = castState.isPaused ? 'play_arrow' : 'pause';
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
  const autoSkipLabel = el('span', '', 'Auto-skip Intros');
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
  sleepOptionLabel.appendChild(el('span', '', 'Sleep Timer'));
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
  shortcutsOption.appendChild(el('span', '', 'Keyboard Shortcuts'));
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
  shortcutsHeader.appendChild(el('h3', 'jellio-player-shortcuts-title', 'Keyboard Shortcuts'));
  const shortcutsClose = el('button', 'jellio-player-shortcuts-close', '×');
  shortcutsClose.type = 'button';
  shortcutsClose.setAttribute('aria-label', 'Close keyboard shortcuts');
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

  // === Sources side panel, real cards components/streamPicker.js's
  // own buildSourceCard() already builds for the pre-playback picker,
  // reused here rather than a second, plainer list. ===
  const sourcePanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const sourcePanelHeader = el('div', 'jellio-player-sidepanel-header');
  sourcePanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', 'Sources'));
  const sourceCloseButton = el('button', 'jellio-player-sidepanel-close', 'Close');
  sourceCloseButton.type = 'button';
  sourcePanelHeader.appendChild(sourceCloseButton);
  sourcePanel.appendChild(sourcePanelHeader);
  // Real feedback, live: Change Stream had no language filter at all,
  // unlike components/streamPicker.js's own pre-playback picker.
  // buildLanguageFilterRow() is that same real chip row, rebuilt
  // (rebuildSourceFilter below) whenever sourceOptions itself actually
  // changes rather than on every list re-render, since the real
  // language set behind it only ever changes when a fresh real fetch
  // lands, not on every source pick/highlight update.
  const sourceFilterContainer = el('div', 'jellio-player-sidepanel-filters');
  sourcePanel.appendChild(sourceFilterContainer);
  const sourceList = el('div', 'jellio-player-sidepanel-list');
  sourcePanel.appendChild(sourceList);

  let sourceOptions = [mediaSource];
  let selectedSourceLanguage = null;
  let switchingSource = false;

  function closeSidePanels() {
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
  }

  function rebuildSourceFilter() {
    sourceFilterContainer.textContent = '';
    selectedSourceLanguage = null;
    const filterRow = buildLanguageFilterRow(sourceOptions, function (code) {
      selectedSourceLanguage = code;
      rebuildSourceMenu();
    });
    if (filterRow) sourceFilterContainer.appendChild(filterRow);
  }

  function rebuildSourceMenu() {
    sourceList.textContent = '';
    const filtered = selectedSourceLanguage
      ? sourceOptions.filter(function (source) {
          return sourceAudioLanguages(source).indexOf(selectedSourceLanguage) !== -1;
        })
      : sourceOptions;
    filtered.forEach(function (source) {
      sourceList.appendChild(
        buildSourceCard(
          source,
          function (picked) {
            closeSidePanels();
            if (picked.Id !== mediaSource.Id) switchSource(picked);
          },
          source.Id === mediaSource.Id,
        ),
      );
    });
  }

  sourceButton.addEventListener('click', function () {
    closePopovers(null);
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
    sourcePanel.classList.toggle('jellio-player-sidepanel-hidden');
    wakeControls();
  });
  sourceCloseButton.addEventListener('click', closeSidePanels);

  // === Episodes side panel: season tabs plus that season's own
  // episode list, only real for a series (Movies have nothing to
  // browse to here, sourceButton/episodesButton both stay disabled
  // until there is something real behind them). ===
  const episodesPanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const episodesPanelHeader = el('div', 'jellio-player-sidepanel-header');
  episodesPanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', 'Episodes'));
  const episodesCloseButton = el('button', 'jellio-player-sidepanel-close', 'Close');
  episodesCloseButton.type = 'button';
  episodesPanelHeader.appendChild(episodesCloseButton);
  episodesPanel.appendChild(episodesPanelHeader);
  const seasonTabs = el('div', 'jellio-player-sidepanel-tabs');
  episodesPanel.appendChild(seasonTabs);
  const episodeList = el('div', 'jellio-player-sidepanel-list');
  episodesPanel.appendChild(episodeList);
  episodesCloseButton.addEventListener('click', closeSidePanels);

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

  function loadSeasonEpisodes(seriesId, season, tabButton) {
    Array.prototype.forEach.call(seasonTabs.children, function (child) {
      child.classList.remove('jellio-player-sidepanel-tab-active');
    });
    if (tabButton) tabButton.classList.add('jellio-player-sidepanel-tab-active');
    episodeList.textContent = '';
    getEpisodes(seriesId, season.Id)
      .then(function (episodes) {
        episodes.forEach(function (episode) {
          episodeList.appendChild(buildEpisodeRow(episode));
        });
      })
      .catch(function (err) {
        console.warn('Jellio: could not load episodes for player episode panel', err);
      });
  }

  // Same real Specials-last convention screens/detail.js's own
  // season tabs already settled on (its own isSpecialsSeason): a
  // Specials "season" is real Jellyfin IndexNumber 0, real feedback
  // wanted it out of the lead spot there and this panel is the same
  // real tab bar concept, just duplicated into a second screen.
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
        orderedSeasons.forEach(function (season) {
          const tab = el('button', 'jellio-player-sidepanel-tab', season.Name || '');
          tab.type = 'button';
          tab.addEventListener('click', function () {
            loadSeasonEpisodes(item.SeriesId, season, tab);
          });
          seasonTabs.appendChild(tab);
          if (season.Id === item.SeasonId) loadSeasonEpisodes(item.SeriesId, season, tab);
        });
        if (!episodeList.children.length && orderedSeasons[0]) {
          loadSeasonEpisodes(item.SeriesId, orderedSeasons[0], seasonTabs.firstChild);
        }
      })
      .catch(function (err) {
        console.warn('Jellio: could not load seasons for player episode panel', err);
      });
  }

  episodesButton.addEventListener('click', function () {
    closePopovers(null);
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    episodesPanel.classList.toggle('jellio-player-sidepanel-hidden');
    wakeControls();
  });

  // switchSource() below used to fail exactly as silently as the three
  // routes into this whole screen already fixed above: the old source
  // just kept playing (or sitting paused) with nothing telling the
  // reader the source they just picked did not actually take, reading
  // as switching streams simply not doing anything. A toast is enough
  // here, unlike those three: the player itself is not blank, there is
  // already a real screen worth keeping in front of the reader.
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

  // video.play() returns a promise that can reject (a still-loading
  // source, a browser autoplay policy, the source erroring out
  // server side) and nothing anywhere in this file was ever looking
  // at whether it did: the play/pause button, the resume prompt below,
  // all called it and moved on, so a rejection here read as clicking
  // Play and genuinely nothing happening, no different from the three
  // routes into this screen already fixed above for the same reason.
  //
  // Real feedback, found live: the error toast below fired well before
  // the source was actually dead, playback then starting on its own
  // roughly 10 real seconds later once the underlying Gelato proxy
  // genuinely caught up, PREBUFFER_TIMEOUT_MS's own real fallback below
  // having forced this call before that real cushion was there to
  // begin with. One silent retry a few seconds later covers exactly
  // that gap without a scary error for what is often just the source
  // still catching up, the toast now only a real last resort.
  function attemptPlay(isRetry) {
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
        hideLoadingLogo();
        showPlayerToast('Could not start playback. Try pressing play again.');
      });
    }
  }

  // Real feedback: playback used to start the instant the browser had
  // the bare minimum to decode a first frame, which on a live
  // Gelato proxy still ramping up to its own real steady state
  // (TCP slow start, the debrid/usenet host itself warming up) meant
  // starting right as the download was at its slowest, stalling a
  // handful of times before the pipe actually caught up. Nuvio's own
  // real player buffers a real cushion before it ever starts for the
  // same reason. Holding attemptPlay behind a real buffered-ahead
  // check instead of firing on the first canplay gives the source that
  // same real head start. A hard timeout is still real feedback's own
  // fallback, same philosophy every other timeout in this codebase
  // already uses: a source too slow to ever clear the cushion should
  // still start rather than sit there forever looking broken.
  const PREBUFFER_TARGET_SECONDS = 8;
  // Real feedback, found live: 6s was well short of a real Gelato proxy
  // still ramping up on a fresh transcode, this fallback forcing
  // attemptPlay() early enough that video.play() rejected outright
  // (the error toast below firing), playback then starting on its own
  // roughly 10 real seconds later once the source genuinely caught up.
  // Longer here means this fallback rarely fires before the real
  // cushion above already has, attemptPlay's own one retry covering
  // whatever real variance is left beyond even this.
  const PREBUFFER_TIMEOUT_MS = 12000;
  // Gelato's own MediaSourceManagerDecorator only ever adds this marker
  // when AIOStreams' PROVIDE_STREAM_DATA setting is on and this specific
  // source came back with service.cached === true - a real "no download
  // wait ahead" signal, not a guess. The 8s/12s cushion above exists
  // entirely for the opposite case (an uncached torrent/usenet source
  // still ramping up); a confirmed-cached source has no such ramp-up to
  // wait out, so it gets a token cushion instead of the full one.
  const CONFIRMED_CACHED_TARGET_SECONDS = 1;
  const CONFIRMED_CACHED_TIMEOUT_MS = 2500;
  function isConfirmedCachedSource() {
    return !!(mediaSource && mediaSource.Formats && mediaSource.Formats.indexOf('gelato-cached') !== -1);
  }
  function waitForPlayableBuffer(callback) {
    let settled = false;
    const confirmedCached = isConfirmedCachedSource();
    const targetSeconds = confirmedCached ? CONFIRMED_CACHED_TARGET_SECONDS : PREBUFFER_TARGET_SECONDS;
    const timeoutMs = confirmedCached ? CONFIRMED_CACHED_TIMEOUT_MS : PREBUFFER_TIMEOUT_MS;
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
      if (bufferedAheadSeconds() >= targetSeconds || video.readyState >= 4) settle();
    }
    const fallbackTimer = window.setTimeout(settle, timeoutMs);
    video.addEventListener('progress', check);
    video.addEventListener('canplaythrough', check);
    check();
  }

  // A forced transcode has no full file sitting on the server to seek
  // within, only whatever ffmpeg has produced so far starting from its
  // own StartTimeTicks, so reaching a new absolute position there means
  // asking the server for a fresh stream starting there instead of
  // moving video.currentTime, the same real reload switchSource() and
  // Start Over above already use for the same reason. Direct play
  // serves the whole file already, so a plain currentTime assignment
  // still works and stays instant.
  // Real feedback: seeking moved the displayed time and kept playing
  // from wherever it already was, silently landing back at 0:00 a
  // moment later. A plain video.currentTime assignment only actually
  // seeks when the browser can complete a real HTTP Range request
  // against whatever is behind streamUrl, true for a local Jellyfin
  // file but never guaranteed for this runtime's own real sources: no
  // local media is ever assumed here (this whole plugin's own header
  // says as much), every one of them is a live Gelato proxy in front
  // of a debrid/usenet host, and not every one of those actually
  // serves partial content on request. Direct play used to assume
  // Range always worked and only rebuilt the stream from a fresh
  // StartTimeTicks for a forced transcode, the one real case with no
  // full file to seek within at all; every seek now takes that same
  // real reload regardless of streamIsTranscoded, since a request the
  // server actually starts encoding or serving from the right real
  // position is the only kind of seek this runtime can actually trust.
  //
  // Real bug, found the same real way the audio track switch was:
  // rebuilding the stream URL with a bare StartTimeTicks change while
  // reusing the title's own existing PlaySessionId never reliably
  // started a new real ffmpeg job (TranscodingJobHelper does not treat
  // that as different enough from the session already live), so the
  // seek looked like it moved and then quietly kept playing from
  // wherever the old job already was, landing back at the start once
  // that ran out. A real renegotiated PlaybackInfo call, the exact
  // same fix switchAudioTrack below already proved out, hands back a
  // genuinely fresh PlaySessionId a new job actually starts against.
  // Carries the reader's own active audio track and any burned in
  // subtitle track through the reload too: neither used to be passed
  // here at all, so a seek used to silently drop them back to default.
  // Real bug, found live: this always reached the renegotiate-and-reload
  // path below, and its own StartTimeTicks is exactly what
  // DynamicHlsController.cs's own dynamic segment endpoint throws
  // System.ArgumentException("StartTimeTicks is not allowed") on,
  // confirmed directly against a real server log. A native HLS engine
  // already seeks within the manifest it already has by itself, the
  // same browser-native mechanism direct play's own plain Range seek
  // used to lean on before this reload became the rule for every other
  // real source, Jellyfin generating whichever segment that lands on
  // (and restarting its own real encode from there server side) with
  // no renegotiation from this runtime needed at all.
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
      const negotiated = info && info.MediaSources && info.MediaSources[0];
      if (!negotiated) {
        showPlayerToast('Could not seek, that stream is no longer available.');
        return;
      }
      mediaSource = negotiated;
      playSessionId = info.PlaySessionId;
      streamIsTranscoded = true;
      // Recomputed fresh rather than assumed: a source that was direct
      // playing before this seek (the only way to reach here with
      // streamIsTranscoded already false) can still land on native HLS
      // now that forceTranscode is true, the same real willUseHls()
      // check the initial load above already makes for the same reason.
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

  // Same real reasoning as the play/pause button above: every manual
  // seek in an active real SyncPlay group goes through the server
  // (requestSyncSeek, real SyncPlay/Seek) rather than applying locally
  // first, so the resulting SyncPlayCommand this screen's own
  // onSyncCommand handler receives back is the one real thing that
  // actually moves this player, same as it would for any other member.
  function performSeek(targetSeconds) {
    if (getActiveCast()) {
      sendRemoteSeek(Math.round(targetSeconds * TICKS_PER_SECOND)).catch(function (err) {
        console.warn('Jellio: could not send Cast seek', err);
      });
      return;
    }
    if (syncPlaylistItemId) {
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

  // Re-negotiates PlaybackInfo against the picked source at the exact
  // position playback is at right now, the same real POST every source
  // starts with, then swaps the <video> element's own src to match:
  // there is no in-place source swap on a live element, only a fresh
  // load, real behaviour every browser's own media element already has.
  async function switchSource(source) {
    if (switchingSource) return;
    switchingSource = true;
    const resumeTicks = currentPositionTicks();
    const wasPlaying = !video.paused;
    const previousAudioLanguage = activeAudioLanguageCode();
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
      const info = await getPlaybackInfo(itemId, resumeTicks, source.Id);
      const negotiated = info && info.MediaSources && info.MediaSources[0];
      if (!negotiated) {
        showPlayerToast('That stream is no longer available.');
        return;
      }
      mediaSource = negotiated;
      // A source switch renegotiates PlaybackInfo, a real new session
      // with its own real PlaySessionId, not the one the title opened
      // on: kept for the rest of this switched-to source's own real
      // stream URLs the same way the initial one already is.
      playSessionId = info.PlaySessionId;
      if (activeTrack) {
        activeTrack.remove();
        activeTrack = null;
      }
      hasReportedStart = false;
      currentAudioStreamIndex = null;
      activeSubtitleStreamIndex = null;

      // Real bug fix: when switching streams, if the previous stream had an active
      // audio language (e.g. English, German, Japanese) and the new stream also carries
      // multiple audio tracks including that language, match and renegotiate with that
      // explicit track index rather than falling back to stream 0. Otherwise, the UI
      // shows that language as active while the browser video actually starts playing
      // whatever default track 0 is in the raw file.
      if (previousAudioLanguage && getAudioStreams(mediaSource).length > 1) {
        const matchedAudioIndex = matchAudioStreamIndex(mediaSource, previousAudioLanguage);
        if (matchedAudioIndex != null) {
          try {
            const rematched = await getPlaybackInfo(itemId, resumeTicks, source.Id, matchedAudioIndex);
            const rematchedSource = rematched && rematched.MediaSources && rematched.MediaSources[0];
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

      // Same real reason seekToAbsoluteSeconds forces a transcode for
      // any resumeTicks > 0: a Static direct play request's own
      // StartTimeTicks only actually seeks on a source that honours
      // HTTP Range, never guaranteed against a live Gelato proxy.
      // currentAudioStreamIndex != null forces transcode so Jellyfin
      // actually muxes the chosen audio track in.
      const sourceForceTranscode = resumeTicks > 0 || currentAudioStreamIndex != null;
      streamIsTranscoded = sourceForceTranscode || !canBrowserDirectPlay(mediaSource);
      // Same real willUseHls() check every other reload in this file
      // now makes: its own master playlist request never actually
      // reads StartTimeTicks (DynamicHlsController.cs, confirmed
      // directly), so a source switch mid playback needs a real native
      // seek once metadata is ready instead of trusting the server to
      // pick this position back up on its own.
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
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
      topbarMeta.textContent = sourceLabel(mediaSource);
      rebuildSubtitleMenu();
      rebuildAudioMenu();
      rebuildSourceMenu();
    } catch (err) {
      console.warn('Jellio: could not switch source', err);
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

  // === Idle auto hide: mousemove/touch/key wakes the shell back up
  // and resets the timer; a paused video, an open popover/side panel,
  // or negotiation still in flight all keep it up regardless. ===
  let idleTimer = null;
  // Real bug, found live: a still-blocked check used to just give up,
  // one shot, nothing left armed to try again once the block actually
  // cleared. wakeControls() below fires exactly once at mount, and a
  // freshly loaded episode (Up Next's own auto-advance chief among
  // them) is still negotiating, video.paused true, for real time after
  // that first check already fired and found itself blocked. Nothing
  // else in this file calls wakeControls() again once playback
  // actually starts, so the shell sat there until a reader happened to
  // interact with it by hand. Rescheduling itself here instead, the
  // same IDLE_HIDE_MS cadence, means a still-blocked check keeps
  // quietly retrying until whatever was blocking it (paused, a
  // popover, a side panel) actually clears, no external wake required.
  function hideControls() {
    const blocked =
      video.paused ||
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
  // Real feedback: a plain tap anywhere on the video used to toggle
  // play/pause underneath, indistinguishable from the shell's own
  // controls-reveal tap above and surprising every time a reader just
  // meant to bring the controls back. Every mainstream player's own
  // real chrome treats a tap on the video itself as reveal only, the
  // dedicated play/pause button (built above) the one real place that
  // actually toggles playback; root's own click listener above already
  // wakes the shell for a tap landing on video, nothing else needed
  // here.
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

  // Real gap: root.addEventListener('keydown', wakeControls) above only
  // ever fires once something inside root already has real focus (a
  // button just clicked, most often), the exact real reason this whole
  // block below is wired on document instead, catching a reader who
  // has not clicked anything on this screen yet at all. Reuses the same
  // real buttons every click already drives (skipBackButton.click(),
  // playPauseButton.click(), ...) rather than duplicating their own
  // Group Watch aware logic here a second time.
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
        // Priority order matches hideControls()'s own real "blocked"
        // check further down this file: a popover sits over a side
        // panel, both sit over the chat panel, closest-to-the-reader
        // wins rather than closing everything open at once.
        const openPopover = popovers.find(function (entry) {
          return !entry.menu.classList.contains('jellio-player-popover-hidden');
        });
        if (openPopover) {
          openPopover.menu.classList.add('jellio-player-popover-hidden');
        } else if (!sourcePanel.classList.contains('jellio-player-sidepanel-hidden')) {
          sourcePanel.classList.add('jellio-player-sidepanel-hidden');
        } else if (!episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) {
          episodesPanel.classList.add('jellio-player-sidepanel-hidden');
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


  // Shown to whoever this real Group Watch pause is actually holding up
  // for, not the reader it is actually about (isInitialGroupCatchUp's
  // own header above explains why real SyncPlay's own Pause command
  // alone never says why): pollSyncWait further down this file is what
  // actually drives its text and visibility, this is only the element.
  const syncWaitBanner = el('div', 'jellio-player-sync-wait');
  syncWaitBanner.appendChild(el('span', 'jellio-player-sync-wait-dot'));
  const syncWaitText = el('span', null, '');
  syncWaitBanner.appendChild(syncWaitText);

  // Ported from the same real Nuvio pause screen screenshot this whole
  // player pass works from: an eyebrow naming what is playing, the
  // series (or movie) own name and rating, the exact episode this
  // pause landed on and its own overview, not the item passed in alone
  // (an Episode's own Overview is the episode's, its own Name never
  // was the series name, real fields already distinguished the same
  // way screens/detail.js's own episode header just started doing).
  const pauseOverlay = el('div', 'jellio-player-pause-overlay');
  const pauseBackdropUrl = seriesAwareArtworkUrl(1600);
  if (pauseBackdropUrl) {
    pauseOverlay.style.backgroundImage = 'url(' + pauseBackdropUrl + ')';
  }
  const pauseContent = el('div', 'jellio-player-pause-content');
  pauseContent.appendChild(el('div', 'jellio-player-pause-eyebrow', 'You’re watching'));
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

  // A real card now, the same glass-panel treatment buildUpNextOverlay
  // above already uses, not the tiny corner pill this used to be - real
  // feedback was that a small badge easy to miss entirely undersold a
  // real, actionable prompt the reader should actually notice.
  function buildSkipOverlay(onSkip, onDismiss) {
    const overlay = el('div', 'jellio-player-skip jellio-player-skip-hidden');

    const body = el('div', 'jellio-player-skip-body');
    const eyebrow = el('div', 'jellio-player-skip-eyebrow', '');
    body.appendChild(eyebrow);
    const title = el('div', 'jellio-player-skip-title', '');
    body.appendChild(title);

    const actions = el('div', 'jellio-player-skip-actions');
    const skipActionButton = el('button', 'jellio-player-skip-play', 'Skip');
    skipActionButton.type = 'button';
    skipActionButton.addEventListener('click', onSkip);
    const dismissButton = el('button', 'jellio-player-skip-dismiss', 'Dismiss');
    dismissButton.type = 'button';
    dismissButton.setAttribute('aria-label', 'Dismiss skip prompt');
    dismissButton.addEventListener('click', onDismiss);
    actions.appendChild(skipActionButton);
    actions.appendChild(dismissButton);
    body.appendChild(actions);
    overlay.appendChild(body);

    return { overlay: overlay, eyebrowEl: eyebrow, titleEl: title };
  }

  let skipSegments = null;
  let skipTargetSeconds = 0;

  // Real feedback, live, after Intro Skipper's own logs were checked
  // directly: a .strm-backed remote title (this whole library, Gelato's
  // own architecture) never gets a real chromaprint analysis at all, or
  // Intro Skipper logs "did not modify any segments" and moves on -
  // fingerprinting needs the real audio itself, something a scheduled
  // task pointed at a debrid link cannot reliably pull and decode the
  // way it can a local file. No fix for that sits on this runtime's own
  // side of that gap, only a second, independent real signal that does
  // not depend on Intro Skipper's own analysis succeeding at all: a
  // chapter track embedded in the stream itself (common on WEB-DL
  // sources, Jellyfin's own scanner already reads it off the same
  // remote stream it already reads RunTimeTicks/codecs from, no
  // separate real fingerprinting pass needed), named the same way
  // Intro Skipper's own chapter analysis mode already looks for. Tried
  // only once Intro Skipper's own real data (native store or its legacy
  // endpoint) comes back with nothing, never overrides a real detection
  // that already exists.
  function chapterFallbackSegments(chapters, runTimeTicks) {
    if (!chapters || !chapters.length) {
      // Same real visibility reasoning as getNativeMediaSegments's own
      // console.warn: no chapters at all is the expected, silent common
      // case for most real remote titles, but worth being able to see
      // when it is not - real feedback live was a native client's own
      // Skip Intro showing for an item this file's own two Intro
      // Skipper lookups both genuinely came back empty for, and native
      // clients commonly read that straight off embedded chapters
      // rather than any Intro Skipper segment at all.
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
    const credits = findSegment(/credit|outro/i);
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

  // Ported from NuvioWeb's own shouldShowNextEpisodeCard()
  // (js/ui/screens/player/playerNextEpisodeRules.js), not re-derived:
  // a real Credits segment (already fetched for the skip button above)
  // is what actually starts the outro, and showing the card there
  // reads as timed to the episode rather than to an arbitrary count
  // of seconds left. The fixed-seconds rule this used to run
  // unconditionally is now only the fallback for an episode Intro
  // Skipper has no segment data for at all.
  function shouldShowUpNextNow(currentTime, duration) {
    if (!duration) return false;
    const credits = skipSegments && skipSegments.Credits;
    if (credits && credits.End > 0 && credits.Start >= 0) {
      return currentTime >= credits.Start;
    }
    // Dynamic logic: on media where we do not have a timestamp for credits,
    // do not show the premature floating Up Next overlay during playback.
    // The post-play end-screen modal will appear when the episode finishes.
    return false;
  }

  // Which segment kind ('Introduction' or 'Credits') the reader has
  // already dismissed, so Dismiss hides the card for that segment's own
  // real remaining window instead of it popping straight back up on the
  // very next timeupdate tick - cleared the moment activeSkipSegment's
  // own kind changes, the same one real dismissal Up Next's own
  // dismissUpNext() gives for the rest of the whole episode, just
  // scoped to one segment here since Introduction and Credits are two
  // separate real prompts, not one.
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

  // Real bug, found live against Re:Zero: every one of this chain's own
  // real tiers used to be "first one that returns anything wins
  // outright," even when that first tier only actually had ONE of
  // Introduction/Credits for real - getCommunitySkipSegments,
  // getIntroSkipperSegments (through getNativeMediaSegments) and
  // chapterFallbackSegments all default whichever category they did not
  // find to a degenerate {Start:0, End:0} placeholder, truthy enough to
  // satisfy the old "did this tier find anything at all" check and
  // permanently block every lower tier from ever being asked to fill in
  // just the one real category still missing. A community hit with a
  // real Credits segment but no real Introduction locked in immediately
  // - Skip Intro never showing again for that episode no matter what
  // native Intro Skipper, chapters or this plugin's own analyzer had -
  // and Up Next fired off whatever Credits.Start that same tier
  // happened to have, even where a lower tier's own real match would
  // have been more accurate, with nothing here ever giving it the
  // chance to try.
  //
  // Merges per category instead, the exact same real priority order
  // "first real result for THIS category wins" shape Services/
  // CommunitySkip/CommunitySkipProvider.cs's own MergeByPriority already
  // uses server side for its own four tiers: a lower tier only ever
  // fills in whichever one real category is still missing, never
  // discards a real, valid category a higher tier already had just
  // because that same response also lacked the other one.
  function mergeSkipSegments(current, candidate) {
    if (!candidate) return current;
    return {
      Introduction: isValidSegment(current && current.Introduction) ? current.Introduction : candidate.Introduction,
      Credits: isValidSegment(current && current.Credits) ? current.Credits : candidate.Credits,
    };
  }

  function segmentsComplete(segments) {
    return !!(segments && isValidSegment(segments.Introduction) && isValidSegment(segments.Credits));
  }

  // Real feedback, explicit: a real community timestamp database
  // (Controllers/IntroCreditsController.cs's own GET .../community/{id},
  // the same real approach NuvioTV itself ships) is tried first now,
  // ahead of every real tier this file already had - no stream or
  // ffmpeg access needed at all, so it answers the same real instant a
  // title is opened for the very first time. Everything below it stays
  // exactly as it already was, a real last resort chain for whatever
  // the community tier itself does not cover (anime only for now, and
  // only once a server admin has actually configured a real Simkl
  // client id) - now only ever reached for whichever one real category
  // the community tier above did not already answer, not discarded
  // outright the moment community answers anything at all.
  getCommunitySkipSegments(itemId).then(function (community) {
    skipSegments = mergeSkipSegments(skipSegments, community);
    if (segmentsComplete(skipSegments)) return;

    getIntroSkipperSegments(itemId).then(function (result) {
      skipSegments = mergeSkipSegments(skipSegments, result);
      if (segmentsComplete(skipSegments)) return;

      const fromChapters = chapterFallbackSegments(item.Chapters, item.RunTimeTicks);
      skipSegments = mergeSkipSegments(skipSegments, fromChapters);
      if (segmentsComplete(skipSegments)) return;

      // Real last resort: Jellio's own real cross-episode analyzer,
      // only ever has something to say once an admin has explicitly run
      // components/cardOptionsMenu.js's own "Find Skip Intro/Credits"
      // scan against this season/show - no longer fired automatically on
      // every playback (real feedback: too expensive a real cost against
      // a reader's own debrid quota for something the community tier
      // above already covers most of the time).
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
        // video.currentTime = 0 alone used to just resume anyway,
        // reported live as clicking Start Over doing nothing: streamUrl
        // above was already built with this same real saved position
        // baked into it (buildStreamUrl's own StartTimeTicks), and for
        // anything routed through this runtime's own real forced
        // transcode fallback (runtime/api.js's own canBrowserDirectPlay,
        // routine on a scraped Gelato release), the server only ever
        // transcodes forward from that exact point on, nothing earlier
        // ever exists in that stream at all. Seeking to 0 on a stream
        // like that lands back on its own first available frame, the
        // saved position all over again, not the reader's own real
        // start of the title. Rebuilding the URL with a real 0 instead
        // asks the server for a real stream that actually starts there.
        // Same real renegotiation seekToAbsoluteSeconds needs and for
        // the same reason: reusing the title's own existing
        // PlaySessionId on a bare StartTimeTicks change never reliably
        // starts a fresh real ffmpeg job.
        hasReportedStart = false;
        getPlaybackInfo(itemId, 0, mediaSource.Id, currentAudioStreamIndex)
          .then(function (info) {
            const negotiated = info && info.MediaSources && info.MediaSources[0];
            if (!negotiated) {
              showPlayerToast('Could not start over, that stream is no longer available.');
              return;
            }
            mediaSource = negotiated;
            playSessionId = info.PlaySessionId;
            streamOffsetTicks = 0;
            needsStartOffset = false;
            // Target is a real 0 either way here, direct play, the
            // plain mp4 fallback and a native HLS engine alike, so
            // there is nothing for the loadedmetadata listener to seek
            // to on top of that.
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
    // Joining a group already paused starts this reader paused at its
    // real shared position too, rather than autoplaying locally out
    // from under whatever the group actually agreed on: the Unpause
    // command that resumes it for real (applySyncCommand below) is
    // still coming, whenever the group actually sends one.
    //
    // Real bug, found live: !syncPlaylistItemId alone used to be enough
    // to reach this branch, true both for genuinely ungrouped playback
    // (correct: autoplay locally, nothing else is coordinating this)
    // and for a reader in a group who is about to become the group's
    // own initiator (about to publish a fresh queue further down,
    // syncPlaylistItemId not set yet only because that hasn't happened
    // yet) - very much NOT correct for the second case, which used to
    // autoplay locally right here, a plain video.play() that never
    // tells the server anything. The group's own real state stayed
    // Idle/Stop forever (whatever the fresh queue's own initial state
    // was), because nothing anywhere ever actually sent a real Unpause
    // request. Every other member correctly waiting on that broadcast
    // (this same branch's own comment above, for their own join) then
    // waited forever for a command that was never coming - confirmed
    // live: initiator's own player started fine, joined readers sat on
    // the loading spinner indefinitely. getCurrentGroup() added to the
    // condition here so this branch is only ever local-only autoplay
    // for genuinely ungrouped playback; the fresh-initiator case now
    // requests a real Unpause instead, see publishSyncQueue's own
    // callback further down.
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

  // Real bug, found live: this used to navigate straight to the next
  // episode's own #/play route with no mediaSourceId at all, so the
  // fresh PlaybackInfo negotiation there just took Gelato's own
  // MediaSources[0] - whichever release happened to resolve first,
  // never checked against the language actually playing. A multi
  // source Gelato title often keeps separate dubs as entirely separate
  // sources, not just separate audio tracks within one, so that could
  // hand back a completely different language mid-binge. This now
  // reads the currently playing source's own active audio track,
  // fetches the next episode's own real sources (the exact same
  // getMediaSources() call components/streamPicker.js's own picker
  // already uses), and looks for one whose own sourceAudioLanguages()
  // already includes that same code - the exact same real language
  // detection (embedded MediaStreams first, the release name's own
  // language flags next) that picker's own filter row already trusts.
  // Falls through to the old default-negotiation behaviour untouched
  // whenever there is no active language to match, or none of the next
  // episode's own sources carry it.
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
        upNextPlayButton.textContent = 'Play now (' + upNextCountdownRemaining + ')';
      } else {
        upNextPlayButton.textContent = 'Play now';
      }
    }
  }

  function showUpNext() {
    if (upNextShown || upNextDismissed || !upNextOverlay) return;
    upNextShown = true;
    preloadNextEpisodeStream();
    // Real bug, found live: playNextEpisode() just navigates straight
    // to the next episode's own #/play route, and the countdown below
    // can fire that same navigation on its own, so 'ended' above never
    // gets a chance to fire for a reader who moves on the moment Up
    // Next appears (routine, that's the whole point of Up Next).
    // shouldShowUpNextNow() only ever reaches here off skipSegments'
    // own real Credits.Start (when Intro Skipper has it) or its
    // fallback off durationSeconds, either way a real strong enough
    // signal this episode was actually watched through on its own,
    // same real credit this needs regardless of what the reader does
    // next.
    markRealWatchComplete();
    // A slight underestimate when skipSegments' own real Credits.Start
    // is what triggered this (misses the credits themselves), still
    // far closer to this title's own real length than the library's
    // own inflated metadata guess. reportRealDurationIfUseful's own
    // monotonic floor means this can only ever raise what's already
    // been reported, never lower a better figure reconcileDuration
    // already sent. currentPositionTicks() rather than a
    // timeupdate-scoped positionSeconds: this function has no closure
    // over that, only ever called from inside that same handler.
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
        // Real Nuvio-competitive gap, not a hypothetical one: the up
        // next card itself doesn't show until shouldShowUpNextNow()
        // near the very end of this episode, but the real id it needs
        // is already known right here, at the very start of it. Firing
        // Gelato's own gelato/prefetch/{itemId} (runtime/api.js's own
        // header documents the real bottleneck it warms) this early
        // hands it this whole episode's own runtime as lead time - far
        // more than a poster's own hover/focus debounce ever gets - so
        // a real binge watcher never sees a loading gap between
        // episodes at all, matching AIOStreams' own precacheNextEpisode
        // setting (aiostreams-config.json's own starter config already
        // enables it) doing the equivalent one layer further upstream.
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
  // Real completion for the Watch Together badges, same 90% real
  // threshold AchievementService.cs's own IsRealWatch() uses server
  // side for the solo path, only reachable here at all: no server side
  // event exists that can tell whether this reader's own session was
  // actually grouped when it stopped, getCurrentGroup()'s own real
  // SyncPlay WebSocket state is the only place that is ever known.
  // Deliberately not reset on a mid-session source switch the way
  // hasReportedStart is above (switchAudioTrack, seekToAbsoluteSeconds,
  // switchSource, selectBurnedInSubtitle each do): this only ever needs
  // to fire once for the life of this real screen mount, a switch mid
  // playback is still the same one real watch, not a second one.
  let hasCreditedGroupWatch = false;
  // Same real reasoning as hasCreditedGroupWatch just above, same real
  // reason it stays unreset there: playNextEpisode() below navigates to
  // a whole new #/play route rather than swapping itemId in place, so a
  // real next episode always gets its own fresh renderPlayer() call and
  // its own fresh copy of this flag regardless.
  let hasCreditedRealWatch = false;
  // components/card.js's own Continue Watching row reads
  // item.RunTimeTicks straight off Jellyfin's own native response, the
  // exact same inflated metadata AchievementService.cs's own header
  // already covers ("Below Deck Mediterranean", reported live) - and,
  // reported live again, still 22m left at a real 37 of 41 real
  // minutes once this whole real-watch fix already shipped: crediting
  // the achievement never taught anything real about the title's own
  // real duration to the one row that actually displays it.
  // reportRealDurationIfUseful() below is that: same three real
  // trustworthy signals hasCreditedRealWatch's own three call sites
  // already use (reconcileDuration's own real video.duration,
  // 'ended', Up Next), fed to RealDurationStore.cs instead so
  // getResumeItems's own next real fetch already knows better.
  // Monotonically increasing on purpose, not just deduped: Up Next's
  // own real positionSeconds (skipSegments' own Credits.Start) is only
  // ever a lower bound on this title's own real length (it always
  // lands before the real end), so a later, smaller candidate is
  // never actually better information and must not overwrite an
  // already-reported larger one. reconcileDuration's own real
  // video.duration and 'ended' are both the true real total whenever
  // they do fire, always >= any lower bound reported before them, so
  // this same rule lets either of those through regardless of order.
  let lastReportedDurationSeconds = 0;
  function reportRealDurationIfUseful(candidateSeconds, exact) {
    if (!candidateSeconds || !isFinite(candidateSeconds) || candidateSeconds <= 0) return;
    if (candidateSeconds < lastReportedDurationSeconds + 5) return;
    lastReportedDurationSeconds = candidateSeconds;
    reportRealDuration(itemId, candidateSeconds * TICKS_PER_SECOND, exact).catch(function () {
      // Not fatal, Continue Watching just keeps showing the library's
      // own metadata runtime for this title until a later real sitting
      // reports a good value.
    });
  }

  // Real gap, found by working through the consequences of the fix
  // above: crediting AchievementService and reporting a real duration
  // both stay entirely inside this plugin's own data, never touching
  // native Jellyfin's own Played flag at all. UserDataManager.
  // UpdatePlayState (real Jellyfin source, confirmed) reads that same
  // real request's own reportedPositionTicks against item.RunTimeTicks
  // (still the library's own inflated metadata, nothing above changes
  // that server side), so a genuine full real watch never crosses its
  // own 90% MaxResumePct there either: stays in native Continue
  // Watching, native Up Next never advances, no native watched
  // checkmark. setPlayed() below is the same real POST/PlayedItems
  // call the stock "mark watched" toggle already makes
  // (PlaystateController.cs's own MarkPlayedItem, confirmed: calls
  // UpdatePlayedStatus(user, item, true, ...) directly, bypassing the
  // runtime ratio calculation entirely), fired from the exact same
  // three real trustworthy signals as the achievement credit above.
  function markRealWatchComplete() {
    if (hasCreditedRealWatch) return;
    hasCreditedRealWatch = true;
    creditRealWatch(itemId).catch(function () {
      // Not fatal, AchievementService's own metadata based gate is
      // still there as a real fallback for this exact sitting.
    });
    setPlayed(itemId, true).catch(function () {
      // Not fatal, native Jellyfin's own metadata based gate is still
      // there as a real fallback for this exact sitting, same as
      // AchievementService's own above.
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
  // Set once cleanup() has actually run: removeAttribute('src') plus
  // load() below, on an element still holding the error listener, can
  // itself queue a second real error event on some browsers, arriving
  // after Back has already navigated this same root on to a different
  // screen. Without this, that late event still called
  // renderPlaybackError(root, ...) below and clobbered whatever had
  // since rendered into root, reported live as Back doing nothing (it
  // did navigate, this stale event just wrote right back over it).
  let screenTornDown = false;

  function currentPositionTicks() {
    return streamOffsetTicks + Math.round((video.currentTime || 0) * TICKS_PER_SECOND);
  }

  // A converted stream can't report its length, so the server reads it
  // from the source once (Jellio/real-duration/probe) and the player
  // takes that instead.
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
  requestProbedDuration();

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

  // A <video> element that fails to actually decode its own real src,
  // the browser's own generic broken-video placeholder painted over
  // whatever this screen had built around it, controls and all, with
  // nothing from this runtime itself saying why, reported live and
  // matching exactly what buildStreamUrl() above was doing wrong: a
  // Static direct play URL forced on a source getPlaybackInfo's own
  // real negotiation never actually said the browser could decode as
  // is. That real cause is fixed above, but a browser's own decode
  // failure is never fully preventable from here (a dead debrid link,
  // a codec still outside what this browser supports even
  // transcoded), so this stays regardless: before this screen ever
  // got a first real frame, the whole thing was dead already, same
  // treatment the three negotiation failures above already get: a
  // real message and a way back out rather than the browser's own
  // silent placeholder. After a first real frame did play, whatever
  // broke it after the fact gets the same toast switchSource()'s own
  // failures already use, the rest of this screen still being worth
  // keeping in front of the reader at that point.
  video.addEventListener('error', function () {
    if (screenTornDown) return;
    // Real gap found live: this handler discarded the browser's own
    // MediaError entirely, so the one real diagnostic signal a failed
    // <video> actually hands back (a real code - 1 ABORTED, 2 NETWORK,
    // 3 DECODE, 4 SRC_NOT_SUPPORTED - plus, on Chromium, a real message
    // string) never reached anywhere a reader debugging a real failure
    // live could see it, this screen's own generic message the only
    // thing anyone ever got. Console only, not the visible toast/error
    // screen: this is for a real reader with devtools open chasing a
    // real failure, not something every reader hitting a dead link
    // needs to see.
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
    cleanup();
    renderPlaybackError(
      root,
      itemId,
      'This stream could not be played. Try a different one from Change Stream.',
    );
  });

  video.addEventListener('loadedmetadata', function () {
    // pendingNativeSeekSeconds covers both real cases that need this:
    // a direct play resume, and a native HLS stream landing anywhere
    // but position 0 (switchAudioTrack, seekToAbsoluteSeconds's own
    // HLS branch, switchSource, selectBurnedInSubtitle each set it
    // fresh before their own video.load()). The plain forced mp4
    // transcode fallback already starts encoding at the right real
    // position server side (see streamOffsetTicks above), so seeking
    // again here would double that offset, this stays null for it.
    if (pendingNativeSeekSeconds != null) {
      video.currentTime = pendingNativeSeekSeconds;
      pendingNativeSeekSeconds = null;
    }
    reconcileDuration();
    paintDuration();
  });

  // Native HLS in particular: loadedmetadata above can fire before the
  // playlist is fully parsed, video.duration still NaN/Infinity at
  // that point, durationchange is the real event for whenever it
  // later actually settles.
  video.addEventListener('durationchange', reconcileDuration);

  // Real bug, found live: some of Gelato's own real remote sources
  // never send a Content-Length/proper duration hint at all (chunked
  // debrid delivery), so video.duration stays Infinity for the whole
  // real sitting and reconcileDuration() above never actually settles
  // durationSeconds off the library's own inflated metadata guess —
  // the exact same real report (37 of a real 41 minute episode, still
  // showing 22m left, nothing credited) that started this. 'ended' is
  // the one real signal that needs no known duration at all: the
  // browser only ever fires it once this real stream has genuinely
  // run out of data to play, so it credits a real full watch even when
  // durationSeconds above is still stuck wrong.
  //
  // Real bug, found live: an unreleased title with a stray indexed
  // source (real case, "Shrek 7" reported live) resolved to a stream
  // that never actually decoded a single real frame, yet still
  // credited a full real watch and marked it played both here and on
  // Jellyfin itself. Some browsers fire 'ended' for exactly this kind
  // of broken/empty stream without ever firing so much as one real
  // 'timeupdate' first, and this listener trusted 'ended' alone with
  // no check that this reader had watched any real content at all.
  // hasReportedStart only ever flips true from inside that same
  // 'timeupdate' handler below, real proof the browser actually
  // decoded and advanced through at least one real frame - gating on
  // it here closes this exact gap without weakening the real fix
  // above (a stream that is genuinely playing through to a real
  // 'ended' has already fired plenty of those by then).
  video.addEventListener('ended', function () {
    if (!hasReportedStart) return;
    // The real duration itself, not just the credit: whatever
    // positionSeconds actually reached by the time 'ended' fires IS
    // this real stream's own real length, the strongest of the three
    // signals reportRealDurationIfUseful() takes since it needs no
    // video.duration at all.
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
      reportPlaybackStart(itemId, mediaSource.Id, currentPositionTicks());
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
        // Not fatal, just one missed real credit towards the Watch
        // Together badges.
      });
    }

    // REAL_WATCH_COMPLETION_THRESHOLD's own header explains why this
    // rides the real client-observed durationSeconds instead of
    // trusting AchievementService's own item.RunTimeTicks based gate to
    // catch this on its own: real feedback (Below Deck Mediterranean),
    // a genuine full watch never reaching that gate's own 90% at all.
    if (!hasCreditedRealWatch && durationSeconds && positionSeconds / durationSeconds >= REAL_WATCH_COMPLETION_THRESHOLD) {
      markRealWatchComplete();
    }

    if (nextEpisode && !hasInitiatedNextPreload && durationSeconds > 60 && positionSeconds >= durationSeconds - 55) {
      preloadNextEpisodeStream();
    }

    // !upNextShown alongside !upNextDismissed below (shouldShowUpNextNow
    // stays true for as long as both keep failing, called again on
    // every one of these timeupdate ticks): the episode sleep timer's
    // own decrement needs to run exactly once per real episode
    // boundary, not once per tick, the same real one-shot guarantee
    // showUpNext()'s own early return already gives its plain callers.
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

    // !upNextShown: both cards anchor to the same bottom-right corner,
    // and a real Credits segment is what drives both of them (Skip
    // Credits above, Up Next via shouldShowUpNextNow's own Credits.Start
    // check) - once the Up Next card has actually taken that spot, Skip
    // Credits would otherwise sit directly behind it for the rest of
    // the episode with no way for a reader to ever see or reach it.
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    playPauseIcon.className = 'material-icons pause';
    playPauseButton.setAttribute('aria-label', 'Pause');
    pauseOverlay.classList.remove('jellio-player-pause-overlay-visible');
  });
  video.addEventListener('pause', function () {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    playPauseIcon.className = 'material-icons play_arrow';
    playPauseButton.setAttribute('aria-label', 'Play');
    // Ending playback also fires pause, the overlay would just be in the
    // way of whatever screen comes next rather than useful here.
    if (hasReportedStart && !video.ended) {
      pauseOverlay.classList.add('jellio-player-pause-overlay-visible');
    }
  });

  const progressInterval = window.setInterval(function () {
    if (!hasReportedStart) return;
    lastReportedTicks = currentPositionTicks();
    reportPlaybackProgress(itemId, mediaSource.Id, lastReportedTicks, video.paused);
  }, PROGRESS_REPORT_MS);

  // Real Jellyfin SyncPlay command handling: applies a pushed
  // Unpause/Pause/Seek/Stop at the exact real moment the server
  // scheduled it for (command.When, converted to this device's own
  // local clock through remoteToLocal()'s own real NTP style offset),
  // the same real interoperable protocol a native client in the same
  // group already runs, confirmed against real PlaybackCore.js before
  // this was written. SkipToSync only, not native's own SpeedToSync
  // playbackRate ramp (runtime/syncPlay.js's own header explains why):
  // a correction here always means a real seekToAbsoluteSeconds() reload
  // (renegotiated PlaybackInfo, a fresh video.load()), a real cost
  // native's own in-place currentTime assignment never pays, so this
  // only actually reloads once the drift is large enough to be worth
  // that cost, small drift left alone rather than reloading on every
  // single real command the way applying all of them literally would.
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

  function applySyncCommand(command) {
    if (command.PlaylistItemId !== syncPlaylistItemId) return;
    clearScheduledSync();

    function run() {
      switch (command.Command) {
        case 'Unpause':
          if (syncDriftSeconds(command) > SYNC_DRIFT_THRESHOLD_SECONDS) {
            const targetSeconds = estimateCurrentTicks(command.PositionTicks || 0, command.When) / TICKS_PER_SECOND;
            seekToAbsoluteSeconds(Math.max(0, targetSeconds)).then(function () {
              waitForPlayableBuffer(attemptPlay);
            });
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
          seekToAbsoluteSeconds(Math.max(0, (command.PositionTicks || 0) / TICKS_PER_SECOND));
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

  // Real bug, found live: this whole block used to only run if
  // getCurrentGroup() was already truthy the instant this screen
  // mounted, which missed the common real case of landing here (the
  // stream picker, a chat watch card) faster than
  // reconcileGroupMembership()'s own async join/REST snapshot fallback
  // ever had a chance to resolve first, confirmed still mid-flight at
  // this exact point live: app.js's own runSync() calls startSyncPlay()
  // synchronously right before mounting this screen, never awaiting its
  // own fire-and-forget first reconcile pass. A group that only became
  // known a moment later left this screen never having subscribed to
  // anything at all, real feedback matching exactly: no toast, no chat
  // message, even though the account genuinely was in the group the
  // whole time. Subscribing unconditionally instead: applySyncCommand
  // and the 'waiting'/'canplay' listeners below already all check
  // syncPlaylistItemId themselves before doing anything real, so there
  // is nothing unsafe about wiring them before a group is confirmed.
  unsubscribeSyncCommand = onSyncCommand(applySyncCommand);

  // In a real group: publishing this item is the same real call a
  // native client's own SyncPlay button already makes the moment it
  // starts something while in a group, the exact real bug this whole
  // feature started from ("I joined a group and nothing happened,
  // group just shows idle"). Deliberately not gated on syncPlaylistItemId
  // any more (whether this exact title happens to already be the
  // group's own current queue item): real feedback asked for every
  // real explicit start to publish fresh and notify the group, the
  // same title started twice in a row included, not just the first
  // time it is new. isGroupJoinNavigation above is what actually tells
  // a reader following an already-started group's own link apart from
  // one genuinely choosing to start something, the real distinction
  // that check used to lean on syncPlaylistItemId for instead. Guarded
  // by its own flag rather than a plain condition: this can now run
  // once from the immediate check below and again from
  // onSyncGroupChange the moment a late-resolving group is learned
  // about, and a real SetNewQueue should only ever go out once per
  // mount either way.
  function maybePublishQueue() {
    if (syncQueuePublishAttempted || !getCurrentGroup() || isGroupJoinNavigation) return;
    syncQueuePublishAttempted = true;
    publishSyncQueue(itemId, startTicks)
      .then(function () {
        console.debug('Jellio: published Group Watch queue for', itemId);
        // Same real moment components/groupWatchInvites.js's own toast
        // fires for everyone else in the group, real feedback asked for
        // this to also land in the group's own real chat, not just a
        // toast a reader could easily miss or already have dismissed by
        // the time they check chat: a permanent, clickable record of it
        // right there, same real name shown either place.
        const syncGroup = getCurrentGroup();
        if (syncGroup) {
          const watchingName = isEpisodeItem ? item.SeriesName : item.Name;
          sendGroupWatchMessage(syncGroup.GroupId, 'The group started watching ' + (watchingName || 'something'), itemId).catch(function () {});
        }
        // This reader just became the group's own initiator (line 2234's
        // own branch skips local autoplay for exactly this case, see its
        // own comment), so nothing has actually asked the server to
        // start playback for real yet. requestSyncUnpause() is the same
        // real request a native client's own Play button sends; the
        // broadcast it triggers comes back through this screen's own
        // onSyncCommand handler (applySyncCommand, further down) exactly
        // like it does for every other member, this reader included, so
        // there is only ever one real code path that actually starts a
        // synced video anywhere in this file.
        waitForPlayableBuffer(function () {
          requestSyncUnpause().catch(function (err) {
            console.warn('Jellio: could not send initial Group Watch unpause', err);
          });
        });
        // Real feedback, found live: SetNewQueue can return a real 204
        // here and still never actually queue anything, real
        // WaitingGroupState.cs's own real SetPlayQueue() failing a
        // real per-user library visibility check on some other group
        // member (AllUsersHaveAccessToQueue(), confirmed against real
        // source) silently returns to the previous state instead,
        // one real server side log line neither this account nor
        // anyone else in the group ever sees. No real command or
        // queue update ever arrives either way, so this is the one
        // real signal available: still nothing on the real queue a
        // few real seconds after a request that itself reported
        // success means it quietly failed.
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

  // Covers both real gaps together now: syncPlaylistItemId missed at
  // mount time (a group joined, or already sitting idle, before this
  // exact title was ever put on its own real queue), and the group
  // itself only resolving after mount (the race explained above).
  unsubscribeSyncGroupChange = onSyncGroupChange(function () {
    const target = getCurrentPlaylistTarget();
    syncPlaylistItemId = target && target.itemId === itemId ? target.playlistItemId : null;
    // The gate below on 'waiting'/'canplay' just opened, real feedback
    // found live: this video's own 'canplay' very often already fired,
    // gate still closed, before this exact real round trip (SetNewQueue,
    // then this PlayQueue broadcast coming back) ever completes, and
    // 'canplay' does not fire again on its own once a video is already
    // playing through cleanly. Left as only the two listeners below,
    // the sender's own real Ready signal could go unsent forever, the
    // server's own WaitingGroupState.cs waiting on it right alongside
    // everyone else's, confirmed live: a group stuck in Waiting no
    // matter how many real Play requests follow. Checking the video's
    // own real current state the moment this gate opens covers exactly
    // that missed-event case without waiting on one that may not come.
    if (syncPlaylistItemId && video.readyState >= 3) {
      notifyReady(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
    } else if (syncPlaylistItemId && !joinSyncActive && target && target.isPlaying) {
      // Mirror case, same real gap this whole handler's own header above
      // already covers for notifyReady: isInitialGroupCatchUp near the
      // top of this file only ever runs once, at mount, and had no real
      // group yet to see. Same two real calls, fired here instead once
      // this reader's own membership actually resolves.
      joinSyncActive = true;
      joinSyncGroupId = getCurrentGroup().GroupId;
      notifyBuffering(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
      startJoinSync(joinSyncGroupId, syncPlaylistItemId).catch(function () {});
    }
    maybePublishQueue();
  });

  maybePublishQueue();

  // Real SyncPlay's own group wide buffering signal: every member
  // reports Buffering the moment its own player actually stalls and
  // Ready once it can play again, the server holding a group's own
  // Unpause back until every member has reported Ready, same real
  // mechanism a slow connection already gets from a native client.
  // Wired unconditionally, same real reason as the command listener
  // above: both already check syncPlaylistItemId themselves first.
  video.addEventListener('waiting', function () {
    if (!syncPlaylistItemId) return;
    notifyBuffering(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
  });
  video.addEventListener('canplay', function () {
    if (!syncPlaylistItemId) return;
    notifyReady(currentPositionTicks(), !video.paused, syncPlaylistItemId).catch(function () {});
    // Only ever true for this file's own one real isInitialGroupCatchUp
    // mount time check above, cleared right after so a later real
    // 'canplay' (a source switch, a seek reload) never fires this a
    // second time for the same real join.
    if (joinSyncActive) {
      joinSyncActive = false;
      clearJoinSync(joinSyncGroupId).catch(function () {});
    }
  });

  // "Waiting for X to finish loading in": the reason side of
  // isInitialGroupCatchUp above, GroupWatchJoinSyncController's own
  // header explains why this is a small poll of its own rather than
  // riding the chat panel's own pollChat, which only ever runs while
  // that panel is actually open. Wired unconditionally like the two
  // listeners just above: getCurrentGroup() and syncPlaylistItemId are
  // both checked inside pollSyncWait itself first.
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

  // A real function declaration, hoisted, rather than the plain arrow
  // this used to just return directly: the video's own error listener
  // above now calls this same real teardown itself on a dead first
  // load rather than duplicating what it already does, and needs to
  // reach it from earlier in this same function body.
  async function cleanup() {
    if (unsubscribeCast) unsubscribeCast();
    if (getActiveCast()) disconnectCast().catch(function () {});
    document.removeEventListener('visibilitychange', onTabVisibility);
    window.clearTimeout(frozenCheck);
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(function () {});
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
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'stop', 'nexttrack'].forEach(function (act) {
          navigator.mediaSession.setActionHandler(act, null);
        });
        navigator.mediaSession.playbackState = 'none';
      } catch (e) {}
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      } catch (e) {}
    }
    // Real feedback: this reader closing out of a synced session used
    // to leave the rest of the group's own playback running with
    // nobody actually reporting position for this exact
    // PlaylistItemId any more, real client behavior confirmed live as
    // "doesn't pause for the other person". requestSyncPause() is the
    // same real request the manual pause control already sends
    // (further up this same file); the broadcast it triggers reaches
    // every other real member through their own onSyncCommand handler
    // exactly like any other real pause does, no special case needed
    // on their own end for this to work. Fired before
    // unsubscribeSyncCommand below tears down this reader's own real
    // listener, though this reader leaving is exactly why its own
    // local reaction to that broadcast no longer matters.
    if (syncPlaylistItemId) {
      requestSyncPause().catch(function () {});
    }
    // Real feedback would otherwise leave the rest of the group's own
    // pollSyncWait reading this reader as still loading in forever, this
    // exact tab closed or navigated away before its own real 'canplay'
    // ever got the chance further up this file: GroupWatchJoinSyncService's
    // own MaxAgeSeconds is only the last resort fallback for this, not
    // meant to be the common real path.
    if (joinSyncActive) {
      joinSyncActive = false;
      clearJoinSync(joinSyncGroupId).catch(function () {});
    }
    window.clearInterval(syncWaitPollTimer);
    clearScheduledSync();
    if (unsubscribeSyncCommand) unsubscribeSyncCommand();
    if (unsubscribeSyncGroupChange) unsubscribeSyncGroupChange();
    stopChatOnCleanup();
    video.textTracks.removeEventListener('change', enforceSubtitleTrackModes);
    if (subtitleStyleTag) {
      subtitleStyleTag.remove();
      subtitleStyleTag = null;
    }
    window.clearInterval(progressInterval);
    if (upNextCountdownInterval) window.clearInterval(upNextCountdownInterval);
    if (endScreenModalInstance) {
      endScreenModalInstance.cleanup();
      endScreenModalInstance = null;
    }
    // Real bug, audit-found: hideControls() below reschedules itself
    // via idleTimer for as long as it finds itself "blocked" (video.paused
    // among other things), and video.paused reads permanently true from
    // here on, this same function's own video.pause() call three lines
    // down never undone. Without this, a torn down player's own idleTimer
    // rescheduled itself forever, once every IDLE_HIDE_MS, holding this
    // whole closure (video, shell, popovers, sourcePanel, episodesPanel)
    // alive for nothing: real feedback traced this to a real binge
    // session, one real screen re-mounted (and one real leaked idleTimer
    // chain left behind) per episode, Up Next's own auto advance and the
    // episode list both re-navigating through this exact same real
    // teardown/mount cycle.
    if (idleTimer) window.clearTimeout(idleTimer);
    if (hasReportedStart) {
      // Real bug, found live: reporting the real current position here
      // unconditionally used to undo markRealWatchComplete() above the
      // moment this screen actually tore down. Native Jellyfin's own
      // UserDataManager.UpdatePlayState (confirmed real source) runs
      // again on every real stop report, still dividing by the
      // library's own inflated RunTimeTicks - a real position at 68%
      // of that inflated figure lands in its own "still resumable"
      // middle branch, which unconditionally does
      // data.PlaybackPositionTicks = positionTicks (resurrecting a
      // real nonzero resume position) while never touching Played
      // (stays true, setPlayed() above already set it). Reported live
      // exactly as that: watched correctly marked, but still sitting
      // in Continue Watching with no time left, RunTimeTicks already
      // patched down near equal to that resurrected position.
      // Reporting 0 once this screen already knows better keeps
      // native Jellyfin's own math in its own "ignore progress during
      // the beginning" branch instead, which only ever touches
      // positionTicks, not Played.
      // Real bug, found live: this used to fire-and-forget, so the very
      // next screen (almost always Home, invalidateHomeSections() right
      // below already anticipating that) could have its own Up
      // Next/Continue Watching fetch reach the server before this
      // report did - a real race, not a real ordering guarantee, that
      // read as "sometimes Up Next/Continue Watching don't update until
      // a real page refresh" live: a refresh's own fresh fetch only
      // ever looked correct because enough real time had passed for
      // this same report to land by then, nothing about the refresh
      // itself actually fixed anything. Awaited now, and app.js's own
      // teardownActiveScreen() awaits this whole cleanup() in turn, so
      // the next screen's own first fetch cannot start until Jellyfin
      // has actually processed this report.
      await reportPlaybackStopped(itemId, mediaSource.Id, hasCreditedRealWatch ? 0 : currentPositionTicks());
      // Up Next and Continue Watching are exactly the two home rows a
      // real playback session changes, so home's own preloaded sections
      // have to be re-derived the next time it's visited rather than
      // keep serving what was true before this session started.
      invalidateHomeSections();
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  return cleanup;
}
