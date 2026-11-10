import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeExternalUrl, cssUrl } from '../../src/Jellio/Frontend/runtime/safeUrl.js';

test('safeExternalUrl keeps http and https links', () => {
  assert.equal(safeExternalUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(safeExternalUrl(' http://example.com/a '), 'http://example.com/a');
});

test('safeExternalUrl drops script and other schemes', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('  JavaScript:alert(1)'), '');
  assert.equal(safeExternalUrl('java\tscript:alert(1)'), '');
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeExternalUrl('vbscript:msgbox'), '');
  assert.equal(safeExternalUrl('/relative/path'), '');
  assert.equal(safeExternalUrl(''), '');
  assert.equal(safeExternalUrl(null), '');
  assert.equal(safeExternalUrl({}), '');
});

test('cssUrl quotes and escapes the value', () => {
  assert.equal(cssUrl('/Items/1/Images/Primary?maxWidth=300'), 'url("/Items/1/Images/Primary?maxWidth=300")');
  assert.equal(cssUrl('a") ; background:red; ("'), 'url("a\\") ; background:red; (\\"")');
  assert.equal(cssUrl('a\\b'), 'url("a\\\\b")');
  assert.equal(cssUrl('a\nb'), 'url("a\\a b")');
  assert.equal(cssUrl("it's (1).jpg"), 'url("it\'s (1).jpg")');
});
