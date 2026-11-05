// Release date detection and badge label formatting for episodes and items.

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const SENTINEL_YEAR = 9000;

export function isUnreleasedItem(item, nowMs) {
  if (!item || typeof item !== 'object') return false;
  if (item.UserData && (item.UserData.Played || item.UserData.PlaybackPositionTicks > 0)) {
    return false;
  }

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowDate = new Date(now);
  const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

  if (item.PremiereDate) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime())) {
      if (d.getUTCFullYear() >= SENTINEL_YEAR) return true;
      const premiereDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return premiereDay > today;
    }
  }

  if (item.EndDate) {
    const endD = new Date(item.EndDate);
    if (!isNaN(endD.getTime())) {
      if (endD.getUTCFullYear() >= SENTINEL_YEAR) return true;
      const endDay = Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth(), endD.getUTCDate());
      if (endDay > today) return true;
    }
  }

  if (item.LocationType === 'Virtual' && !item.RunTimeTicks) {
    return true;
  }

  return false;
}

export function episodeReleaseLabel(item, nowMs) {
  if (!isUnreleasedItem(item, nowMs)) return '';

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (item.PremiereDate) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime()) && d.getUTCFullYear() < SENTINEL_YEAR) {
      const nowDate = new Date(now);
      const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
      const premiereDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const diffDays = Math.round((premiereDay - today) / MS_PER_DAY);
      if (diffDays <= 0) return 'Today';
      if (diffDays === 1) return 'Tomorrow';
      if (diffDays < 7) return 'In ' + diffDays + ' days';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  }

  return 'Coming soon';
}

export function filterReleasedItems(items, nowMs) {
  return (items || []).filter(function (item) {
    return !isUnreleasedItem(item, nowMs);
  });
}

export function seasonEpisodeReleaseLabels(episodes, nowMs) {
  const result = {};
  if (!Array.isArray(episodes)) return result;

  let seenUnreleased = false;
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (!ep) continue;
    let label = episodeReleaseLabel(ep, nowMs);
    if (label) {
      seenUnreleased = true;
    } else if (seenUnreleased) {
      const isPlayed = !!(ep.UserData && (ep.UserData.Played || ep.UserData.PlaybackPositionTicks > 0));
      if (!ep.PremiereDate && !isPlayed && !ep.RunTimeTicks) {
        label = 'Coming soon';
      }
    }
    if (label) {
      if (ep.Id != null) {
        result[ep.Id] = label;
      }
      result[i] = label;
    }
  }
  return result;
}
