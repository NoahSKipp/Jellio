// Release date detection and badge label formatting for episodes and items.
import { t } from './i18n.js';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const SENTINEL_YEAR = 9000;

const verifiedTodayStreamIds = new Set();

export function markTodayItemHasStream(itemId, hasStream) {
  if (!itemId) return;
  const key = String(itemId);
  if (hasStream) verifiedTodayStreamIds.add(key);
  else verifiedTodayStreamIds.delete(key);
}

export function isTodayItemStreamVerified(itemId) {
  return !!itemId && verifiedTodayStreamIds.has(String(itemId));
}

export function clearVerifiedTodayStreamIds() {
  verifiedTodayStreamIds.clear();
}

export function isReleasedToday(item, nowMs) {
  if (!item || typeof item !== 'object') return false;
  if (item.UserData && (item.UserData.Played || item.UserData.PlaybackPositionTicks > 0)) {
    return false;
  }

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowDate = new Date(now);
  const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

  let dateObj = null;
  if (item.PremiereDate) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime())) dateObj = d;
  }
  if (!dateObj && item.EndDate) {
    const endD = new Date(item.EndDate);
    if (!isNaN(endD.getTime())) dateObj = endD;
  }

  if (dateObj && dateObj.getUTCFullYear() < SENTINEL_YEAR) {
    const premiereDay = Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate());
    return premiereDay === today;
  }

  return false;
}

export function isUnreleasedItem(item, nowMs) {
  if (!item || typeof item !== 'object') return false;
  if (item.UserData && (item.UserData.Played || item.UserData.PlaybackPositionTicks > 0)) {
    return false;
  }

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowDate = new Date(now);
  const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

  let dateObj = null;
  if (item.PremiereDate) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime())) {
      dateObj = d;
    }
  }
  if (!dateObj && item.EndDate) {
    const endD = new Date(item.EndDate);
    if (!isNaN(endD.getTime())) {
      dateObj = endD;
    }
  }

  if (dateObj) {
    if (dateObj.getUTCFullYear() >= SENTINEL_YEAR) return true;
    const itemDay = Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate());
    if (itemDay > today) return true;
    if (itemDay === today) {
      if (dateObj.getTime() > now) return true;
      if (!item.Type || item.Type === 'Episode') {
        return !isTodayItemStreamVerified(item.Id);
      }
    }
    return false;
  }

  if (item.LocationType === 'Virtual' && !item.RunTimeTicks) {
    return true;
  }

  return false;
}

export function episodeReleaseLabel(item, nowMs) {
  if (!isUnreleasedItem(item, nowMs)) return '';

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  let dateObj = null;
  if (item.PremiereDate) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime())) dateObj = d;
  }
  if (!dateObj && item.EndDate) {
    const endD = new Date(item.EndDate);
    if (!isNaN(endD.getTime())) dateObj = endD;
  }

  if (dateObj && dateObj.getUTCFullYear() < SENTINEL_YEAR) {
    const nowDate = new Date(now);
    const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
    const premiereDay = Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate());
    const diffDays = Math.round((premiereDay - today) / MS_PER_DAY);
    if (diffDays === 0) {
      return t('calendar_today', null, 'Today');
    }
    if (diffDays === 1) return t('release_tomorrow', null, 'Tomorrow');
    if (diffDays > 1 && diffDays < 7) return t('release_in_days', { count: diffDays }, 'In {count} days');
    if (diffDays >= 7) {
      return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  }

  return t('release_coming_soon', null, 'Coming soon');
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
        label = t('release_coming_soon', null, 'Coming soon');
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
