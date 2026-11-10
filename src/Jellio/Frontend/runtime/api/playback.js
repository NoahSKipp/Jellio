import { markPlaybackStarted, canReportProgress, markPlaybackStopped } from '../playbackGuard.js';
import { setVideoTranscodePolicy, getVideoTranscodePolicy } from '../transcodePolicy.js';
import { hasStreamInfo, filterPlayableSources } from '../quality.js';
import { getCurrentUserId, getServerAddress, getAuthHeaders } from '../auth.js';
import { isOffline, queueSync } from '../offline.js';
import { NEGOTIATION_TIMEOUT_MS, getJellioConfig, getJson, invalidateUserDataRows, invalidateUserDataRowsThrottled, postJson } from './core.js';

export { filterPlayableSources };

export function getPlaybackInfo(itemId, startTimeTicks, mediaSourceId, audioStreamIndex, subtitleStreamIndex) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const body = {
    UserId: userId,
    StartTimeTicks: startTimeTicks || 0,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AutoOpenLiveStream: true,
  };
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  if (audioStreamIndex != null) body.AudioStreamIndex = audioStreamIndex;
  if (subtitleStreamIndex != null) body.SubtitleStreamIndex = subtitleStreamIndex;
  return postJson('/Items/' + itemId + '/PlaybackInfo', body, NEGOTIATION_TIMEOUT_MS);
}

// How many downloads the server is converting and whether it has room
// for this user's, plus whether it encodes HEVC in hardware.
export function getConversionStatus() {
  return getJson('/Jellio/downloads/conversions', 8000);
}

export function getDownloadPlaybackInfo(itemId, mediaSourceId, audioStreamIndex, maxHeight, maxBitrate, hevc) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const codecs = hevc ? ['hevc', 'h264'] : ['h264'];
  const body = {
    UserId: userId,
    StartTimeTicks: 0,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: true,
    MaxStreamingBitrate: maxBitrate || 120000000,
    DeviceProfile: {
      Name: 'Jellio download',
      MaxStreamingBitrate: maxBitrate || 120000000,
      MaxStaticBitrate: maxBitrate || 120000000,
      DirectPlayProfiles: maxHeight
        ? [{ Container: 'mp4,m4v', Type: 'Video', VideoCodec: codecs.join(','), AudioCodec: 'aac,mp3' }]
        : [{ Type: 'Video' }],
      TranscodingProfiles: [
        {
          Container: 'mp4',
          Type: 'Video',
          Protocol: 'http',
          Context: 'Streaming',
          VideoCodec: codecs.join(','),
          AudioCodec: 'aac',
          MaxAudioChannels: '2',
        },
      ],
      CodecProfiles: maxHeight
        ? codecs.map((codec) => ({ Type: 'Video', Codec: codec, Conditions: [{ Condition: 'LessThanEqual', Property: 'Height', Value: String(maxHeight) }] }))
        : [],
      SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
    },
  };
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  if (audioStreamIndex != null) body.AudioStreamIndex = audioStreamIndex;
  return postJson('/Items/' + itemId + '/PlaybackInfo', body, NEGOTIATION_TIMEOUT_MS);
}

const prefetchedItemIds = new Set();
export function prefetchStreams(itemId) {
  if (!itemId || prefetchedItemIds.has(itemId)) return Promise.resolve();
  prefetchedItemIds.add(itemId);
  return fetch(getServerAddress() + '/gelato/prefetch/' + itemId, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
    .then(function () {})
    .catch(function () {
      prefetchedItemIds.delete(itemId);
    });
}

// Syncs the stream lists of a few titles on the server, one after another;
// answers which were queued and which were already warm.
export function prefetchStreamsBatch(itemIds, probe) {
  return fetch(getServerAddress() + '/gelato/prefetch-batch', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
    body: JSON.stringify({ ItemIds: itemIds, Probe: !!probe }),
  })
    .then(function (response) {
      if (!response.ok) return null;
      return response.json().catch(function () {
        return null;
      });
    })
    .catch(function () {
      return null;
    });
}

const warmCache = new Map();
const WARM_CACHE_MS = 30 * 1000;

// { sourceId: warmedAtUtc } for the sources that will start fast now; null
// when the server can't say.
export function getWarmSources(itemId, options) {
  const hit = warmCache.get(itemId);
  if (hit && Date.now() - hit.at < WARM_CACHE_MS && !(options && options.forceFresh)) return hit.promise;
  const promise = fetch(getServerAddress() + '/gelato/warm/' + itemId, { headers: getAuthHeaders(), cache: 'no-store' })
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .then(function (data) {
      return data && typeof data === 'object' ? data : null;
    })
    .catch(function () {
      return null;
    });
  warmCache.set(itemId, { at: Date.now(), promise: promise });
  return promise;
}

const tierCache = new Map();

// { sourceId: qualityTier }, e.g. "2160p-dv"; empty when the server can't say.
export function getQualityTiers(itemId) {
  if (tierCache.has(itemId)) return tierCache.get(itemId);
  const promise = fetch(getServerAddress() + '/gelato/tiers/' + itemId, { headers: getAuthHeaders() })
    .then(function (response) {
      return response.ok ? response.json() : {};
    })
    .then(function (data) {
      return data && typeof data === 'object' ? data : {};
    })
    .catch(function () {
      tierCache.delete(itemId);
      return {};
    });
  tierCache.set(itemId, promise);
  return promise;
}

const mediaSourcesCache = new Map();
// The last list loaded per title, kept past the cache's lifetime so a failed
// reload still leaves something to fail over to.
const lastMediaSources = new Map();

export function getLastMediaSources(itemId) {
  return lastMediaSources.get(String(itemId)) || null;
}
const mediaSourcesInFlight = new Map();
const MEDIA_SOURCES_TTL_MS = 5 * 60 * 1000;

// With no releases found, Gelato lists a single placeholder source with no
// quality, audio, video, or size info at all.
export function isPlaceholderSource(source) {
  if (!source) return false;
  return !hasStreamInfo(source);
}

export function getMediaSources(itemId, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const idStr = String(itemId);
  const now = Date.now();
  if (!options?.forceFresh && mediaSourcesCache.has(idStr)) {
    const entry = mediaSourcesCache.get(idStr);
    if (now - entry.time < MEDIA_SOURCES_TTL_MS) {
      return Promise.resolve(entry.sources);
    }
    mediaSourcesCache.delete(idStr);
  }
  // Callers asking while a lookup runs share it.
  if (!options?.forceFresh && mediaSourcesInFlight.has(idStr)) return mediaSourcesInFlight.get(idStr);
  const params = new URLSearchParams({ Fields: 'MediaSources,OriginalTitle,PremiereDate,ProductionYear' });
  const request = getJson('/Users/' + userId + '/Items/' + itemId + '?' + params.toString(), options && options.timeoutMs)
    .then(function (result) {
      const sources = filterPlayableSources(result && result.MediaSources);
      if (sources.length) {
        mediaSourcesCache.set(idStr, { time: Date.now(), sources: sources });
        lastMediaSources.set(idStr, { at: Date.now(), sources: sources });
      } else {
        mediaSourcesCache.delete(idStr);
      }
      return sources;
    })
    .finally(function () {
      if (mediaSourcesInFlight.get(idStr) === request) mediaSourcesInFlight.delete(idStr);
    });
  mediaSourcesInFlight.set(idStr, request);
  return request;
}

export function reportPlaybackStart(itemId, mediaSourceId, positionTicks) {
  markPlaybackStarted(itemId, mediaSourceId);
  if (isOffline()) return Promise.resolve();
  return postJson('/Sessions/Playing', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).then(invalidateUserDataRows).catch(function (err) {
    console.warn('Jellio: reportPlaybackStart failed', err);
  });
}

export function reportPlaybackProgress(itemId, mediaSourceId, positionTicks, isPaused) {
  // A Progress after Stopped would recreate the session on the server.
  if (isOffline() || !canReportProgress(itemId, mediaSourceId)) return Promise.resolve();
  return postJson('/Sessions/Playing/Progress', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    IsPaused: !!isPaused,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).then(function () {
    // A progress milestone, not every report.
    invalidateUserDataRowsThrottled(2 * 60000);
  }).catch(function (err) {
    console.warn('Jellio: reportPlaybackProgress failed', err);
  });
}

export function reportPlaybackStopped(itemId, mediaSourceId, positionTicks) {
  markPlaybackStopped(itemId, mediaSourceId);
  // Offline (a downloaded video or audiobook): the position is sent as
  // the item's user data once the server is back.
  if (isOffline()) {
    return queueSync('POST', '/UserItems/' + itemId + '/UserData', { PlaybackPositionTicks: positionTicks || 0 }).catch(() => {});
  }
  return postJson('/Sessions/Playing/Stopped', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
  }).then(invalidateUserDataRows).catch(function (err) {
    console.warn('Jellio: reportPlaybackStopped failed', err);
  });
}

export function startSleepTimer(minutes) {
  return postJson('/Jellio/sleep-timer/start', { Minutes: minutes });
}

export async function cancelSleepTimer() {
  const response = await fetch(getServerAddress() + '/Jellio/sleep-timer/cancel', {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return response.ok;
}

export function getSleepTimerStatus() {
  return getJson('/Jellio/sleep-timer/status');
}

export async function loadVideoTranscodePolicy() {
  const config = await getJellioConfig();
  setVideoTranscodePolicy(config && config.VideoTranscodePolicy);
  return getVideoTranscodePolicy();
}

function serverTranscodeReasons(mediaSource) {
  const url = (mediaSource && mediaSource.TranscodingUrl) || '';
  const match = /[?&]TranscodeReasons=([^&]*)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

export function logPlaybackDecision(itemId, mediaSource, classification, policy) {
  const body = {
    ItemId: itemId,
    MediaSourceId: (mediaSource && mediaSource.Id) || null,
    PlayMethod: classification.playMethod,
    Reasons: classification.reasons,
    ServerTranscodeReasons: serverTranscodeReasons(mediaSource),
    Guessed: !!classification.guessed,
    Policy: policy,
  };
  postJson('/Jellio/playback/decision', body).catch(function () {});
}

// One record per play once its first frame shows (runtime/playStart.js).
export function logPlayStart(record) {
  try {
    postJson('/Jellio/playback/start', record).catch(function () {});
  } catch (err) {}
}

// One line per switch to another stream: counts and ids, no addresses.
export function logFailoverDecision(entry) {
  const c = entry.counts;
  postJson('/Jellio/playback/failover', {
    ItemId: entry.itemId,
    FailedSourceId: entry.failedSourceId || null,
    Reason: entry.reason,
    Total: c.total,
    Tried: c.tried,
    BadHard: c.badHard,
    BadSoft: c.badSoft,
    AfterLanguage: c.afterLanguage,
    AfterTranscode: c.afterTranscode,
    ListOrigin: entry.loaded.origin,
    ListError: entry.loaded.error ? entry.loaded.error.kind : null,
    ListMs: entry.loaded.error ? entry.loaded.error.ms : null,
    Outcome: entry.outcome.action,
    NextSourceId: entry.outcome.sourceId || null,
    Client: 'web',
  }).catch(function () {});
}
