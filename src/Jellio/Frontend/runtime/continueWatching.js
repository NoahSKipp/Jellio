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
