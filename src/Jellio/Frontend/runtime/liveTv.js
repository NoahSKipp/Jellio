// Live TV data shaping, kept free of DOM and network so it can be tested
// on its own. Channel ids are stable (tvg id); channel numbers are not, so
// nothing here keys or remembers anything by number.

const HOUR_MS = 60 * 60 * 1000;
export const GUIDE_HOURS = 24;

function time(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

export function programmeProgress(start, end, nowMs) {
  if (start == null || end == null || end <= start) return 0;
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

function mapProgramme(dto, nowMs) {
  if (!dto) return null;
  const start = time(dto.StartDate);
  const end = time(dto.EndDate);
  return {
    id: dto.Id || null,
    name: dto.Name || dto.EpisodeTitle || '',
    start: start,
    end: end,
    progress: programmeProgress(start, end, nowMs),
  };
}

export function mapChannel(dto, nowMs) {
  const now = mapProgramme(dto.CurrentProgram, nowMs);
  return {
    id: dto.Id,
    name: dto.Name || '',
    number: dto.ChannelNumber || dto.Number || '',
    imageTag: (dto.ImageTags && dto.ImageTags.Primary) || null,
    favorite: !!(dto.UserData && dto.UserData.IsFavorite),
    now: now && now.end != null && now.end > nowMs ? now : null,
  };
}

export function mapChannels(items, nowMs) {
  return (items || []).filter(function (dto) {
    return dto && dto.Id;
  }).map(function (dto) {
    return mapChannel(dto, nowMs);
  });
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Matches the channel name or what is on now; every word has to appear.
export function filterChannels(channels, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return channels.slice();
  return channels.filter(function (channel) {
    const haystack = normalize(channel.name + ' ' + (channel.now ? channel.now.name : ''));
    return words.every(function (word) {
      return haystack.indexOf(word) !== -1;
    });
  });
}

// Favourites first, then channels with something on now, then the rest,
// each group in name order.
export function arrangeChannels(channels) {
  function byName(a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }
  const favorites = channels.filter(function (c) {
    return c.favorite;
  }).sort(byName);
  const rest = channels.filter(function (c) {
    return !c.favorite;
  });
  const live = rest.filter(function (c) {
    return c.now;
  }).sort(byName);
  const idle = rest.filter(function (c) {
    return !c.now;
  }).sort(byName);
  return { favorites: favorites, others: live.concat(idle) };
}

// The programmes of the next `hours`, in start order, the one airing now
// marked; anything already over is dropped.
export function guideWindow(programs, nowMs, hours) {
  const until = nowMs + (hours || GUIDE_HOURS) * HOUR_MS;
  return (programs || [])
    .map(function (dto) {
      return mapProgramme(dto, nowMs);
    })
    .filter(function (p) {
      return p && p.start != null && p.end != null && p.end > nowMs && p.start < until;
    })
    .sort(function (a, b) {
      return a.start - b.start;
    })
    .map(function (p) {
      return Object.assign(p, { airing: p.start <= nowMs && p.end > nowMs });
    });
}

export function nowAndNext(programs, nowMs) {
  const window = guideWindow(programs, nowMs, GUIDE_HOURS);
  const now = window.find(function (p) {
    return p.airing;
  }) || null;
  const next = window.find(function (p) {
    return p.start >= nowMs && p !== now;
  }) || null;
  return { now: now, next: next };
}

// Channel up/down through the list as shown, wrapping at either end.
export function neighbourChannel(list, currentId, delta) {
  if (!list || !list.length) return null;
  const index = list.findIndex(function (c) {
    return c.id === currentId;
  });
  if (index === -1) return list[0];
  const next = (index + delta + list.length) % list.length;
  return list[next];
}

// One live stream at a time: opening a channel closes the one before it,
// and stop() always closes whatever is open, once. open(channelId) must
// resolve to { liveStreamId, ... }; close(liveStreamId) may fail quietly.
export function createLiveLifecycle(open, close) {
  let current = null;
  let generation = 0;

  async function closeCurrent() {
    const stream = current;
    current = null;
    if (stream && stream.liveStreamId) {
      try {
        await close(stream.liveStreamId);
      } catch (err) {}
    }
  }

  return {
    async start(channelId) {
      const mine = ++generation;
      await closeCurrent();
      const stream = await open(channelId);
      if (mine !== generation) {
        // Superseded (a fast channel change or leaving) while opening.
        if (stream && stream.liveStreamId) {
          try {
            await close(stream.liveStreamId);
          } catch (err) {}
        }
        return null;
      }
      current = stream;
      return stream;
    },
    async stop() {
      generation++;
      await closeCurrent();
    },
    current() {
      return current;
    },
  };
}

// No tuner free, or the source refused: what the reader is told.
export function describeOpenFailure(err) {
  const text = String((err && (err.message || err.status)) || '').toLowerCase();
  if (/tuner|no available|too many|limit/.test(text)) {
    return 'All tuners are busy right now. Close another live channel or try again shortly.';
  }
  if (/timed? ?out|timeout/.test(text)) {
    return 'The channel took too long to start. Try again.';
  }
  return 'This channel could not be started right now.';
}
