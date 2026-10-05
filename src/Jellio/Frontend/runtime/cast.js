// Cast & Smart TV Streaming Manager:
// Provides discovery and control for:
// 1. Jellyfin Smart TV clients (Android TV, Google TV, LG webOS, Samsung Tizen, Roku, Fire TV, Apple TV)
// 2. Google Cast (Chromecast / Android TV / Google TV / Cast-enabled Smart TVs) via Cast SDK
// 3. W3C Remote Playback API (video.remote) for wireless display streaming
// 4. Apple AirPlay for Apple TV and AirPlay 2 compatible Smart TVs
import { getDeviceId } from './auth.js';
import {
  getRemoteSessions,
  sendPlayCommand,
  sendPlaystateCommand,
  sendSessionGeneralCommand,
} from './api.js';

const TICKS_PER_SECOND = 10000000;
const POLL_INTERVAL_MS = 2500;

let activeCast = null;
let pollTimer = null;
const listeners = new Set();

export function getActiveCast() {
  return activeCast;
}

export function addCastListener(cb) {
  listeners.add(cb);
  return function unsubscribe() {
    listeners.delete(cb);
  };
}

function notifyListeners() {
  const snapshot = activeCast ? Object.assign({}, activeCast) : null;
  listeners.forEach(function (cb) {
    try {
      cb(snapshot);
    } catch (e) {
      console.warn('Jellio: cast listener error', e);
    }
  });
}

// === Google Cast SDK Loader & Manager ===
let googleCastInitialized = false;
let googleCastInitializing = false;
let remotePlayer = null;
let remotePlayerController = null;

export function initGoogleCast() {
  if (googleCastInitialized || googleCastInitializing) return Promise.resolve(googleCastInitialized);
  if (typeof window === 'undefined') return Promise.resolve(false);

  // If Cast framework is already loaded:
  if (window.cast && window.cast.framework) {
    setupCastFramework();
    return Promise.resolve(true);
  }

  googleCastInitializing = true;
  return new Promise(function (resolve) {
    window.__onGCastApiAvailable = function (isAvailable) {
      googleCastInitializing = false;
      if (isAvailable && window.cast && window.cast.framework) {
        setupCastFramework();
        resolve(true);
      } else {
        resolve(false);
      }
    };

    // Load cast sender script if not already present
    if (!document.querySelector('script[src*="cast_sender.js"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      script.async = true;
      script.onerror = function () {
        googleCastInitializing = false;
        resolve(false);
      };
      document.head.appendChild(script);
    }
  });
}

function setupCastFramework() {
  try {
    const castContext = window.cast.framework.CastContext.getInstance();
    castContext.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    remotePlayer = new window.cast.framework.RemotePlayer();
    remotePlayerController = new window.cast.framework.RemotePlayerController(remotePlayer);

    remotePlayerController.addEventListener(
      window.cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
      function () {
        if (remotePlayer.isConnected) {
          const session = castContext.getCurrentSession();
          const deviceName = (session && session.getCastDevice() && session.getCastDevice().friendlyName) || 'Chromecast';
          activeCast = {
            type: 'google-cast',
            name: deviceName,
            isPaused: remotePlayer.isPaused,
            positionTicks: Math.round((remotePlayer.currentTime || 0) * TICKS_PER_SECOND),
            durationTicks: Math.round((remotePlayer.duration || 0) * TICKS_PER_SECOND),
          };
        } else {
          if (activeCast && activeCast.type === 'google-cast') {
            activeCast = null;
          }
        }
        notifyListeners();
      },
    );

    remotePlayerController.addEventListener(
      window.cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
      function () {
        if (activeCast && activeCast.type === 'google-cast') {
          activeCast.isPaused = remotePlayer.isPaused;
          notifyListeners();
        }
      },
    );

    remotePlayerController.addEventListener(
      window.cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
      function () {
        if (activeCast && activeCast.type === 'google-cast') {
          activeCast.positionTicks = Math.round((remotePlayer.currentTime || 0) * TICKS_PER_SECOND);
          notifyListeners();
        }
      },
    );

    googleCastInitialized = true;
  } catch (err) {
    console.warn('Jellio: could not initialize Google Cast framework', err);
  }
}

export function isGoogleCastSupported() {
  return (
    (typeof window !== 'undefined' && (Boolean(window.cast && window.cast.framework) || Boolean(window.chrome && window.chrome.cast))) ||
    ('remote' in (HTMLVideoElement.prototype || {}))
  );
}

export function isAirPlaySupported(video) {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.WebKitPlaybackTargetAvailabilityEvent ||
    (video && typeof video.webkitShowPlaybackTargetPicker === 'function')
  );
}

// === Smart TV & Controllable Client Discovery ===
const TV_PATTERN = /tv|android\s*tv|google\s*tv|webos|lg|tizen|samsung|roku|fire\s*tv|firetv|apple\s*tv|appletv|shield|bravia|chromecast|kodi|jellyfin media player|theater|smart/i;

function isTvSession(session) {
  if (!session) return false;
  const name = (session.DeviceName || '') + ' ' + (session.Client || '');
  return TV_PATTERN.test(name);
}

export async function getAvailableCastTargets() {
  try {
    const sessions = await getRemoteSessions();
    if (!Array.isArray(sessions)) return [];

    const localDeviceId = getDeviceId();
    const targets = [];

    sessions.forEach(function (s) {
      if (!s || !s.Id) return;
      // Skip the local browser session
      if (localDeviceId && s.DeviceId === localDeviceId) return;

      const isTv = isTvSession(s);
      const isControllable = s.SupportsRemoteControl !== false;

      // Include all TVs and all explicitly controllable sessions
      if (isTv || isControllable) {
        targets.push({
          id: s.Id,
          name: s.DeviceName || s.Client || 'Smart TV',
          client: s.Client || '',
          userName: s.UserName || '',
          isTv: isTv,
          supportsRemote: isControllable,
          nowPlaying: s.NowPlayingItem
            ? s.NowPlayingItem.SeriesName
              ? s.NowPlayingItem.SeriesName + ' - ' + s.NowPlayingItem.Name
              : s.NowPlayingItem.Name
            : null,
          isPaused: s.PlayState ? !!s.PlayState.IsPaused : false,
          positionTicks: s.PlayState ? s.PlayState.PositionTicks || 0 : 0,
        });
      }
    });

    // Sort: Smart TVs first, then by name
    targets.sort(function (a, b) {
      if (a.isTv !== b.isTv) return a.isTv ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return targets;
  } catch (err) {
    console.warn('Jellio: could not fetch remote cast targets', err);
    return [];
  }
}

// === Cast Actions ===

// Cast to a Jellyfin Smart TV app session
export async function castToJellyfinSession(target, itemId, currentTicks, mediaSource, audioIndex, subtitleIndex) {
  stopSessionPolling();

  const options = {
    playCommand: 'PlayNow',
    startPositionTicks: currentTicks || 0,
    mediaSourceId: (mediaSource && mediaSource.Id) || null,
    audioStreamIndex: audioIndex != null ? audioIndex : null,
    subtitleStreamIndex: subtitleIndex != null ? subtitleIndex : null,
  };

  await sendPlayCommand(target.id, itemId, options);

  activeCast = {
    type: 'jellyfin',
    id: target.id,
    name: target.name,
    client: target.client,
    isPaused: false,
    positionTicks: currentTicks || 0,
    durationTicks: (mediaSource && mediaSource.RunTimeTicks) || 0,
  };

  startSessionPolling(target.id);
  notifyListeners();
  return activeCast;
}

// Cast via Google Cast SDK
export async function castToGoogleCast(streamUrl, item, currentSeconds) {
  if (!window.cast || !window.cast.framework) {
    await initGoogleCast();
  }

  const castContext = window.cast && window.cast.framework && window.cast.framework.CastContext.getInstance();
  if (!castContext) {
    throw new Error('Google Cast framework not available');
  }

  await castContext.requestSession();
  const session = castContext.getCurrentSession();
  if (!session) {
    throw new Error('No Google Cast session established');
  }

  const mediaInfo = new window.chrome.cast.media.MediaInfo(streamUrl, 'video/mp4');
  mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED;

  const metadata = new window.chrome.cast.media.GenericMediaMetadata();
  metadata.title = (item && item.Name) || 'Video';
  if (item && item.SeriesName) {
    metadata.subtitle = item.SeriesName;
  }
  mediaInfo.metadata = metadata;

  const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = currentSeconds || 0;
  request.autoplay = true;

  await session.loadMedia(request);

  const deviceName = (session.getCastDevice() && session.getCastDevice().friendlyName) || 'Chromecast';
  activeCast = {
    type: 'google-cast',
    name: deviceName,
    isPaused: false,
    positionTicks: Math.round((currentSeconds || 0) * TICKS_PER_SECOND),
  };

  notifyListeners();
  return activeCast;
}

// Cast via W3C Remote Playback API
export async function promptRemotePlayback(video) {
  if (!video || !video.remote || typeof video.remote.prompt !== 'function') {
    throw new Error('Remote Playback API not supported');
  }

  await video.remote.prompt();

  activeCast = {
    type: 'remote-playback',
    name: 'Wireless Display',
    isPaused: video.paused,
    positionTicks: Math.round((video.currentTime || 0) * TICKS_PER_SECOND),
  };

  const onDisconnect = function () {
    if (activeCast && activeCast.type === 'remote-playback') {
      activeCast = null;
      notifyListeners();
    }
    video.remote.removeEventListener('disconnect', onDisconnect);
  };
  video.remote.addEventListener('disconnect', onDisconnect);

  notifyListeners();
  return activeCast;
}

// Trigger Apple AirPlay picker
export function promptAirPlay(video) {
  if (!video || typeof video.webkitShowPlaybackTargetPicker !== 'function') {
    throw new Error('AirPlay not supported');
  }

  video.webkitShowPlaybackTargetPicker();
}

// === Remote Playback Controls ===

export async function sendRemotePlayPause(targetIsPaused) {
  if (!activeCast) return;

  if (activeCast.type === 'jellyfin') {
    const cmd = targetIsPaused ? 'Unpause' : 'Pause';
    await sendPlaystateCommand(activeCast.id, cmd);
    activeCast.isPaused = !targetIsPaused;
    notifyListeners();
  } else if (activeCast.type === 'google-cast' && remotePlayerController) {
    remotePlayerController.playOrPause();
  }
}

export async function sendRemoteSeek(targetTicks) {
  if (!activeCast) return;

  if (activeCast.type === 'jellyfin') {
    await sendPlaystateCommand(activeCast.id, 'Seek', targetTicks);
    activeCast.positionTicks = targetTicks;
    notifyListeners();
  } else if (activeCast.type === 'google-cast' && remotePlayer && remotePlayerController) {
    remotePlayer.currentTime = targetTicks / TICKS_PER_SECOND;
    remotePlayerController.seek();
  }
}

export async function sendRemoteVolume(volumePct) {
  if (!activeCast) return;

  if (activeCast.type === 'jellyfin') {
    await sendSessionGeneralCommand(activeCast.id, 'SetVolume', { Volume: String(volumePct) });
  } else if (activeCast.type === 'google-cast' && remotePlayer && remotePlayerController) {
    remotePlayer.volumeLevel = volumePct / 100;
    remotePlayerController.setVolumeLevel();
  }
}

// Disconnect active cast and return playback state to resume locally
export async function disconnectCast() {
  if (!activeCast) return null;

  let resumePositionTicks = activeCast.positionTicks || 0;
  const castType = activeCast.type;
  const sessionId = activeCast.id;

  stopSessionPolling();

  if (castType === 'jellyfin' && sessionId) {
    try {
      // Query one last time to get the precise latest position
      const sessions = await getRemoteSessions();
      const current = Array.isArray(sessions) && sessions.find(function (s) { return s.Id === sessionId; });
      if (current && current.PlayState && current.PlayState.PositionTicks != null) {
        resumePositionTicks = current.PlayState.PositionTicks;
      }
      await sendPlaystateCommand(sessionId, 'Stop');
    } catch (err) {
      console.warn('Jellio: error stopping remote session', err);
    }
  } else if (castType === 'google-cast') {
    try {
      const castContext = window.cast && window.cast.framework && window.cast.framework.CastContext.getInstance();
      if (castContext) {
        castContext.endCurrentSession(true);
      }
      if (remotePlayer && remotePlayer.currentTime) {
        resumePositionTicks = Math.round(remotePlayer.currentTime * TICKS_PER_SECOND);
      }
    } catch (err) {
      console.warn('Jellio: error ending Google Cast session', err);
    }
  }

  activeCast = null;
  notifyListeners();
  return { resumePositionTicks: resumePositionTicks };
}

// === Polling for Jellyfin Remote Session PlayState ===
function startSessionPolling(sessionId) {
  stopSessionPolling();
  pollTimer = window.setInterval(async function () {
    if (!activeCast || activeCast.type !== 'jellyfin' || activeCast.id !== sessionId) {
      stopSessionPolling();
      return;
    }

    try {
      const sessions = await getRemoteSessions();
      if (!Array.isArray(sessions)) return;

      const current = sessions.find(function (s) { return s.Id === sessionId; });
      if (!current) {
        // Session disappeared (user stopped playback or turned off TV)
        activeCast = null;
        stopSessionPolling();
        notifyListeners();
        return;
      }

      if (current.PlayState) {
        activeCast.isPaused = !!current.PlayState.IsPaused;
        if (current.PlayState.PositionTicks != null) {
          activeCast.positionTicks = current.PlayState.PositionTicks;
        }
        notifyListeners();
      }
    } catch (err) {
      // Best effort poll
    }
  }, POLL_INTERVAL_MS);
}

function stopSessionPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
