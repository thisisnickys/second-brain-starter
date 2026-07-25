const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scoreNode, bestSection, retrieve } = require('../system/brain.js');

test('scoreNode weights title over keywords', () => {
  const node = { id: 'wiki/content/a.md', title: 'Retention Playbook', tags: ['avd'], behaviors: ['create'], keywords: ['intro', 'hooks'] };
  assert.ok(scoreNode(['retention'], node) > scoreNode(['intro'], node));
  assert.strictEqual(scoreNode(['zebra'], node), 0);
});

test('bestSection picks the section whose heading matches', () => {
  const body = `# Page\n\nintro text here\n\n## Thumbnail rules\n\nuse the payoff image, avd wins\n\n## Other\n\nnothing relevant`;
  const s = bestSection(['thumbnail', 'payoff'], body);
  assert.match(s.heading, /Thumbnail rules/);
  assert.match(s.text, /payoff image/);
});

test('retrieve end-to-end: top hit + snippet + pointer follow', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  fs.mkdirSync(path.join(tmp, 'wiki', 'content'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'pointer.md'),
`---
title: Kling Launch
department: content
tags: [kling]
behaviors: []
updated: 2026-07-06
---
# Kling Launch

## Thumbnail verdict
See [Launch Rules](rules.md).
`);
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'rules.md'),
`---
title: Launch Rules
department: content
tags: []
behaviors: []
updated: 2026-07-06
---
# Launch Rules

## Thumbnail verdict
The payoff thumbnail won at 9.5 percent CTR.
`);
  const graph = { nodes: [
    { id: 'wiki/content/pointer.md', type: 'file', title: 'Kling Launch', department: 'content', arms: 'memory', behaviors: [], keywords: ['kling', 'thumbnail', 'verdict'], links: ['wiki/content/rules.md'], updated: '2026-07-06' },
    { id: 'wiki/content/rules.md', type: 'file', title: 'Launch Rules', department: 'content', arms: 'memory', behaviors: [], keywords: ['thumbnail'], links: [], updated: '2026-07-06' }
  ]};
  fs.writeFileSync(path.join(tmp, 'indexes', 'graph.json'), JSON.stringify({ generated: 'x', counts: {}, catalogRef: 'files-catalog.json', nodes: graph.nodes }));
  fs.writeFileSync(path.join(tmp, 'indexes', 'files-catalog.json'), JSON.stringify({ generated: 'x', roots: {}, files: [
    { name: 'kling-thumb-final.png', relPath: 'thumbs/kling-thumb-final.png', root: 'drive-youtube', department: 'content', ext: 'png', size: 1, mtime: '2026-07-06' }
  ]}));
  const r = retrieve('what was the kling thumbnail verdict', tmp);
  assert.strictEqual(r.top[0].id, 'wiki/content/pointer.md');
  assert.ok(r.snippet);
  assert.strictEqual(r.snippet.followed, 'wiki/content/rules.md'); // pointer section is short → one hop
  assert.match(r.snippet.text, /payoff thumbnail won/);
  assert.ok(r.assets.some(a => a.name === 'kling-thumb-final.png'));
});

test('snippet comes from the best wiki node even when a skill node outscores it', () => {
  // build a tmp root where a skill node scores highest but a file node matches too
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain2-'));
  fs.mkdirSync(path.join(tmp, 'wiki', 'content'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'pipeline-notes.md'),
`---
title: Pipeline Notes
department: content
tags: [pipeline]
behaviors: []
updated: 2026-07-06
---
# Pipeline Notes

## How the pipeline runs
Wave order matters: intelligence then creation.
`);
  fs.writeFileSync(path.join(tmp, 'indexes', 'graph.json'), JSON.stringify({ generated: 'x', counts: {}, catalogRef: 'files-catalog.json', nodes: [
    { id: 'skill:pipeline', type: 'skill', title: 'pipeline', department: null, arms: 'skills', behaviors: [], keywords: ['pipeline', 'content', 'waves'], links: [], updated: null },
    { id: 'wiki/content/pipeline-notes.md', type: 'file', title: 'Pipeline Notes', department: 'content', arms: 'memory', behaviors: [], keywords: ['pipeline', 'runs'], links: [], updated: '2026-07-06' }
  ]}));
  const r = retrieve('pipeline', tmp);
  assert.ok(r.snippet, 'snippet must not be null when a wiki node matched');
  assert.strictEqual(r.snippet.id, 'wiki/content/pipeline-notes.md');
  assert.match(r.snippet.text, /Wave order matters/);
});

test('missing graph.json throws a clear error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain3-'));
  assert.throws(() => retrieve('anything', tmp), /run: node system\/build-graph\.js/);
});

test('bestSection never returns an empty section when a non-empty one exists', () => {
  const body = `# The updated field means content changed\n\n## Decision\n\nThe updated field means the content changed, not last ingest.\n\n## Why\n\nNightly rewrites buried real diffs.`;
  const s = bestSection(['updated', 'field', 'means'], body);
  assert.ok(s.text.trim().length > 0);
  assert.match(s.text, /content changed, not last ingest/);
});

test('corrupt graph.json throws a clear error, not a JSON stack', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain4-'));
  fs.mkdirSync(path.join(tmp, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'indexes', 'graph.json'), '{not json');
  assert.throws(() => retrieve('x', tmp), /graph\.json is corrupt — rerun: node system\/build-graph\.js/);
});
