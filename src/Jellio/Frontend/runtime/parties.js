// Watch parties: pure helpers shared by the Group Watch panel and the
// player (components/groupWatch.js, screens/player.js).

export const PARTY_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '🎉'];
export const COUNTDOWN_SECONDS = 5;
// The host starts the countdown once everyone is ready, or after this.
export const READY_WAIT_MS = 20000;

const TICKS_PER_SECOND = 10000000;

// "12:31" or "1:02:03" in a chat message: where the group should jump to.
const TIMESTAMP = /(^|[^\d:])((?:(\d{1,2}):)?([0-5]?\d):([0-5]\d))(?![\d:])/g;

export function splitTimestamps(text) {
  const parts = [];
  const value = String(text || '');
  let last = 0;
  let match;
  TIMESTAMP.lastIndex = 0;
  while ((match = TIMESTAMP.exec(value))) {
    const start = match.index + match[1].length;
    if (start > last) parts.push({ text: value.slice(last, start) });
    const hours = match[3] ? Number(match[3]) : 0;
    const seconds = hours * 3600 + Number(match[4]) * 60 + Number(match[5]);
    parts.push({ text: match[2], seconds: seconds });
    last = start + match[2].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n);
  };
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

// The server's clock against this one, from a response's ServerNow.
export function clockSkewMs(serverNowIso, receivedAtMs) {
  const server = Date.parse(serverNowIso);
  return Number.isNaN(server) ? 0 : server - (receivedAtMs || Date.now());
}

// Whole seconds left on a countdown ending at endsAtIso (server time).
export function countdownSecondsLeft(endsAtIso, skewMs, nowMs) {
  const ends = Date.parse(endsAtIso);
  if (Number.isNaN(ends)) return null;
  return Math.ceil((ends - skewMs - (nowMs || Date.now())) / 1000);
}

// Members ready for this queue item, against everyone in the group.
export function readyCount(state, playlistItemId, participantCount) {
  const ready = ((state && state.Ready) || []).filter(function (entry) {
    return entry.PlaylistItemId === playlistItemId;
  }).length;
  return { ready: ready, total: Math.max(participantCount || 0, ready), all: participantCount > 0 && ready >= participantCount };
}

export function partyProgress(party) {
  const runtime = party && party.Item && party.Item.RunTimeTicks;
  if (!runtime || party.PositionTicks == null) return null;
  return Math.max(0, Math.min(1, party.PositionTicks / runtime));
}

export function positionLabel(party) {
  if (!party || party.PositionTicks == null) return '';
  return formatClock(party.PositionTicks / TICKS_PER_SECOND);
}

// What a party card says it is showing.
export function partyTitle(item) {
  if (!item) return '';
  if (item.Type === 'Episode' && item.SeriesName) {
    const code = item.SeasonNumber != null && item.EpisodeNumber != null ? ' · S' + item.SeasonNumber + ' E' + item.EpisodeNumber : '';
    return item.SeriesName + code;
  }
  return item.Name || '';
}
