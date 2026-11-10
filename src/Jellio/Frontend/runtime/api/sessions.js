import { getCurrentUserId } from '../auth.js';
import { getJson, postJson } from './core.js';

// === Remote Playback & Smart TV Sessions API ===
// Discovers all active Jellyfin client sessions (Smart TVs, mobile apps, desktop players).
export async function getRemoteSessions(controllableOnly) {
  const userId = getCurrentUserId();
  const results = [];
  const seenIds = new Set();

  function addSessions(sessions) {
    if (Array.isArray(sessions)) {
      sessions.forEach(function (s) {
        if (s && s.Id && !seenIds.has(s.Id)) {
          seenIds.add(s.Id);
          results.push(s);
        }
      });
    }
  }

  if (userId) {
    try {
      const userSessions = await getJson('/Sessions?ControllableByUserId=' + encodeURIComponent(userId));
      addSessions(userSessions);
    } catch (_) {}
  }

  try {
    const allSessions = await getJson('/Sessions');
    addSessions(allSessions);
  } catch (_) {}

  return results;
}

// Instructs a remote Jellyfin session (e.g. Smart TV app) to play an item.
export function sendPlayCommand(sessionId, itemId, options) {
  const opts = options || {};
  const params = new URLSearchParams({
    playCommand: opts.playCommand || 'PlayNow',
    itemIds: String(itemId),
  });
  if (opts.startPositionTicks != null) params.set('startPositionTicks', String(opts.startPositionTicks));
  if (opts.mediaSourceId) params.set('mediaSourceId', String(opts.mediaSourceId));
  if (opts.audioStreamIndex != null) params.set('audioStreamIndex', String(opts.audioStreamIndex));
  if (opts.subtitleStreamIndex != null) params.set('subtitleStreamIndex', String(opts.subtitleStreamIndex));
  if (opts.startIndex != null) params.set('startIndex', String(opts.startIndex));

  const body = {
    PlayCommand: opts.playCommand || 'PlayNow',
    ItemIds: Array.isArray(itemId) ? itemId : [itemId],
    StartPositionTicks: opts.startPositionTicks != null ? opts.startPositionTicks : 0,
    MediaSourceId: opts.mediaSourceId || null,
    AudioStreamIndex: opts.audioStreamIndex != null ? opts.audioStreamIndex : null,
    SubtitleStreamIndex: opts.subtitleStreamIndex != null ? opts.subtitleStreamIndex : null,
    StartIndex: opts.startIndex != null ? opts.startIndex : 0,
  };

  return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Playing?' + params.toString(), body);
}

// Sends playstate commands to an active remote session (PlayPause, Pause, Unpause, Stop, Seek).
export function sendPlaystateCommand(sessionId, command, seekPositionTicks) {
  let path = '/Sessions/' + encodeURIComponent(sessionId) + '/Playing/' + encodeURIComponent(command);
  if (seekPositionTicks != null) {
    path += '?seekPositionTicks=' + encodeURIComponent(String(seekPositionTicks));
  }
  return postJson(path, {});
}

// Sends general commands (e.g. SetVolume, Mute) to an active remote session.
export function sendSessionGeneralCommand(sessionId, name, args) {
  const body = {
    Name: name,
    Arguments: args || {},
  };
  return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Command/' + encodeURIComponent(name), body).catch(function () {
    return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Command', body);
  });
}
