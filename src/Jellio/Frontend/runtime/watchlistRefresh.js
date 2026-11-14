export const WATCHLIST_POLL_INTERVAL_MS = 20000;

export function watchlistIdsChanged(previousIds, nextIds) {
  const prev = Array.isArray(previousIds) ? previousIds : [];
  const next = Array.isArray(nextIds) ? nextIds : [];
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] !== next[i]) return true;
  }
  return false;
}
