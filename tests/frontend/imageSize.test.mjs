import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketedImageWidth } from '../../src/Jellio/Frontend/runtime/imageSize.js';

test('poster cards ask for display width times pixel ratio, rounded up to a bucket', () => {
  assert.equal(bucketedImageWidth(180, 1), 240);
  assert.equal(bucketedImageWidth(180, 1.5), 320);
  assert.equal(bucketedImageWidth(180, 2), 400);
});

test('landscape cards stay within the largest bucket', () => {
  assert.equal(bucketedImageWidth(340, 1), 400);
  assert.equal(bucketedImageWidth(340, 2), 640);
});

test('pixel ratios are clamped to 1..2', () => {
  assert.equal(bucketedImageWidth(180, 3), 400);
  assert.equal(bucketedImageWidth(180, 0.5), 240);
  assert.equal(bucketedImageWidth(180, undefined), 240);
});
