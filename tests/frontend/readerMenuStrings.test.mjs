import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every web language translates the reader menu strings', () => {
  const dir = new URL('../../src/Jellio/Frontend/runtime/', import.meta.url);
  const keysIn = (file) => new Set([...readFileSync(new URL(file, dir), 'utf8').matchAll(/^\s*(reader_\w+):/gm)].map((m) => m[1]));
  const english = keysIn('i18n.js');
  assert.ok(english.has('reader_menu_mark_read') && english.has('reader_menu_remove_continue_listening'));
  for (const lang of ['de', 'es', 'fr', 'it', 'pl', 'pt']) {
    const found = keysIn('strings-' + lang + '.js');
    assert.deepEqual([...english].filter((key) => !found.has(key)), [], lang);
  }
});
