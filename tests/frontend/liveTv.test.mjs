import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapChannels,
  filterChannels,
  arrangeChannels,
  guideWindow,
  nowAndNext,
  neighbourChannel,
  createLiveLifecycle,
  describeOpenFailure,
} from '../../src/Jellio/Frontend/runtime/liveTv.js';

const NOW = Date.parse('2026-10-27T20:00:00Z');
const iso = (offsetMin) => new Date(NOW + offsetMin * 60000).toISOString();

test('maps channels with the programme on now and its progress', () => {
  const [c] = mapChannels([
    {
      Id: 'dlhd.1',
      Name: 'Sky Sports F1',
      ChannelNumber: '7',
      ImageTags: { Primary: 'tag' },
      UserData: { IsFavorite: true },
      CurrentProgram: { Name: 'Qualifying', StartDate: iso(-30), EndDate: iso(30) },
    },
  ], NOW);
  assert.equal(c.id, 'dlhd.1');
  assert.equal(c.favorite, true);
  assert.equal(c.imageTag, 'tag');
  assert.equal(c.now.name, 'Qualifying');
  assert.equal(c.now.progress, 0.5);
});

test('a programme already over is not shown as on now; channels without ids are dropped', () => {
  const list = mapChannels([
    { Id: 'a', Name: 'A', CurrentProgram: { Name: 'Old', StartDate: iso(-90), EndDate: iso(-10) } },
    { Name: 'no id' },
  ], NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].now, null);
});

test('search matches every word in the name or the programme, ignoring accents and case', () => {
  const list = mapChannels([
    { Id: 'a', Name: 'ESPN Deportes', CurrentProgram: { Name: 'Fútbol', StartDate: iso(-1), EndDate: iso(60) } },
    { Id: 'b', Name: 'Sky Sports', CurrentProgram: { Name: 'Cricket', StartDate: iso(-1), EndDate: iso(60) } },
  ], NOW);
  assert.deepEqual(filterChannels(list, 'espn futbol').map((c) => c.id), ['a']);
  assert.deepEqual(filterChannels(list, '  ').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(filterChannels(list, 'tennis'), []);
});

test('favourites come first, then channels with something on, then the rest', () => {
  const list = mapChannels([
    { Id: 'idle', Name: 'A Idle' },
    { Id: 'live', Name: 'Z Live', CurrentProgram: { Name: 'x', StartDate: iso(-1), EndDate: iso(5) } },
    { Id: 'fav', Name: 'M Fav', UserData: { IsFavorite: true } },
  ], NOW);
  const { favorites, others } = arrangeChannels(list);
  assert.deepEqual(favorites.map((c) => c.id), ['fav']);
  assert.deepEqual(others.map((c) => c.id), ['live', 'idle']);
});

test('the guide keeps the next 24 hours in start order and marks what airs now', () => {
  const programs = [
    { Id: 'later', Name: 'Later', StartDate: iso(120), EndDate: iso(180) },
    { Id: 'past', Name: 'Past', StartDate: iso(-120), EndDate: iso(-60) },
    { Id: 'now', Name: 'Now', StartDate: iso(-10), EndDate: iso(50) },
    { Id: 'tomorrow', Name: 'Too late', StartDate: iso(25 * 60), EndDate: iso(26 * 60) },
  ];
  const window = guideWindow(programs, NOW, 24);
  assert.deepEqual(window.map((p) => p.id), ['now', 'later']);
  assert.equal(window[0].airing, true);
  const { now, next } = nowAndNext(programs, NOW);
  assert.equal(now.id, 'now');
  assert.equal(next.id, 'later');
});

test('channel up and down wrap around the list as shown', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(neighbourChannel(list, 'a', -1).id, 'c');
  assert.equal(neighbourChannel(list, 'c', 1).id, 'a');
  assert.equal(neighbourChannel(list, 'b', 1).id, 'c');
  assert.equal(neighbourChannel(list, 'missing', 1).id, 'a');
  assert.equal(neighbourChannel([], 'a', 1), null);
});

test('opening a channel closes the previous stream and stop closes the open one once', async () => {
  const closed = [];
  let n = 0;
  const life = createLiveLifecycle(async (id) => ({ liveStreamId: id + '-' + ++n }), async (id) => closed.push(id));
  await life.start('a');
  await life.start('b');
  assert.deepEqual(closed, ['a-1']);
  await life.stop();
  await life.stop();
  assert.deepEqual(closed, ['a-1', 'b-2']);
  assert.equal(life.current(), null);
});

test('a stream that finishes opening after leaving is closed straight away', async () => {
  const closed = [];
  let release;
  const life = createLiveLifecycle(
    () => new Promise((resolve) => { release = () => resolve({ liveStreamId: 'late' }); }),
    async (id) => closed.push(id),
  );
  const opening = life.start('a');
  await new Promise((r) => setTimeout(r, 0));
  await life.stop();
  release();
  assert.equal(await opening, null);
  assert.deepEqual(closed, ['late']);
});

test('a busy tuner gets its own message', () => {
  assert.match(describeOpenFailure(new Error('No available tuner')), /tuners are busy/);
  assert.match(describeOpenFailure({ message: 'Request timed out' }), /too long/);
  assert.match(describeOpenFailure(null), /could not be started/);
});
