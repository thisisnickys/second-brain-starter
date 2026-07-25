'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseChangedPaths, gatherDelta } = require('../system/nightshift/delta.js');

test('parseChangedPaths: dedupes, filters to wiki md + tasks.md', () => {
  const gitLog = ['wiki/content/learning/2026-07-08-a.md', 'viz/data.js', 'indexes/graph.json',
    'wiki/content/learning/2026-07-08-a.md', 'tasks/tasks.md', ''].join('\n');
  const porcelain = ' M wiki/personal/journal/2026-07-09-brain-dump.md\n?? raw/transcripts/x.md\n';
  assert.deepStrictEqual(parseChangedPaths(gitLog, porcelain), [
    'wiki/content/learning/2026-07-08-a.md',
    'tasks/tasks.md',
    'wiki/personal/journal/2026-07-09-brain-dump.md'
  ]);
});

test('parseChangedPaths: porcelain rename "R  old -> new" keeps the new path', () => {
  const r = parseChangedPaths('', 'R  wiki/content/a.md -> wiki/content/b.md\n');
  assert.deepStrictEqual(r, ['wiki/content/b.md']);
});

test('gatherDelta: reads frontmatter of changed wiki notes, skips missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-delta-'));
  const rel = 'wiki/content/learning/2026-07-09-x.md';
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), ['---', 'title: X note', 'department: content',
    'type: file', 'updated: 2026-07-09', '---', '', 'Body.'].join('\n'));
  const exec = (cmd, args) => (args.includes('log') ? `${rel}\nwiki/content/gone.md\n` : '');
  const d = gatherDelta({ rootDir: root, exec });
  assert.deepStrictEqual(d.paths, [rel, 'wiki/content/gone.md']);
  assert.strictEqual(d.notes.length, 1);
  assert.strictEqual(d.notes[0].title, 'X note');
  assert.strictEqual(d.notes[0].department, 'content');
});
