// Which source Play starts with when some are ready (warm on the server)
// and others are not. Never across quality tiers: a ready 720p must not
// replace a 4K that is merely slower to start.
const PREFER_READY_KEY = 'jellio_prefer_ready_sources';

export function isPreferReadyEnabled() {
  try {
    return window.localStorage.getItem(PREFER_READY_KEY) !== '0';
  } catch (err) {
    return true;
  }
}

export function setPreferReadyEnabled(enabled) {
  try {
    window.localStorage.setItem(PREFER_READY_KEY, enabled ? '1' : '0');
  } catch (err) {}
}

// sources are already ordered (bad and re-encode ones last). Moves the
// first ready source of the leader's tier and rank to the front.
export function preferReadySource(sources, isReady, tierOf, rankOf) {
  if (!sources || sources.length < 2) return sources ? sources.slice() : [];
  const leader = sources[0];
  if (isReady(leader)) return sources.slice();
  const tier = tierOf(leader);
  if (!tier || tier === 'unknown') return sources.slice();
  const leaderRank = rankOf ? rankOf(leader) : 0;
  const index = sources.findIndex(function (source, i) {
    return i > 0 && isReady(source) && tierOf(source) === tier && (rankOf ? rankOf(source) : 0) <= leaderRank;
  });
  if (index === -1) return sources.slice();
  const ordered = sources.slice();
  const ready = ordered.splice(index, 1)[0];
  ordered.unshift(ready);
  return ordered;
}

// Ids the server said are already warm, to skip; tolerant of either case.
export function alreadyWarmIds(response) {
  if (!response || typeof response !== 'object') return [];
  const list = response.AlreadyWarm || response.alreadyWarm || [];
  return Array.isArray(list) ? list.map(normalizeId).filter(Boolean) : [];
}

export function normalizeId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}
