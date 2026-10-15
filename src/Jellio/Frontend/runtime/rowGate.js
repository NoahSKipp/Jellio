// Catalog and genre rows load at most two at a time, top of the page
// first, until the recommendation rows are in, so those requests always
// find a free slot in runtime/api.js's limiter instead of queueing behind
// twenty row loads; then the gate opens.
export function createRowGate(width) {
  const waiting = [];
  let running = 0;
  let limit = width;
  function pump() {
    while (running < limit && waiting.length) {
      waiting.sort((a, b) => a.slot - b.slot);
      const next = waiting.shift();
      running++;
      next
        .run()
        .then(next.resolve, next.reject)
        .finally(function () {
          running--;
          pump();
        });
    }
  }
  const gate = function (slot, run) {
    return new Promise(function (resolve, reject) {
      waiting.push({ slot: slot, run: run, resolve: resolve, reject: reject });
      pump();
    });
  };
  gate.open = function () {
    limit = Infinity;
    pump();
  };
  return gate;
}
