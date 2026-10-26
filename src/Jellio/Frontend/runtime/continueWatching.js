// Continue Watching without what is already done: titles marked watched that
// still carry an old resume position, and half-watched episodes of a show
// whose Next Up has already moved past them.
function episodeOrder(item) {
  return (item.ParentIndexNumber || 0) * 10000 + (item.IndexNumber || 0);
}

export function withoutStaleEpisodes(resumeItems, nextUpItems) {
  const nextBySeries = {};
  (nextUpItems || []).forEach(function (item) {
    if (item && item.SeriesId) nextBySeries[item.SeriesId] = item;
  });
  return (resumeItems || []).filter(function (item) {
    if (item.UserData && item.UserData.Played) return false;
    const next = item.SeriesId ? nextBySeries[item.SeriesId] : null;
    return !next || episodeOrder(item) >= episodeOrder(next);
  });
}
