// The app's single warm-up queue: one request to the server at a time,
// none while the tab is hidden or the connection saves data.
import { prefetchStreams, prefetchStreamsBatch, getPlaybackInfo } from './api.js';
import { shouldWarmStreams, createStreamWarmup } from './streamWarmup.js';
import { alreadyWarmIds, normalizeId } from './readySources.js';

const queue = createStreamWarmup({
  prefetch: prefetchStreams,
  canWarm: function () {
    return shouldWarmStreams(document.hidden ? 'hidden' : document.visibilityState, navigator.connection || null);
  },
  wait: function (ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  },
});

document.addEventListener('visibilitychange', function () {
  if (!document.hidden) queue.resume();
});

// Stream list plus probe for one title, ahead of anything queued.
export function warmItem(itemId, first) {
  if (!itemId || queue.isKnownWarm(normalizeId(itemId))) return;
  queue.add([itemId], !!first);
}

export function warmItems(itemIds) {
  queue.add(itemIds.filter(function (itemId) {
    return !queue.isKnownWarm(normalizeId(itemId));
  }), false);
}

// Stream lists only, several titles in one call.
export function warmBatch(itemIds, group) {
  const ids = itemIds.filter(function (itemId) {
    return itemId && !queue.isKnownWarm(normalizeId(itemId));
  });
  if (!ids.length) return;
  queue.addJob({
    key: 'batch:' + ids.join(','),
    group: group,
    run: function () {
      return prefetchStreamsBatch(ids, false).then(function (response) {
        queue.markWarm(alreadyWarmIds(response));
      });
    },
  });
}

// The probe Play would run for one particular source, so picking it later
// starts fast.
export function warmSource(itemId, mediaSourceId) {
  if (!itemId || !mediaSourceId) return;
  queue.addJob({
    key: 'source:' + mediaSourceId,
    run: function () {
      return getPlaybackInfo(itemId, 0, mediaSourceId).catch(function () {});
    },
  });
}

export function cancelWarmGroup(group) {
  queue.cancelGroup(group);
}

export function isKnownWarm(itemId) {
  return queue.isKnownWarm(normalizeId(itemId));
}
