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
  buildSubtitleUrl,
  getNextEpisode,
  getIntroSkipperSegments,
  getSeasons,
  getEpisodes,
  getCurrentUser,
  getTrickplayTileUrl,
  pickTrickplayInfo,
  TICKS_PER_SECOND,
  getGroupWatchMessages,
  sendGroupWatchMessage,
  creditGroupWatchTogether,
  creditRealWatch,
  voteRankingSession,
  startJoinSync,
  clearJoinSync,
  getJoinSync,
} from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { invalidateHomeSections } from './home.js';
import { sourceLabel, buildSourceCard } from '../components/streamPicker.js';
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
// episode: 2 minutes before the end, NuvioWeb's own real default
// (js/ui/screens/player/playerNextEpisodeRules.js, MINUTES_BEFORE_END
// mode), not re-derived. Real credits segments below make this the
// less common path, not the whole rule.
const UPNEXT_FALLBACK_TRIGGER_SECONDS = 120;
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
    item = await getItemDetails(itemId);
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
  let durationSeconds = (item.RunTimeTicks || 0) / TICKS_PER_SECOND;

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
  function showLoadingLogo() {
    if (!logoUrl) return;
    if (loadingLogo) loadingLogo.remove();
    loadingLogo = el('div', 'jellio-player-loading-logo');
    loadingLogo.style.backgroundImage = 'url(' + logoUrl + ')';
    root.appendChild(loadingLogo);
    video.addEventListener(
      'playing',
      function () {
        if (loadingLogo) {
          loadingLogo.remove();
          loadingLogo = null;
        }
      },
      { once: true },
    );
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
  const durationLabel = el('span', 'jellio-player-time', '0:00');
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
  if (trickplayInfo) {
    const scrubPreview = el('div', 'jellio-player-scrub-preview');
    const scrubImage = el('div', 'jellio-player-scrub-preview-image');
    const scrubTime = el('div', 'jellio-player-scrub-preview-time', '0:00');
    scrubImage.style.width = trickplayInfo.Width + 'px';
    scrubImage.style.height = trickplayInfo.Height + 'px';
    scrubPreview.appendChild(scrubImage);
    scrubPreview.appendChild(scrubTime);
    seekWrap.appendChild(scrubPreview);

    const thumbsPerTile = Math.max(1, trickplayInfo.TileWidth * trickplayInfo.TileHeight);
    let lastTileIndex = -1;

    function showScrubPreview(clientX) {
      const rect = seekBar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const hoveredSeconds = ratio * durationSeconds;

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
      scrubTime.textContent = formatTime(hoveredSeconds);

      const previewHalfWidth = trickplayInfo.Width / 2;
      const left = Math.min(rect.width - previewHalfWidth, Math.max(previewHalfWidth, ratio * rect.width));
      scrubPreview.style.left = left + 'px';
      scrubPreview.classList.add('jellio-player-scrub-preview-visible');
    }

    seekWrap.addEventListener('mousemove', function (event) {
      showScrubPreview(event.clientX);
    });
    seekWrap.addEventListener('mouseleave', function () {
      scrubPreview.classList.remove('jellio-player-scrub-preview-visible');
    });
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

  const speedButton = buildPillButton('speed', '1x');
  const subtitleButton = buildPillButton('subtitles', 'Subtitles');
  const audioButton = buildPillButton('graphic_eq', 'Audio');
  const sourceButton = buildPillButton('swap_horiz', 'Sources');
  sourceButton.disabled = true;
  const episodesButton = buildPillButton('video_library', 'Episodes');
  episodesButton.disabled = true;
  const sleepButton = buildPillButton('bedtime', 'Sleep');

  pill.appendChild(speedButton);
  pill.appendChild(subtitleButton);
  pill.appendChild(audioButton);
  pill.appendChild(sourceButton);
  pill.appendChild(episodesButton);
  pill.appendChild(sleepButton);

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

  // === Speed popover ===
  const speedMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  PLAYBACK_SPEEDS.forEach(function (speed) {
    const option = el(
      'button',
      'jellio-player-popover-option' + (speed === 1 ? ' jellio-player-popover-option-active' : ''),
      speed + 'x',
    );
    option.type = 'button';
    option.addEventListener('click', function () {
      video.playbackRate = speed;
      speedButton.querySelector('.jellio-player-pill-btn-label').textContent = speed + 'x';
      Array.prototype.forEach.call(speedMenu.children, function (child) {
        child.classList.remove('jellio-player-popover-option-active');
      });
      option.classList.add('jellio-player-popover-option-active');
      closePopovers(null);
    });
    speedMenu.appendChild(option);
  });
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
        cue.line = 'auto';
        cue.size = 100;
      } catch (err) {
        // A malformed value on one real cue is not worth losing every
        // other cue on the same track over.
      }
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
  rebuildSubtitleMenu();

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

  // === Audio track popover ===
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
    if (streams.length <= 1) {
      audioButton.disabled = true;
      return;
    }
    audioButton.disabled = false;
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
        if (isActive) {
          closePopovers(null);
          return;
        }
        switchAudioTrack(stream);
      });
      audioMenu.appendChild(option);
    });
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
  const sleepMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const cancelOption = el('button', 'jellio-player-popover-option', 'Cancel timer');
  cancelOption.type = 'button';
  cancelOption.addEventListener('click', function () {
    sleepTimerEpisodesRemaining = null;
    cancelSleepTimer().then(function () {
      sleepButton.classList.remove('jellio-player-pill-btn-active');
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
        sleepButton.classList.add('jellio-player-pill-btn-active');
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
      sleepButton.classList.add('jellio-player-pill-btn-active');
      closePopovers(null);
    });
    sleepMenu.appendChild(option);
  });
  registerPopover(sleepButton, sleepMenu);

  getSleepTimerStatus()
    .then(function (status) {
      if (status && status.Active) sleepButton.classList.add('jellio-player-pill-btn-active');
    })
    .catch(function () {
      // No status yet is not an error worth surfacing here.
    });

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
  const sourceList = el('div', 'jellio-player-sidepanel-list');
  sourcePanel.appendChild(sourceList);

  let sourceOptions = [mediaSource];
  let switchingSource = false;

  function closeSidePanels() {
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
  }

  function rebuildSourceMenu() {
    sourceList.textContent = '';
    sourceOptions.forEach(function (source) {
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
  function waitForPlayableBuffer(callback) {
    let settled = false;
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
      if (bufferedAheadSeconds() >= PREBUFFER_TARGET_SECONDS || video.readyState >= 4) settle();
    }
    const fallbackTimer = window.setTimeout(settle, PREBUFFER_TIMEOUT_MS);
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
    if (syncPlaylistItemId) {
      requestSyncSeek(Math.round(targetSeconds * TICKS_PER_SECOND)).catch(function (err) {
        console.warn('Jellio: could not send Group Watch seek', err);
      });
      return;
    }
    seekToAbsoluteSeconds(targetSeconds);
  }

  skipBackButton.addEventListener('click', function () {
    performSeek(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0) - 10);
  });
  skipForwardButton.addEventListener('click', function () {
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
      // A different source's own real subtitle track list has no
      // guaranteed relationship to the index that used to be active on
      // the one this just replaced.
      activeSubtitleStreamIndex = null;
      // Same real reason seekToAbsoluteSeconds forces a transcode for
      // any resumeTicks > 0: a Static direct play request's own
      // StartTimeTicks only actually seeks on a source that honours
      // HTTP Range, never guaranteed against a live Gelato proxy.
      const sourceForceTranscode = resumeTicks > 0;
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
  shell.appendChild(speedMenu);
  shell.appendChild(subtitleMenu);
  shell.appendChild(audioMenu);
  shell.appendChild(sleepMenu);
  shell.appendChild(sourcePanel);
  shell.appendChild(episodesPanel);

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
    shell.classList.remove('jellio-player-shell-idle');
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(hideControls, IDLE_HIDE_MS);
  }
  ['mousemove', 'touchstart', 'keydown', 'click'].forEach(function (eventName) {
    root.addEventListener(eventName, wakeControls);
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
    video.muted = false;
    video.volume = Math.min(1, Math.max(0, video.volume + delta));
    showPlayerToast('Volume ' + Math.round(video.volume * 100) + '%');
  }
  function toggleMute() {
    video.muted = !video.muted;
    showPlayerToast(video.muted ? 'Muted' : 'Unmuted');
  }
  function onPlayerKeydown(event) {
    if (screenTornDown || isTypingTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
    switch (event.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
        event.preventDefault();
        playPauseButton.click();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        skipBackButton.click();
        break;
      case 'ArrowRight':
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
      case 'Escape': {
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

  const skipButton = el('button', 'jellio-player-skip jellio-player-skip-hidden', 'Skip Intro');
  skipButton.type = 'button';
  let skipSegments = null;
  let skipTargetSeconds = 0;

  function activeSkipSegment(currentTime) {
    if (!skipSegments) return null;
    const intro = skipSegments.Introduction;
    if (intro && intro.End > 0 && currentTime >= intro.Start && currentTime < intro.End) {
      return { label: 'Skip Intro', target: intro.End };
    }
    const credits = skipSegments.Credits;
    if (credits && credits.End > 0 && currentTime >= credits.Start && currentTime < credits.End) {
      return { label: 'Skip Credits', target: credits.End };
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
    return duration - currentTime <= UPNEXT_FALLBACK_TRIGGER_SECONDS;
  }

  skipButton.addEventListener('click', function () {
    performSeek(skipTargetSeconds);
  });

  getIntroSkipperSegments(itemId).then(function (result) {
    if (result && (result.Introduction || result.Credits)) skipSegments = result;
  });

  root.appendChild(video);
  showLoadingLogo();
  root.appendChild(pauseOverlay);
  root.appendChild(syncWaitBanner);
  root.appendChild(skipButton);
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
  let upNextCountdownRemaining = UPNEXT_COUNTDOWN_SECONDS;

  function playNextEpisode() {
    if (upNextCountdownInterval) {
      window.clearInterval(upNextCountdownInterval);
      upNextCountdownInterval = null;
    }
    if (nextEpisode) navigateTo('#/play?id=' + nextEpisode.Id);
  }

  function updateUpNextCountdown() {
    if (upNextPlayButton) upNextPlayButton.textContent = 'Play now (' + upNextCountdownRemaining + ')';
  }

  function showUpNext() {
    if (upNextShown || upNextDismissed || !upNextOverlay) return;
    upNextShown = true;
    upNextOverlay.classList.remove('jellio-player-upnext-hidden');
    upNextCountdownRemaining = UPNEXT_COUNTDOWN_SECONDS;
    updateUpNextCountdown();
    upNextCountdownInterval = window.setInterval(function () {
      upNextCountdownRemaining -= 1;
      updateUpNextCountdown();
      if (upNextCountdownRemaining <= 0) playNextEpisode();
    }, 1000);
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

  function reconcileDuration() {
    const real = video.duration;
    if (real && isFinite(real) && real > 0) {
      durationSeconds = streamOffsetTicks / TICKS_PER_SECOND + real;
      durationLabel.textContent = formatTime(durationSeconds);
    }
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
    durationLabel.textContent = formatTime(durationSeconds);
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
  video.addEventListener('ended', function () {
    if (hasCreditedRealWatch) return;
    hasCreditedRealWatch = true;
    creditRealWatch(itemId).catch(function () {
      // Not fatal, AchievementService's own metadata based gate is
      // still there as a real fallback for this exact sitting.
    });
  });

  video.addEventListener('timeupdate', function () {
    if (seeking) return;
    const positionSeconds = streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0);
    if (durationSeconds) {
      seekBar.value = String((positionSeconds / durationSeconds) * 100);
    }
    currentTimeLabel.textContent = formatTime(positionSeconds);

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
      hasCreditedRealWatch = true;
      creditRealWatch(itemId).catch(function () {
        // Not fatal, AchievementService's own metadata based gate is
        // still there as a real fallback for this exact sitting.
      });
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
          sleepButton.classList.remove('jellio-player-pill-btn-active');
          dismissUpNext();
        } else {
          showUpNext();
        }
      } else {
        showUpNext();
      }
    }

    const activeSegment = activeSkipSegment(positionSeconds);
    if (activeSegment) {
      skipTargetSeconds = activeSegment.target;
      skipButton.textContent = activeSegment.label;
      skipButton.classList.remove('jellio-player-skip-hidden');
    } else {
      skipButton.classList.add('jellio-player-skip-hidden');
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
    playPauseIcon.className = 'material-icons pause';
    playPauseButton.setAttribute('aria-label', 'Pause');
    pauseOverlay.classList.remove('jellio-player-pause-overlay-visible');
  });
  video.addEventListener('pause', function () {
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
  function cleanup() {
    if (screenTornDown) return;
    screenTornDown = true;
    document.removeEventListener('keydown', onPlayerKeydown);
    exitFullscreenOnCleanup();
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
      reportPlaybackStopped(itemId, mediaSource.Id, currentPositionTicks());
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
