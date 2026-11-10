// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayStartTrace,
  buildPlayStartRecord,
  playStartClient,
  playStartTrigger,
  notePlayTrigger,
  takePlayTrigger,
  wantsAudioIndex,
  audioRematchNeeded,
} from '../../src/Jellio/Frontend/runtime/playStart.js';

function clock() {
  let at = 1000;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
}

test('marks are ms since the start, first mark wins', () => {
  const now = clock();
  const trace = createPlayStartTrace(now);
  now.advance(120);
  trace.mark('details');
  now.advance(80);
  trace.mark('playbackInfo');
  trace.mark('details');
  assert.equal(trace.get('details'), 120);
  assert.equal(trace.get('playbackInfo'), 200);
  assert.equal(trace.get('firstFrame'), null);
});

test('time held on the resume prompt is left out', () => {
  const now = clock();
  const trace = createPlayStartTrace(now);
  now.advance(300);
  trace.hold();
  now.advance(5000);
  trace.mark('firstByte');
  trace.release();
  now.advance(700);
  trace.mark('firstFrame');
  assert.equal(trace.get('firstByte'), 300);
  assert.equal(trace.get('firstFrame'), 1000);
});

test('the record has exactly the shape the server takes', () => {
  const now = clock();
  const trace = createPlayStartTrace(now);
  now.advance(50);
  trace.mark('details');
  now.advance(400);
  trace.mark('playbackInfo');
  trace.mark('playerReady');
  now.advance(250);
  trace.mark('firstByte');
  now.advance(900);
  trace.mark('firstFrame');
  const record = buildPlayStartRecord(
    { itemId: 'abc', mediaSourceId: 'src1', client: 'macos', trigger: 'detail', from: 'prefetched', warmAtPlay: true, directPlay: false },
    trace,
  );
  assert.deepEqual(record, {
    ItemId: 'abc',
    MediaSourceId: 'src1',
    Client: 'macos',
    Trigger: 'detail',
    From: 'prefetched',
    WarmAtPlay: true,
    DirectPlay: false,
    Stages: { DetailsMs: 50, PlaybackInfoMs: 450, PlayerReadyMs: 450, FirstByteMs: 700, FirstFrameMs: 1600 },
    TotalMs: 1600,
  });
});

test('unknown values fall back to safe ones', () => {
  const trace = createPlayStartTrace(clock());
  const record = buildPlayStartRecord({ itemId: 'x', client: 'tvos', trigger: 'button', from: 'magic', warmAtPlay: 'yes' }, trace);
  assert.equal(record.Client, 'web');
  assert.equal(record.Trigger, 'other');
  assert.equal(record.From, 'fresh');
  assert.equal(record.WarmAtPlay, null);
  assert.equal(record.DirectPlay, null);
  assert.equal(record.MediaSourceId, null);
  assert.equal(record.Stages.FirstFrameMs, null);
});

test('the macOS app is told apart by its native bridge', () => {
  assert.equal(playStartClient({ jellioNative: {} }), 'macos');
  assert.equal(playStartClient({}), 'web');
  assert.equal(playStartClient(undefined), 'web');
});

test('trigger: failover first, then what was noted, then resume', () => {
  assert.equal(playStartTrigger('detail', true, 0), 'failover');
  assert.equal(playStartTrigger('next-episode', false, 100), 'next-episode');
  assert.equal(playStartTrigger(null, false, 100), 'resume');
  assert.equal(playStartTrigger(null, false, 0), 'other');
});

test('a noted trigger is taken once, for that title, while fresh', () => {
  notePlayTrigger('a', 'detail', 0);
  assert.equal(takePlayTrigger('b', 10), null);
  notePlayTrigger('a', 'detail', 0);
  assert.equal(takePlayTrigger('a', 10), 'detail');
  assert.equal(takePlayTrigger('a', 20), null);
  notePlayTrigger('a', 'detail', 0);
  assert.equal(takePlayTrigger('a', 120000), null);
});

test('audio language: asked for up front, second request only on a miss', () => {
  assert.equal(wantsAudioIndex(2, 3), true);
  assert.equal(wantsAudioIndex(2, 1), false);
  assert.equal(wantsAudioIndex(null, 3), false);
  assert.equal(audioRematchNeeded(2, 3, 2), false);
  assert.equal(audioRematchNeeded(2, 3, null), true);
  assert.equal(audioRematchNeeded(2, 3, 1), true);
  assert.equal(audioRematchNeeded(null, 3, null), false);
});
