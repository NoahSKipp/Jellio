import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function collectJsFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const frontendDir = join(import.meta.dirname, '../../src/Jellio/Frontend');
const jsFiles = collectJsFiles(frontendDir);

test('all frontend JavaScript files have valid syntax with zero parser errors', () => {
  // Checked as .mjs: on a plain .js path, Node 22's module detection lets a
  // module with a syntax error pass --check without complaint.
  const scratch = mkdtempSync(join(tmpdir(), 'jellio-syntax-'));
  for (const file of jsFiles) {
    const copy = join(scratch, basename(file, '.js') + '-' + jsFiles.indexOf(file) + '.mjs');
    copyFileSync(file, copy);
    try {
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch (err) {
      assert.fail('Syntax error in ' + file + ':\n' + (err.stderr || err.message));
    }
  }
});

test('all static imports resolve to existing exports in target modules', () => {
  const exportMap = new Map();
  const nonVendorFiles = jsFiles.filter((f) => !f.includes(join('Frontend', 'vendor')));

  for (const file of nonVendorFiles) {
    const code = readFileSync(file, 'utf8');
    const exports = new Set();

    const fnMatches = code.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/g);
    for (const m of fnMatches) exports.add(m[1]);

    const varMatches = code.matchAll(/export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/g);
    for (const m of varMatches) exports.add(m[1]);

    const classMatches = code.matchAll(/export\s+class\s+([a-zA-Z0-9_$]+)/g);
    for (const m of classMatches) exports.add(m[1]);

    const blockMatches = code.matchAll(/export\s*\{([^}]+)\}/g);
    for (const m of blockMatches) {
      const names = m[1].split(',');
      for (const name of names) {
        const parts = name.trim().split(/\s+as\s+/);
        const exportedName = parts[parts.length - 1].trim();
        if (exportedName) exports.add(exportedName);
      }
    }

    if (/export\s+default\s+/.test(code)) exports.add('default');
    exportMap.set(resolve(file), exports);
  }

  const errors = [];
  for (const file of nonVendorFiles) {
    const code = readFileSync(file, 'utf8');
    const importMatches = code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g);
    for (const m of importMatches) {
      const rawNames = m[1];
      const importPath = m[2];
      if (!importPath.startsWith('.')) continue;
      const targetPath = resolve(dirname(file), importPath);
      const targetExports = exportMap.get(targetPath);
      if (!targetExports) {
        errors.push(basename(file) + ': Cannot resolve target ' + importPath);
        continue;
      }
      const names = rawNames.split(',');
      for (const name of names) {
        const parts = name.trim().split(/\s+as\s+/);
        const importedName = parts[0].trim();
        if (importedName && !targetExports.has(importedName)) {
          errors.push(basename(file) + ': Module ' + basename(targetPath) + ' does not export "' + importedName + '"');
        }
      }
    }
  }

  assert.equal(errors.length, 0, 'Broken static imports found:\n' + errors.join('\n'));
});
