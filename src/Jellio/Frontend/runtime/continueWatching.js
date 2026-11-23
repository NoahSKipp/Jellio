function episodeOrder(item) {
  return (item.ParentIndexNumber || 0) * 10000 + (item.IndexNumber || 0);
}

// Past this share of its runtime an episode counts as finished.
const FINISHED_FRACTION = 0.9;

// A saved position clearly short of the end: something being watched,
// whatever the played flag says. Jellyfin keeps an episode marked played when
// it is watched again, so a rewatch looks like this.
export function isPartlyWatched(item) {
  const position = (item && item.UserData && item.UserData.PlaybackPositionTicks) || 0;
  if (position <= 0) return false;
  const runtime = (item && item.RunTimeTicks) || 0;
  return runtime <= 0 || position < runtime * FINISHED_FRACTION;
}

// Marked played and not being resumed partway.
export function isFinished(item) {
  return !!(item && item.UserData && item.UserData.Played) && !isPartlyWatched(item);
}

export function withoutStaleEpisodes(resumeItems, nextUpItems) {
  const nextBySeries = {};
  (nextUpItems || []).forEach(function (item) {
    if (item && item.SeriesId) nextBySeries[item.SeriesId] = item;
  });
  return (resumeItems || []).filter(function (item) {
    if (isFinished(item)) return false;
    const next = item.SeriesId ? nextBySeries[item.SeriesId] : null;
    return !next || episodeOrder(item) >= episodeOrder(next);
  });
}

// Most recently played first; items without a date go last, order otherwise kept.
export function recentlyPlayedFirst(items) {
  const list = (items || []).slice();
  const played = function (item) {
    return (item && item.UserData && item.UserData.LastPlayedDate) || '';
  };
  return list
    .map(function (item, index) {
      return { item: item, index: index };
    })
    .sort(function (a, b) {
      const pa = played(a.item);
      const pb = played(b.item);
      if (pa === pb) return a.index - b.index;
      return pa < pb ? 1 : -1;
    })
    .map(function (entry) {
      return entry.item;
    });
}
