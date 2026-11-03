// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasNoAudio, looksLikeSilentSlideshow, stoppedTooEarly } from '../../src/Jellio/Frontend/runtime/streamHealth.js';

const movie = 110 * 60;

test('a 1 fps silent clip on a long title is the placeholder', () => {
  assert.equal(looksLikeSilentSlideshow(6, 6, true, movie), true);
  assert.equal(looksLikeSilentSlideshow(12, 6, true, movie), true);
});

test('real video, audio, unknown audio or short titles are left alone', () => {
  assert.equal(looksLikeSilentSlideshow(144, 6, true, movie), false);
  assert.equal(looksLikeSilentSlideshow(6, 6, false, movie), false);
  assert.equal(looksLikeSilentSlideshow(6, 6, null, movie), false);
  assert.equal(looksLikeSilentSlideshow(6, 6, true, 8 * 60), false);
  assert.equal(looksLikeSilentSlideshow(6, 6, true, 0), false);
});

test('too short a sample decides nothing', () => {
  assert.equal(looksLikeSilentSlideshow(1, 1.5, true, movie), false);
  assert.equal(looksLikeSilentSlideshow(NaN, 6, true, movie), false);
});

test('audio detection uses whatever the browser offers', () => {
  assert.equal(hasNoAudio({ audioTracks: { length: 0 } }), true);
  assert.equal(hasNoAudio({ audioTracks: { length: 2 } }), false);
  assert.equal(hasNoAudio({ mozHasAudio: false }), true);
  assert.equal(hasNoAudio({ webkitAudioDecodedByteCount: 0 }), true);
  assert.equal(hasNoAudio({ webkitAudioDecodedByteCount: 52000 }), false);
  assert.equal(hasNoAudio({}), null);
  assert.equal(hasNoAudio(null), null);
});

test('stopping in the first quarter of a long title', () => {
  assert.equal(stoppedTooEarly(120, movie), true);
  assert.equal(stoppedTooEarly(movie * 0.3, movie), false);
  assert.equal(stoppedTooEarly(60, 8 * 60), false);
  assert.equal(stoppedTooEarly(NaN, movie), false);
});
