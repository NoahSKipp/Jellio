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
