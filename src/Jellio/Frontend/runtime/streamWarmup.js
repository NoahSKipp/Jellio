// Asks the server to find streams for titles the viewer is likely to play
// next, one at a time with a pause between, so the slow first lookup
// happens while they are still browsing.
const WARMABLE_TYPES = ['Movie', 'Episode', 'Series'];
export const WARMUP_GAP_MS = 1500;

// Not on a data saver or mobile connection, and only while the page is seen.
export function shouldWarmStreams(visibilityState, connection) {
  if (visibilityState !== 'visible') return false;
  if (!connection) return true;
  if (connection.saveData) return false;
  if (connection.type === 'cellular') return false;
  if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') return false;
  return true;
}

// Continue Watching and Next Up taken in turn, without repeats.
export function pickWarmupItems(lists, limit) {
  const picked = [];
  const seen = new Set();
  const queues = lists.map(function (list) {
    return (list || []).filter(function (item) {
      return item && item.Id && WARMABLE_TYPES.indexOf(item.Type) !== -1;
    });
  });
  let round = 0;
  while (picked.length < limit && queues.some(function (queue) { return round < queue.length; })) {
    queues.forEach(function (queue) {
      const item = queue[round];
      if (!item || picked.length >= limit || seen.has(item.Id)) return;
      seen.add(item.Id);
      picked.push(item.Id);
    });
    round++;
  }
  return picked;
}

// One warm-up request at a time across the app. Jobs carry a key, so the
// same work is never queued twice, and a group, so a search can drop what
// it queued once the query changes.
export function createStreamWarmup(deps) {
  const prefetch = deps.prefetch;
  const canWarm = deps.canWarm;
  const wait = deps.wait;
  const queue = [];
  const done = new Set();
  const knownWarm = new Set();
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (!canWarm()) break;
        const job = queue.shift();
        if (done.has(job.key)) continue;
        done.add(job.key);
        try {
          await job.run();
        } catch (err) {}
        if (queue.length) await wait(WARMUP_GAP_MS);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(job, first) {
    if (!job || !job.key || done.has(job.key)) return;
    if (queue.some(function (queued) { return queued.key === job.key; })) return;
    if (first) queue.unshift(job);
    else queue.push(job);
  }

  return {
    add: function (itemIds, first) {
      const ids = first ? itemIds.slice().reverse() : itemIds;
      ids.forEach(function (itemId) {
        if (!itemId || knownWarm.has(itemId)) return;
        enqueue({ key: 'item:' + itemId, run: function () { return prefetch(itemId); } }, first);
      });
      return run();
    },
    addJob: function (job, first) {
      enqueue(job, first);
      return run();
    },
    cancelGroup: function (group) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].group === group) queue.splice(i, 1);
      }
    },
    markWarm: function (itemIds) {
      (itemIds || []).forEach(function (itemId) {
        if (itemId) knownWarm.add(itemId);
      });
    },
    isKnownWarm: function (itemId) {
      return knownWarm.has(itemId);
    },
    resume: run,
    pending: function () {
      return queue.map(function (job) {
        return job.key.indexOf('item:') === 0 ? job.key.slice(5) : job.key;
      });
    },
  };
}

// Search: once results have stood still for settleMs, warm the top ones
// in one batch; a result keeping focus for focusMs is warmed on its own.
// A new query drops whatever the last one had pending.
export function createSearchWarmer(deps) {
  const schedule = deps.schedule;
  const cancel = deps.cancel;
  const settleMs = deps.settleMs || 600;
  const focusMs = deps.focusMs || 400;
  let settleTimer = null;
  let focusTimer = null;
  let generation = 0;

  function clearSettle() {
    if (settleTimer !== null) cancel(settleTimer);
    settleTimer = null;
  }
  function clearFocus() {
    if (focusTimer !== null) cancel(focusTimer);
    focusTimer = null;
  }

  return {
    query: function () {
      generation++;
      clearSettle();
      clearFocus();
      if (deps.onQueryChanged) deps.onQueryChanged();
    },
    results: function (items) {
      clearSettle();
      const mine = generation;
      settleTimer = schedule(function () {
        settleTimer = null;
        if (mine === generation) deps.onSettled(items);
      }, settleMs);
    },
    focus: function (itemId) {
      clearFocus();
      const mine = generation;
      focusTimer = schedule(function () {
        focusTimer = null;
        if (mine === generation) deps.onFocused(itemId);
      }, focusMs);
    },
    blur: clearFocus,
  };
}
