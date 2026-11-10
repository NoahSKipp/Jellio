import { getDisplayCulture } from '../i18n.js';
import { getCurrentUserId, getServerAddress, getAuthHeaders } from '../auth.js';
import { isUnreleasedItem } from '../releaseDate.js';
import { invalidateCache, invalidateUserDataRows, postJson } from './core.js';
import { getItem, getSeriesEpisodes } from './items.js';

export async function setPlayed(itemId, isPlayed) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const response = await fetch(
    getServerAddress() + '/Users/' + userId + '/PlayedItems/' + itemId,
    {
      method: isPlayed ? 'POST' : 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: PlayedItems');
    err.status = response.status;
    throw err;
  }
  invalidateUserDataRows();
  return response.json();
}

const KNOWN_ANTHOLOGIES = [
  'black mirror',
  'love, death & robots',
  'love death and robots',
  'love death & robots',
  'love death + robots',
  'twilight zone',
  'cabinet of curiosities',
  'electric dreams',
  'room 104',
  'star wars: visions',
  'star wars visions',
  'inside no. 9',
  'inside no 9',
  'modern love',
  'oats studios',
  'tales from the crypt',
  'tales from the loop',
  'american horror stories',
];

export function isEpisodicAnthology(series) {
  if (!series) return false;
  const genres = series.Genres || [];
  if (genres.some(function (g) { return g && g.toLowerCase().includes('anthology'); })) return true;
  const tags = series.Tags || [];
  if (tags.some(function (t) { return t && t.toLowerCase().includes('anthology'); })) return true;
  const name = (series.Name || '').toLowerCase();
  return KNOWN_ANTHOLOGIES.some(function (title) { return name.includes(title); });
}

export async function autoCompletePreviousEpisodesIfSkipped(episode) {
  if (!episode || episode.Type !== 'Episode') return;
  const seriesId = episode.SeriesId;
  const currentSeasonNum = episode.ParentIndexNumber;
  const currentEpNum = episode.IndexNumber;
  if (!seriesId || currentSeasonNum == null || currentEpNum == null || currentSeasonNum <= 0) {
    return;
  }

  let series = null;
  try {
    series = await getItem(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load series metadata for anthology check', err);
  }

  if (isEpisodicAnthology(series)) {
    console.log('Jellio: Skipping auto-complete for anthology series:', series && series.Name);
    return;
  }

  try {
    const userId = getCurrentUserId();
    if (!userId) return;
    const allEpisodes = await getSeriesEpisodes(seriesId);
    const toMark = (allEpisodes || []).filter(function (ep) {
      if (!ep || !ep.Id || isUnreleasedItem(ep)) return false;
      if (typeof ep.IndexNumber !== 'number') return false;
      const sNum = ep.ParentIndexNumber || 0;
      const eNum = ep.IndexNumber;
      if (sNum <= 0) return false;
      const isBefore = sNum < currentSeasonNum || (sNum === currentSeasonNum && eNum < currentEpNum);
      const isUnfinished = !(ep.UserData && ep.UserData.Played) || (ep.UserData && ep.UserData.PlaybackPositionTicks > 0);
      return isBefore && isUnfinished;
    });

    if (toMark.length > 0) {
      console.info('Jellio: Auto-completing ' + toMark.length + ' previous skipped episodes for series', (series && series.Name) || seriesId);
      const culture = getDisplayCulture();
      for (let i = 0; i < toMark.length; i++) {
        const prevEp = toMark[i];
        try {
          await fetch(
            getServerAddress() + '/Users/' + userId + '/PlayedItems/' + prevEp.Id,
            {
              method: 'POST',
              headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
            },
          );
          invalidateCache('item:' + prevEp.Id);
          if (culture) invalidateCache('item:' + prevEp.Id + ':' + culture);
        } catch (err) {
          console.warn('Jellio: failed to mark previous episode played', prevEp.Id, err);
        }
      }
      invalidateUserDataRows();
    }
  } catch (err) {
    console.warn('Jellio: could not auto-complete previous episodes', err);
  }
}

export async function setItemRating(itemId, likes) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const path = '/Users/' + userId + '/Items/' + itemId + '/Rating' + (likes == null ? '' : '?likes=' + likes);
  const response = await fetch(getServerAddress() + path, {
    method: likes == null ? 'DELETE' : 'POST',
    headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
  });
  if (!response.ok) {
    const err = new Error('Request failed: Rating');
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export function creditRealWatch(itemId) {
  return postJson('/Jellio/achievements/real-watch', { ItemId: itemId }).then(function (result) {
    invalidateUserDataRows();
    return result;
  });
}

export function probeRealDuration(itemId) {
  return postJson('/Jellio/real-duration/probe', { ItemId: itemId }, 40000).then(function (answer) {
    return (answer && answer.DurationTicks) || null;
  });
}

// exact: the length itself; otherwise only a lower bound on it.
export function reportRealDuration(itemId, durationTicks, exact) {
  return postJson('/Jellio/real-duration', { ItemId: itemId, DurationTicks: Math.round(durationTicks), Exact: !!exact }).then(function (result) {
    invalidateUserDataRows();
    return result;
  });
}
