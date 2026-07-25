const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { catalogFolder } = require('../system/ingest/file-catalog.js');

test('catalogs files, skips excluded dirs and AppleDouble files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'a.pdf'), 'x');
  fs.writeFileSync(path.join(tmp, 'sub', 'b.mov'), 'x');
  fs.writeFileSync(path.join(tmp, '._junk'), 'x');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'c.js'), 'x');
  const entries = catalogFolder(tmp, 'test-root', 'personal', {
    excludeDirs: ['node_modules'], excludeFiles: ['^\\._', '^\\.DS_Store$'] });
  const rels = entries.map(e => e.relPath).sort();
  assert.deepStrictEqual(rels, ['a.pdf', 'sub/b.mov']);
  assert.strictEqual(entries[0].root, 'test-root');
  assert.strictEqual(entries[0].department, 'personal');
  assert.ok(entries.every(e => typeof e.size === 'number' && e.mtime));
});
