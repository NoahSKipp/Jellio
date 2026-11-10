import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../../src/Jellio/Frontend');

function collect(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'vendor' ? [] : collect(full);
    return entry.endsWith('.js') ? [full] : [];
  });
}

// Static imports and import('literal') both count: a lazily loaded module
// that imports its loader back is still a cycle.
const IMPORT = /(?:^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?|\bimport\(\s*)['"](\.{1,2}\/[^'"]+\.js)['"]/gm;

test('the frontend import graph has no cycles', () => {
  const graph = new Map();
  for (const file of collect(root)) {
    const deps = [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((m) => resolve(dirname(file), m[1]));
    graph.set(file, deps.filter((dep) => dep !== file));
  }
  const state = new Map();
  const cycles = [];
  function visit(node, path) {
    state.set(node, 'open');
    for (const dep of graph.get(node) || []) {
      if (state.get(dep) === 'open') cycles.push(path.slice(path.indexOf(dep)).concat(dep).map((f) => relative(root, f)).join(' -> '));
      else if (!state.has(dep)) visit(dep, path.concat(dep));
    }
    state.set(node, 'done');
  }
  for (const node of graph.keys()) if (!state.has(node)) visit(node, [node]);
  assert.deepEqual(cycles, []);
});
