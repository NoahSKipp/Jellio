import { getAuthHeaders, getCurrentUserId, getDeviceId, getServerAddress } from './auth.js';
import { cache, cached, getJson, invalidateCache, postJson, setWatchlist } from './api.js';

const LIVE_OPEN_TIMEOUT_MS = 30000;

export function getLiveChannels(options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    UserId: userId,
    Limit: '1000',
    SortBy: 'SortName',
    AddCurrentProgram: 'true',
    EnableUserData: 'true',
    EnableImageTypes: 'Primary',
    ImageTypeLimit: '1',
  });
  const path = '/LiveTv/Channels?' + params.toString();
  if (options && options.fresh) invalidateCache('live:channels');
  return cached('live:channels', function () {
    return getJson(path, 20000).then(function (result) {
      return (result && result.Items) || [];
    });
  }, 60000);
}

export function getLivePrograms(channelIds, fromMs, untilMs) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return postJson('/LiveTv/Programs', {
    UserId: userId,
    ChannelIds: channelIds,
    MinEndDate: new Date(fromMs).toISOString(),
    MaxStartDate: new Date(untilMs).toISOString(),
    SortBy: ['StartDate'],
    Limit: 500,
    EnableTotalRecordCount: false,
    EnableImages: false,
  }, 20000).then(function (result) {
    return (result && result.Items) || [];
  });
}

const LIVE_HLS_PROFILE = {
  MaxStreamingBitrate: 40000000,
  MaxStaticBitrate: 40000000,
  DirectPlayProfiles: [],
  TranscodingProfiles: [
    {
      Container: 'ts',
      Type: 'Video',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      Protocol: 'hls',
      Context: 'Streaming',
      MaxAudioChannels: '6',
      MinSegments: 1,
      BreakOnNonKeyFrames: true,
    },
  ],
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: [],
};

export async function openLiveChannel(channelId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const path = '/Items/' + channelId + '/PlaybackInfo?UserId=' + userId + '&AutoOpenLiveStream=true';
  const info = await postJson(path, {
    UserId: userId,
    AutoOpenLiveStream: true,
    DeviceProfile: LIVE_HLS_PROFILE,
    MaxStreamingBitrate: LIVE_HLS_PROFILE.MaxStreamingBitrate,
  }, LIVE_OPEN_TIMEOUT_MS);
  if (info && info.ErrorCode) {
    const err = new Error(info.ErrorCode);
    err.code = info.ErrorCode;
    throw err;
  }
  const source = info && info.MediaSources && info.MediaSources[0];
  if (!source || !source.TranscodingUrl) {
    const err = new Error('No playable live stream');
    if (source && source.LiveStreamId) err.liveStreamId = source.LiveStreamId;
    if (info && info.PlaySessionId) err.playSessionId = info.PlaySessionId;
    throw err;
  }
  return {
    liveStreamId: source.LiveStreamId || null,
    playSessionId: info.PlaySessionId || null,
    mediaSourceId: source.Id,
    hlsUrl: getServerAddress() + source.TranscodingUrl,
  };
}

// keepalive so it still goes out when the tab is closing.
export function closeLiveStream(liveStreamId, playSessionId) {
  if (!liveStreamId) return Promise.resolve();
  const headers = getAuthHeaders();
  const closing = fetch(getServerAddress() + '/LiveStreams/Close?liveStreamId=' + encodeURIComponent(liveStreamId), {
    method: 'POST',
    headers: headers,
    keepalive: true,
  }).then(function () {});
  if (!playSessionId) return closing;
  const stopping = fetch(
    getServerAddress() + '/Videos/ActiveEncodings?deviceId=' + encodeURIComponent(getDeviceId()) + '&playSessionId=' + encodeURIComponent(playSessionId),
    { method: 'DELETE', headers: headers, keepalive: true },
  ).then(function () {}).catch(function () {});
  return Promise.all([closing, stopping]).then(function () {});
}

// Jellio/StreamLinks: errors come back as { Error: code } with a 422,
// which the caller turns into a sentence.
async function streamLinkRequest(method, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(function () {
    controller.abort();
  }, timeoutMs || 20000);
  try {
    const headers = Object.assign({ Accept: 'application/json' }, getAuthHeaders());
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(getServerAddress() + '/Jellio/StreamLinks' + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {}
    if (!response.ok) {
      const err = new Error('Stream link request failed: ' + response.status);
      err.status = response.status;
      err.code = (data && (data.Error || data.error)) || (response.status === 404 ? 'not_found' : 'failed');
      throw err;
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeout = new Error('Stream link request timed out');
      timeout.code = 'timeout';
      throw timeout;
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export function getStreamLinks() {
  return streamLinkRequest('GET', '', undefined, 15000).then(function (links) {
    return links || [];
  });
}

// Following a page to its stream can take a while.
export function addStreamLink(url, name) {
  return streamLinkRequest('POST', '', { Url: url, Name: name || null }, 45000);
}

export function removeStreamLink(id) {
  return streamLinkRequest('DELETE', '/' + encodeURIComponent(id), undefined, 15000);
}

// One channel out of a playlist; it stays out after a refresh.
export function removeStreamLinkEntry(id, index) {
  return streamLinkRequest('DELETE', '/' + encodeURIComponent(id) + '/entries/' + index, undefined, 15000);
}

export function refreshStreamLink(id) {
  return streamLinkRequest('POST', '/' + encodeURIComponent(id) + '/refresh', undefined, 45000);
}

// Resolved fresh on every play; the proxy address is what the browser
// plays, so streams on other sites and plain http still work.
export async function playStreamLink(linkId, entry) {
  const query = entry == null ? '' : '?entry=' + entry;
  const info = await streamLinkRequest('POST', '/' + encodeURIComponent(linkId) + '/play' + query, undefined, 40000);
  return {
    name: info.Name,
    format: info.Format,
    mime: info.Mime,
    url: getServerAddress() + '/' + info.ProxyPath,
  };
}

// Channels that failed to start for anyone recently: { id: { Status, Since } }.
export function getLiveHealth(options) {
  if (options && options.fresh) invalidateCache('live:health');
  return cached('live:health', function () {
    return getJson('/Jellio/LiveHealth', 10000).then(function (result) {
      return result || {};
    });
  }, 60000).catch(function () {
    return {};
  });
}

function reportQuietly(path, body) {
  try {
    fetch(getServerAddress() + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(function () {});
  } catch (err) {}
}

// What happened when this client opened a channel, so others can see a
// broken one before trying it.
export function reportLiveChannel(channelId, ok, error) {
  invalidateCache('live:health');
  reportQuietly('/Jellio/LiveHealth/' + encodeURIComponent(channelId), { Ok: !!ok, Error: error || null });
}

// Now Playing and the live TV badges: every half minute while live plays.
export function reportLiveWatching(body) {
  reportQuietly('/Jellio/now-playing/live', body);
}

export function stopLiveWatching() {
  try {
    fetch(getServerAddress() + '/Jellio/now-playing/live', {
      method: 'DELETE',
      headers: getAuthHeaders(),
      keepalive: true,
    }).catch(function () {});
  } catch (err) {}
}

export function reportStreamLinkPlay(linkId, ok) {
  reportQuietly('/Jellio/StreamLinks/' + encodeURIComponent(linkId) + '/report', { Ok: !!ok });
}

export function setChannelFavorite(channelId, favorite) {
  invalidateCache('live:channels');
  return setWatchlist(channelId, favorite);
}
