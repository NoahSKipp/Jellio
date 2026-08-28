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
} from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { invalidateHomeSections } from './home.js';
import { sourceLabel, buildSourceCard } from '../components/streamPicker.js';
import { renderLoading } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { languageName } from '../runtime/languages.js';

const PROGRESS_REPORT_MS = 5000;
const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];
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

// ::cue only takes the values this runtime's own stylesheet sets on it
// (css/app.css's own .jellio-player-video::cue rule reads these same
// two custom properties), inherited down from whatever sets them on
// the video element itself, real behaviour every Chromium/Firefox
// WebVTT renderer already gives a custom property, not something this
// runtime is guessing works.
function applySubtitleStyle(video, style) {
  const size = SUBTITLE_SIZES.filter((s) => s.value === style.size)[0] || SUBTITLE_SIZES[1];
  const background = SUBTITLE_BACKGROUNDS.filter((b) => b.value === style.background)[0] || SUBTITLE_BACKGROUNDS[1];
  video.style.setProperty('--jellio-subtitle-size', size.rem + 'rem');
  video.style.setProperty('--jellio-subtitle-bg', background.color);
}

// Fallback only, when Intro Skipper has no Credits segment for this
// episode: 2 minutes before the end, NuvioWeb's own real default
// (js/ui/screens/player/playerNextEpisodeRules.js, MINUTES_BEFORE_END
// mode), not re-derived. Real credits segments below make this the
// less common path, not the whole rule.
const UPNEXT_FALLBACK_TRIGGER_SECONDS = 120;
const UPNEXT_COUNTDOWN_SECONDS = 15;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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

export async function renderPlayer(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-player';

  const itemId = params.get('id');
  if (!itemId) {
    renderPlaybackError(root, null, 'Nothing to play.');
    return undefined;
  }

  // Play already navigates here the instant it is pressed
  // (components/streamPicker.js's own real choice, or the detail
  // screen's own Play button skipping the picker outright): everything
  // below this point negotiates a real stream before a single frame can
  // show, real work that takes real time on a slow connection, so this
  // is the only thing telling the reader Play actually did something in
  // that gap rather than nothing at all.
  renderLoading(root);

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

  const startTicks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
  const isEpisodeItem = item.Type === 'Episode' && !!item.SeriesName;

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
    const user = await getCurrentUser();
    const preferredLanguage = user && user.Configuration && user.Configuration.AudioLanguagePreference;
    const matchedIndex = preferredLanguage ? matchAudioStreamIndex(mediaSource, preferredLanguage) : null;
    if (matchedIndex != null && matchedIndex !== mediaSource.DefaultAudioStreamIndex) {
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
  const streamUrl = buildStreamUrl(itemId, mediaSource, startTicks, {
    audioStreamIndex: currentAudioStreamIndex,
    forceTranscode: startTicks > 0,
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
  // Real feedback: a matched preferred-language track above stayed
  // selected in this screen's own audio menu but the wrong one still
  // played, until switching to another track and back forced a real
  // transcode. switchAudioTrack() below already knows a direct playable
  // source serves every embedded track as is and forces one whenever
  // its own requested index differs from the source's default; this
  // first real request never asked for that same forcing, so a
  // preferred language that only won the match above, not the server's
  // own DefaultAudioStreamIndex too, went out over a Static request that
  // could never actually select it.
  let streamIsTranscoded =
    startTicks > 0 ||
    (currentAudioStreamIndex != null && currentAudioStreamIndex !== mediaSource.DefaultAudioStreamIndex) ||
    !canBrowserDirectPlay(mediaSource);
  let streamOffsetTicks = streamIsTranscoded ? startTicks : 0;
  const durationSeconds = (item.RunTimeTicks || 0) / TICKS_PER_SECOND;

  // A real saved position asks first rather than always silently
  // seeking there: autoplay stays off until the reader actually picks
  // Resume or Start Over below, the paused frame at the saved position
  // showing through behind that choice instead of playback already
  // running underneath it.
  const hasResumePosition = startTicks > 0;

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
  // the very first stream is still loading, standing in for a plain
  // spinner. Only for the one real loading window before playback ever
  // starts here, real feedback did not ask for this on every later
  // pause, only removed once the video actually starts for the first
  // time, never rebuilt after.
  let loadingLogo = null;
  const logoUrl = seriesAwareLogoUrl(800);
  if (logoUrl) {
    loadingLogo = el('div', 'jellio-player-loading-logo');
    loadingLogo.style.backgroundImage = 'url(' + logoUrl + ')';
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
  function registerPopover(button, menu) {
    popovers.push({ button: button, menu: menu });
    button.addEventListener('click', function () {
      closePopovers(menu);
      const nowHidden = menu.classList.toggle('jellio-player-popover-hidden');
      button.setAttribute('aria-expanded', String(!nowHidden));
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

  function selectSubtitle(stream, optionButton) {
    if (activeTrack) {
      activeTrack.remove();
      activeTrack = null;
    }
    activeSubtitleStreamIndex = stream ? stream.Index : null;
    Array.prototype.forEach.call(subtitleList.children, function (child) {
      child.classList.remove('jellio-player-popover-option-active');
    });
    if (optionButton) optionButton.classList.add('jellio-player-popover-option-active');
    subtitleButton.classList.toggle('jellio-player-pill-btn-active', !!stream);
    if (!stream) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = stream.DisplayTitle || stream.Language || 'Subtitle';
    track.srclang = stream.Language || '';
    track.src = buildSubtitleUrl(itemId, mediaSource.Id, stream);
    track.default = true;
    video.appendChild(track);
    activeTrack = track;
    track.addEventListener('load', function () {
      if (track.track) track.track.mode = 'showing';
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
      streamOffsetTicks = resumeTicks;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        burnInSubtitleStreamIndex: stream.Index,
        forceTranscode: true,
        playSessionId: playSessionId,
      });
      video.load();
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

    const noneOption = el('button', 'jellio-player-popover-option jellio-player-popover-option-active', 'None');
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
      // Same real reason seekToAbsoluteSeconds and switchSource both
      // force a transcode for any resumeTicks > 0: switching back to
      // the default track mid playback still needs a real seek to
      // resumeTicks, which a Static direct play request's own
      // StartTimeTicks cannot reliably do here either.
      streamIsTranscoded =
        resumeTicks > 0 || stream.Index !== mediaSource.DefaultAudioStreamIndex || !canBrowserDirectPlay(mediaSource);
      streamOffsetTicks = streamIsTranscoded ? resumeTicks : 0;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        forceTranscode: resumeTicks > 0,
        playSessionId: playSessionId,
      });
      video.load();
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
  const sleepMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden');
  const cancelOption = el('button', 'jellio-player-popover-option', 'Cancel timer');
  cancelOption.type = 'button';
  cancelOption.addEventListener('click', function () {
    cancelSleepTimer().then(function () {
      sleepButton.classList.remove('jellio-player-pill-btn-active');
      closePopovers(null);
    });
  });
  sleepMenu.appendChild(cancelOption);
  SLEEP_TIMER_OPTIONS.forEach(function (minutes) {
    const option = el('button', 'jellio-player-popover-option', minutes + ' min');
    option.type = 'button';
    option.addEventListener('click', function () {
      startSleepTimer(minutes).then(function () {
        sleepButton.classList.add('jellio-player-pill-btn-active');
        closePopovers(null);
      });
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
      thumb.appendChild(el('span', 'jellio-player-episode-rating', episode.CommunityRating.toFixed(1)));
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
  function attemptPlay() {
    const playResult = video.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(function (err) {
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
  const PREBUFFER_TIMEOUT_MS = 6000;
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
  async function seekToAbsoluteSeconds(targetSeconds) {
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
      streamOffsetTicks = targetTicks;
      hasReportedStart = false;
      video.src = buildStreamUrl(itemId, mediaSource, targetTicks, {
        audioStreamIndex: currentAudioStreamIndex,
        burnInSubtitleStreamIndex: burnedInSubtitleIndex,
        forceTranscode: true,
        playSessionId: playSessionId,
      });
      video.load();
      if (wasPlaying) waitForPlayableBuffer(attemptPlay);
    } catch (err) {
      console.warn('Jellio: seek failed', err);
      showPlayerToast('Seek failed: ' + (err && err.message ? err.message : err));
    }
  }

  skipBackButton.addEventListener('click', function () {
    seekToAbsoluteSeconds(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0) - 10);
  });
  skipForwardButton.addEventListener('click', function () {
    seekToAbsoluteSeconds(streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0) + 10);
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
      streamIsTranscoded = resumeTicks > 0 || !canBrowserDirectPlay(mediaSource);
      streamOffsetTicks = streamIsTranscoded ? resumeTicks : 0;
      video.src = buildStreamUrl(itemId, mediaSource, resumeTicks, {
        forceTranscode: resumeTicks > 0,
        playSessionId: playSessionId,
      });
      video.load();
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
  function hideControls() {
    if (video.paused) return;
    const anyPopoverOpen = popovers.some(function (entry) {
      return !entry.menu.classList.contains('jellio-player-popover-hidden');
    });
    if (anyPopoverOpen) return;
    if (!sourcePanel.classList.contains('jellio-player-sidepanel-hidden')) return;
    if (!episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) return;
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
  if (item.CommunityRating) pauseMeta.appendChild(el('span', null, item.CommunityRating.toFixed(1) + ' ★'));
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
    seekToAbsoluteSeconds(skipTargetSeconds);
  });

  getIntroSkipperSegments(itemId).then(function (result) {
    if (result && (result.Introduction || result.Credits)) skipSegments = result;
  });

  root.appendChild(video);
  if (loadingLogo) root.appendChild(loadingLogo);
  root.appendChild(pauseOverlay);
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
            video.src = buildStreamUrl(itemId, mediaSource, 0, {
              audioStreamIndex: currentAudioStreamIndex,
              forceTranscode: true,
              playSessionId: playSessionId,
            });
            video.load();
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
  } else {
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
    // streamUrl already starts encoding at startTicks server side for a
    // forced transcode (see streamOffsetTicks above), so seeking again
    // here would double the offset; only a direct play stream, the
    // whole file already sitting there, needs this real client side
    // seek to reach the saved position at all.
    if (startTicks > 0 && !streamIsTranscoded) {
      video.currentTime = startTicks / TICKS_PER_SECOND;
    }
    durationLabel.textContent = formatTime(durationSeconds);
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

    if (nextEpisode && !upNextDismissed && shouldShowUpNextNow(positionSeconds, durationSeconds)) {
      showUpNext();
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
      seekToAbsoluteSeconds((Number(seekBar.value) / 100) * durationSeconds);
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

  // A real function declaration, hoisted, rather than the plain arrow
  // this used to just return directly: the video's own error listener
  // above now calls this same real teardown itself on a dead first
  // load rather than duplicating what it already does, and needs to
  // reach it from earlier in this same function body.
  function cleanup() {
    if (screenTornDown) return;
    screenTornDown = true;
    window.clearInterval(progressInterval);
    if (upNextCountdownInterval) window.clearInterval(upNextCountdownInterval);
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
