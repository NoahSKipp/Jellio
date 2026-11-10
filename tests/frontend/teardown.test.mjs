import { test } from 'node:test';
import assert from 'node:assert/strict';

const live = new Set();
globalThis.window = {
  setInterval: (fn, ms) => {
    const id = setInterval(fn, ms);
    live.add(id);
    return id;
  },
  clearInterval: (id) => {
    clearInterval(id);
    live.delete(id);
  },
  setTimeout: (fn, ms) => {
    const id = setTimeout(fn, ms);
    live.add(id);
    return id;
  },
  clearTimeout: (id) => {
    clearTimeout(id);
    live.delete(id);
  },
};

const { createScope } = await import('../../src/Jellio/Frontend/runtime/teardown.js');

function fakeTarget() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type, fn) => {
      if (handlers.get(type) === fn) handlers.delete(type);
    },
  };
}

test('dispose clears timers, listeners and observers, newest first', () => {
  const scope = createScope();
  const order = [];
  scope.onDispose(() => order.push('first'));
  scope.interval(() => {}, 1000);
  scope.timeout(() => {}, 1000);
  const target = fakeTarget();
  scope.listen(target, 'keydown', () => {});
  let disconnected = false;
  scope.observe({ disconnect: () => (disconnected = true) });
  scope.onDispose(() => order.push('last'));
  assert.equal(live.size, 2);
  scope.dispose();
  assert.equal(live.size, 0);
  assert.equal(target.handlers.size, 0);
  assert.equal(disconnected, true);
  assert.deepEqual(order, ['last', 'first']);
  assert.equal(scope.disposed, true);
});

test('dispose runs once, and later registrations are undone at once', () => {
  const scope = createScope();
  let runs = 0;
  scope.onDispose(() => runs++);
  scope.dispose();
  scope.dispose();
  assert.equal(runs, 1);
  const target = fakeTarget();
  scope.listen(target, 'click', () => {});
  scope.interval(() => {}, 1000);
  assert.equal(target.handlers.size, 0);
  assert.equal(live.size, 0);
});

test('a failing step does not stop the rest', () => {
  const scope = createScope();
  let ran = false;
  scope.onDispose(() => (ran = true));
  scope.onDispose(() => {
    throw new Error('boom');
  });
  const warn = console.warn;
  console.warn = () => {};
  scope.dispose();
  console.warn = warn;
  assert.equal(ran, true);
});
