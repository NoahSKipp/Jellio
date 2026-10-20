import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemInfoPath, itemFallbackPath, loadItemInfo, watchSources } from '../../src/Jellio/Frontend/runtime/itemInfo.js';

const noStreamFields = (path) => !/MediaSources|MediaStreams/.test(path);

test('no info request asks for MediaSources or MediaStreams', () => {
  for (const playback of [false, true]) {
    assert.ok(noStreamFields(itemInfoPath('u1', 'i1', playback)));
    assert.ok(noStreamFields(itemFallbackPath('u1', 'i1', playback)));
  }
  assert.match(itemInfoPath('u1', 'i1', false), /^\/Items\?userId=u1&ids=i1&Fields=Overview/);
  assert.match(itemInfoPath('u1', 'i1', true), /Trickplay%2CChapters/);
});

test('the detail info comes from /Items?ids= alone', async () => {
  const asked = [];
  const getJson = async (path) => {
    asked.push(path);
    return { Items: [{ Id: 'i1', Name: 'Pilot', Overview: 'It begins.' }] };
  };
  const item = await loadItemInfo(getJson, 'u1', 'i1');
  assert.equal(item.Overview, 'It begins.');
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith('/Items?'));
  assert.ok(asked.every(noStreamFields));
});

test('a title not imported yet falls back to the by-id request, still without streams', async () => {
  const asked = [];
  const getJson = async (path) => {
    asked.push(path);
    return path.startsWith('/Items?') ? { Items: [] } : { Id: 'i1', Name: 'New' };
  };
  const item = await loadItemInfo(getJson, 'u1', 'i1');
  assert.equal(item.Name, 'New');
  assert.deepEqual(asked.map((p) => p.split('?')[0]), ['/Items', '/Users/u1/Items/i1']);
  assert.ok(asked.every(noStreamFields));
});

test('a title that rejects on /Items?ids= (e.g. synthetic non-GUID search result) falls back to by-id request', async () => {
  const asked = [];
  const getJson = async (path) => {
    asked.push(path);
    if (path.startsWith('/Items?')) {
      const err = new Error('Request failed: ' + path);
      err.status = 400;
      throw err;
    }
    return { Id: 'tt1234567', Name: 'Remote Title' };
  };
  const item = await loadItemInfo(getJson, 'u1', 'tt1234567');
  assert.equal(item.Name, 'Remote Title');
  assert.deepEqual(asked.map((p) => p.split('?')[0]), ['/Items', '/Users/u1/Items/tt1234567']);
  assert.ok(asked.every(noStreamFields));
});

test('fallback returning an Items array unpacks the item properly', async () => {
  const getJson = async (path) => {
    if (path.startsWith('/Items?')) throw new Error('400');
    return { Items: [{ Id: 'i1', Name: 'Wrapped' }] };
  };
  const item = await loadItemInfo(getJson, 'u1', 'i1');
  assert.equal(item.Name, 'Wrapped');
});

test('the page has its info while streams are still being found, and they fill in later', async () => {
  let release;
  const sourcesPending = new Promise((resolve) => (release = resolve));
  const states = [];
  const info = await loadItemInfo(async () => ({ Items: [{ Id: 'i1', Name: 'Pilot' }] }), 'u1', 'i1');
  const watch = watchSources(() => sourcesPending, (s) => states.push(s.state));
  assert.equal(info.Name, 'Pilot');
  assert.deepEqual(states, ['finding']);
  assert.equal(watch.isDone(), false);
  release([{ Id: 's1' }, { Id: 's2' }]);
  const sources = await watch.promise;
  assert.equal(sources.length, 2);
  assert.deepEqual(states, ['finding', 'ready']);
});

test('no streams and a failed lookup are reported, not thrown', async () => {
  const empty = [];
  await watchSources(async () => [], (s) => empty.push(s.state)).promise;
  assert.deepEqual(empty, ['finding', 'empty']);
  const failed = [];
  await watchSources(async () => { throw new Error('timeout'); }, (s) => failed.push(s.state)).promise;
  assert.deepEqual(failed, ['finding', 'failed']);
});
