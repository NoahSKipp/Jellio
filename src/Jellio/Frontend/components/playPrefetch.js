import { getMediaSources, getWarmSources, getQualityTiers, getPlaybackInfo, getCurrentUser, getAudioStreams, matchAudioStreamIndex, isPlaceholderSource } from '../runtime/api.js';
import { isBadSource } from '../runtime/streamHealth.js';
import { isPreferReadyEnabled, normalizeId } from '../runtime/readySources.js';
import { isOffline } from '../runtime/offline.js';
import { createDwellPrefetch, pickPlaySource, prefetchedPlayback, PREFETCH_DWELL_MS, PREFETCH_TTL_MS } from '../runtime/playbackPrefetch.js';
import { wantsAudioIndex } from '../runtime/playStart.js';
import { rememberedSourceId } from './streamPicker.js';

const PLAYABLE_TYPES = ['Movie', 'Episode', 'Video'];

// The audio track the player will ask for on this source, if any.
export function preferredAudioIndex(source, user) {
  const language = user && user.Configuration && user.Configuration.AudioLanguagePreference;
  if (!source || !language) return null;
  const matched = matchAudioStreamIndex(source, language);
  return wantsAudioIndex(matched, getAudioStreams(source).length) ? matched : null;
}

// Asks the server for the stream Play would start and keeps the answer for
// the player (screens/player.js) for a short while.
async function prefetchPlayTarget(target, stillHere) {
  if (!target || PLAYABLE_TYPES.indexOf(target.Type) === -1 || isOffline()) return;
  const results = await Promise.all([
    getMediaSources(target.Id),
    getWarmSources(target.Id),
    getQualityTiers(target.Id),
    getCurrentUser().catch(function () {
      return null;
    }),
  ]);
  if (!stillHere()) return;
  const warm = new Set(Object.keys(results[1] || {}).map(normalizeId));
  const tiers = {};
  Object.keys(results[2] || {}).forEach(function (id) {
    tiers[normalizeId(id)] = results[2][id];
  });
  const source = pickPlaySource(results[0], {
    rememberedId: rememberedSourceId(target.Id),
    isBad: function (s) {
      return isBadSource(target.Id, s);
    },
    preferReady: isPreferReadyEnabled(),
    isReady: function (s) {
      return warm.has(normalizeId(s.Id));
    },
    tierOf: function (s) {
      return tiers[normalizeId(s.Id)];
    },
  });
  if (!source || isPlaceholderSource(source)) return;
  const ticks = (target.UserData && target.UserData.PlaybackPositionTicks) || 0;
  const audioIndex = preferredAudioIndex(source, results[3]);
  const promise = getPlaybackInfo(target.Id, ticks, source.Id, audioIndex);
  promise.catch(function () {});
  if (!prefetchedPlayback.put(target.Id, source.Id, ticks, { promise: promise, audioIndex: audioIndex })) return;
  // Leaving for anything but this title's player drops the answer.
  function onLeave() {
    window.removeEventListener('hashchange', onLeave);
    const hash = window.location.hash || '';
    if (hash.indexOf('#/play?') !== 0 || hash.indexOf('id=' + target.Id) === -1) prefetchedPlayback.drop(target.Id);
  }
  window.addEventListener('hashchange', onLeave);
  window.setTimeout(function () {
    window.removeEventListener('hashchange', onLeave);
  }, PREFETCH_TTL_MS);
}

// Resting on Play (hover or focus) for about a second prefetches the
// stream; once per title per 45 s. resolveTarget gives the item to play.
export function attachPlayPrefetch(button, key, resolveTarget) {
  const openedHash = window.location.hash;
  function stillHere() {
    return window.location.hash === openedHash;
  }
  const dwell = createDwellPrefetch({
    delayMs: PREFETCH_DWELL_MS,
    windowMs: PREFETCH_TTL_MS,
    now: function () {
      return Date.now();
    },
    schedule: function (fn, ms) {
      return window.setTimeout(fn, ms);
    },
    cancel: function (id) {
      window.clearTimeout(id);
    },
    run: function () {
      if (!stillHere()) return;
      Promise.resolve(resolveTarget())
        .then(function (target) {
          if (stillHere()) return prefetchPlayTarget(target, stillHere);
          return undefined;
        })
        .catch(function () {});
    },
  });
  function start() {
    dwell.start(key);
  }
  ['mouseenter', 'focus'].forEach(function (type) {
    button.addEventListener(type, start);
  });
  ['mouseleave', 'blur'].forEach(function (type) {
    button.addEventListener(type, dwell.stop);
  });
  // Play opens the stream picker: no need to wait out the rest.
  button.addEventListener('click', function () {
    dwell.runNow(key);
  });
  window.addEventListener('hashchange', function stop() {
    window.removeEventListener('hashchange', stop);
    dwell.stop();
  });
}
