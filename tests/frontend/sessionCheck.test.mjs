import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthEndpoint,
  shouldConfirmUnauthorized,
  classifyProbe,
  createSessionGuard,
  RECHECK_INTERVAL_MS,
} from '../../src/Jellio/Frontend/runtime/sessionCheck.js';

const SERVER = 'https://media.example.com';

test('auth endpoints are never treated as session loss', () => {
  assert.equal(isAuthEndpoint('/Users/AuthenticateByName'), true);
  assert.equal(isAuthEndpoint('/Users/AuthenticateWithQuickConnect'), true);
  assert.equal(isAuthEndpoint('/Users/ForgotPassword'), true);
  assert.equal(isAuthEndpoint('/Users/ForgotPassword/Pin'), true);
  assert.equal(isAuthEndpoint('/QuickConnect/Authorize?code=1'), true);
  assert.equal(isAuthEndpoint('/Users/abc/Items'), false);
  assert.equal(isAuthEndpoint('/Jellio/vocab'), false);
});

test('only 401s from the own server outside auth endpoints are confirmed', () => {
  assert.equal(shouldConfirmUnauthorized(SERVER + '/Users/abc/Items', '/Users/abc/Items', SERVER), true);
  assert.equal(shouldConfirmUnauthorized(SERVER + '/Users/AuthenticateByName', '/Users/AuthenticateByName', SERVER), false);
  assert.equal(shouldConfirmUnauthorized('https://other.example.com/x', '/x', SERVER), false);
  assert.equal(shouldConfirmUnauthorized('https://media.example.com.evil.net/x', '/x', SERVER), false);
  assert.equal(shouldConfirmUnauthorized(SERVER + '/QuickConnect/Initiate', undefined, SERVER), false);
});

test('classifyProbe only reports expired on a 401', () => {
  assert.equal(classifyProbe(401), 'expired');
  assert.equal(classifyProbe(200), 'valid');
  assert.equal(classifyProbe(204), 'valid');
  assert.equal(classifyProbe(403), 'unknown');
  assert.equal(classifyProbe(500), 'unknown');
  assert.equal(classifyProbe(503), 'unknown');
  assert.equal(classifyProbe(0), 'unknown');
  assert.equal(classifyProbe(new TypeError('Failed to fetch')), 'unknown');
});

function makeGuard(statuses, clock) {
  const calls = [];
  const expired = [];
  const guard = createSessionGuard({
    probe: (token) => {
      calls.push(token);
      const next = statuses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    onExpired: (token) => expired.push(token),
    now: () => clock.t,
  });
  return { guard, calls, expired };
}

test('a 401 that the probe does not confirm keeps the session', async () => {
  const clock = { t: 0 };
  const { guard, calls, expired } = makeGuard([200], clock);
  assert.equal(await guard.report('tok'), 'valid');
  assert.equal(calls.length, 1);
  assert.deepEqual(expired, []);
});

test('a confirmed 401 expires the session once', async () => {
  const clock = { t: 0 };
  const { guard, expired } = makeGuard([401], clock);
  assert.equal(await guard.report('tok'), 'expired');
  assert.deepEqual(expired, ['tok']);
  assert.equal(await guard.report('tok'), 'expired');
  assert.deepEqual(expired, ['tok']);
});

test('parallel 401s share one check', async () => {
  const clock = { t: 0 };
  const { guard, calls, expired } = makeGuard([401], clock);
  const results = await Promise.all([guard.report('tok'), guard.report('tok'), guard.report('tok')]);
  assert.deepEqual(results, ['expired', 'expired', 'expired']);
  assert.equal(calls.length, 1);
  assert.equal(expired.length, 1);
});

test('network errors, timeouts, 403 and 5xx never expire the session', async () => {
  const clock = { t: 0 };
  const { guard, expired } = makeGuard([new TypeError('Failed to fetch'), 403, 502, 0], clock);
  for (let i = 0; i < 4; i++) {
    assert.equal(await guard.report('tok'), 'unknown');
    clock.t += RECHECK_INTERVAL_MS;
  }
  assert.deepEqual(expired, []);
});

test('a token is rechecked at most once per interval', async () => {
  const clock = { t: 0 };
  const { guard, calls, expired } = makeGuard([200, 401], clock);
  await guard.report('tok');
  clock.t += RECHECK_INTERVAL_MS - 1;
  assert.equal(await guard.report('tok'), 'valid');
  assert.equal(calls.length, 1);
  clock.t += 1;
  assert.equal(await guard.report('tok'), 'expired');
  assert.equal(calls.length, 2);
  assert.deepEqual(expired, ['tok']);
});

test('a new token is checked on its own schedule', async () => {
  const clock = { t: 0 };
  const { guard, calls } = makeGuard([200, 200], clock);
  await guard.report('old');
  await guard.report('new');
  assert.deepEqual(calls, ['old', 'new']);
});

test('no token means nothing to check', async () => {
  const clock = { t: 0 };
  const { guard, calls } = makeGuard([], clock);
  assert.equal(await guard.report(null), 'unknown');
  assert.equal(calls.length, 0);
});
