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

export function createStreamWarmup(deps) {
  const prefetch = deps.prefetch;
  const canWarm = deps.canWarm;
  const wait = deps.wait;
  const queue = [];
  const done = new Set();
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (!canWarm()) break;
        const itemId = queue.shift();
        if (done.has(itemId)) continue;
        done.add(itemId);
        try {
          await prefetch(itemId);
        } catch (err) {}
        if (queue.length) await wait(WARMUP_GAP_MS);
      }
    } finally {
      running = false;
    }
  }

  return {
    add: function (itemIds, first) {
      itemIds.forEach(function (itemId) {
        if (!itemId || done.has(itemId) || queue.indexOf(itemId) !== -1) return;
        if (first) queue.unshift(itemId);
        else queue.push(itemId);
      });
      return run();
    },
    resume: run,
    pending: function () {
      return queue.slice();
    },
  };
}
