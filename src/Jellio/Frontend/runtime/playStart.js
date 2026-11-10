// How long a play took from the moment the player opened to the first
// frame, by stage. Stage values are ms since the start, not durations, as
// details and PlaybackInfo now overlap.

export function playStartClient(win) {
  return win && win.jellioNative ? 'macos' : 'web';
}

// `now` is a clock in ms (performance.now in the player). Time held, while
// the reader answers the resume prompt, is left out.
export function createPlayStartTrace(now) {
  const startedAt = now();
  let heldMs = 0;
  let holdStart = null;
  const marks = {};
  function elapsed() {
    const at = now();
    const holding = holdStart != null ? at - holdStart : 0;
    return Math.max(0, Math.round(at - startedAt - heldMs - holding));
  }
  return {
    mark(name) {
      if (marks[name] == null) marks[name] = elapsed();
      return marks[name];
    },
    get(name) {
      return marks[name] == null ? null : marks[name];
    },
    hold() {
      if (holdStart == null) holdStart = now();
    },
    release() {
      if (holdStart == null) return;
      heldMs += now() - holdStart;
      holdStart = null;
    },
    elapsed: elapsed,
  };
}

const TRIGGERS = ['detail', 'resume', 'next-episode', 'failover', 'other'];
const FROMS = ['prewarmed', 'prefetched', 'early', 'fresh'];

function msOrNull(value) {
  return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

export function buildPlayStartRecord(fields, trace) {
  const firstFrame = trace.get('firstFrame');
  return {
    ItemId: String(fields.itemId || ''),
    MediaSourceId: fields.mediaSourceId ? String(fields.mediaSourceId) : null,
    Client: fields.client === 'macos' || fields.client === 'tv' ? fields.client : 'web',
    Trigger: TRIGGERS.indexOf(fields.trigger) !== -1 ? fields.trigger : 'other',
    From: FROMS.indexOf(fields.from) !== -1 ? fields.from : 'fresh',
    WarmAtPlay: boolOrNull(fields.warmAtPlay),
    DirectPlay: boolOrNull(fields.directPlay),
    Stages: {
      DetailsMs: msOrNull(trace.get('details')),
      PlaybackInfoMs: msOrNull(trace.get('playbackInfo')),
      PlayerReadyMs: msOrNull(trace.get('playerReady')),
      FirstByteMs: msOrNull(trace.get('firstByte')),
      FirstFrameMs: msOrNull(firstFrame),
    },
    TotalMs: msOrNull(firstFrame != null ? firstFrame : trace.elapsed()) || 0,
  };
}

// What started the play: noted by the page that navigated here, else
// read from the player's own parameters.
export function playStartTrigger(noted, failover, resumeTicks) {
  if (failover) return 'failover';
  if (noted && TRIGGERS.indexOf(noted) !== -1) return noted;
  return resumeTicks > 0 ? 'resume' : 'other';
}

const NOTE_TTL_MS = 60000;
let notedTrigger = null;

export function notePlayTrigger(itemId, trigger, at) {
  notedTrigger = { itemId: String(itemId), trigger: trigger, at: at == null ? Date.now() : at };
}

export function takePlayTrigger(itemId, at) {
  const noted = notedTrigger;
  notedTrigger = null;
  const now = at == null ? Date.now() : at;
  if (!noted || noted.itemId !== String(itemId) || now - noted.at > NOTE_TTL_MS) return null;
  return noted.trigger;
}

// The reader's audio language is asked for in the first PlaybackInfo when
// the stream is known; a second one is only needed when the guess missed.
export function wantsAudioIndex(matchedIndex, audioCount) {
  return matchedIndex != null && audioCount > 1;
}

export function audioRematchNeeded(matchedIndex, audioCount, requestedIndex) {
  return wantsAudioIndex(matchedIndex, audioCount) && requestedIndex !== matchedIndex;
}
