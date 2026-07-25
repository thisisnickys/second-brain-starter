const { test } = require('node:test');
const assert = require('node:assert');
const { computePositions } = require('../system/build-viz.js');

const WORLD_MAP = {
  elements: { Code: [980, 220], Systems: [980, 520], Territory: [1340, 520], Empire: [980, 820] },
  layers: {},
  rules: [{ match: 'launch-rules', element: 'Code' }],
  typeDefaults: { skill: 'Systems' },
  departmentDefaults: { content: 'Territory', business: 'Empire' }
};

const NODES = [
  { id: 'wiki/content/launch-rules/rules.md', type: 'decision', title: 'Rules', department: 'content', arms: 'memory', behaviors: ['create'], keywords: [], links: [], updated: '2026-07-06' },
  { id: 'wiki/business/a.md', type: 'file', title: 'A', department: 'business', arms: 'memory', behaviors: [], keywords: [], links: [], updated: '2026-07-06' },
  { id: 'skill:yt', type: 'skill', title: 'yt', department: null, arms: 'skills', behaviors: [], keywords: [], links: [], updated: null }
];

test('every node gets four lens positions inside the canvas', () => {
  const { nodes } = computePositions(NODES, [], WORLD_MAP);
  for (const n of nodes) {
    for (const lens of ['departments', 'arms', 'behaviors', 'world']) {
      const [x, y] = n.pos[lens];
      assert.ok(x >= 0 && x <= 1600 && y >= 0 && y <= 1000, `${n.id} ${lens} in bounds`);
    }
  }
});

test('world assignment: rule beats department default; type default for OS nodes', () => {
  const { nodes } = computePositions(NODES, [], WORLD_MAP);
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  assert.strictEqual(byId['wiki/content/launch-rules/rules.md'].worldElement, 'Code');
  assert.strictEqual(byId['wiki/business/a.md'].worldElement, 'Empire');
  assert.strictEqual(byId['skill:yt'].worldElement, 'Systems');
});

test('asset roots become summary nodes in the departments lens', () => {
  const roots = [{ label: 'drive-youtube', department: 'content', count: 359, topExts: ['mp4', 'mov'] }];
  const { assetNodes } = computePositions(NODES, roots, WORLD_MAP);
  assert.strictEqual(assetNodes.length, 1);
  assert.strictEqual(assetNodes[0].kind, 'asset-root');
  assert.ok(assetNodes[0].pos.departments[0] > 0);
});

test('positions are deterministic', () => {
  const a = computePositions(NODES, [], WORLD_MAP);
  const b = computePositions(NODES, [], WORLD_MAP);
  assert.deepStrictEqual(a.nodes.map(n => n.pos), b.nodes.map(n => n.pos));
});

test('assetDotArrays produces one dot per file around its hub', () => {
  const { assetDotArrays } = require('../system/build-viz.js');
  const files = [
    { root: 'r1' }, { root: 'r1' }, { root: 'r2' }
  ];
  const rootsOrder = ['r1', 'r2'];
  const hubs = { r1: { departments: [400, 300], arms: [800, 340] }, r2: { departments: [1200, 700], arms: [820, 660] } };
  const d = assetDotArrays(files, rootsOrder, hubs);
  assert.strictEqual(d.departments.length, 6); // 3 dots × (x,y)
  assert.strictEqual(d.arms.length, 6);
  assert.deepStrictEqual(d.rootIdx, [0, 0, 1]);
  // dots orbit their hub: within 260px
  assert.ok(Math.hypot(d.departments[0] - 400, d.departments[1] - 300) < 260);
  assert.ok(Math.hypot(d.departments[4] - 1200, d.departments[5] - 700) < 260);
});

test('wiki nodes carry embedded content and inbound links', () => {
  const fs2 = require('fs'); const os2 = require('os'); const path2 = require('path');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'viz2-'));
  fs2.mkdirSync(path2.join(tmp, 'wiki', 'content'), { recursive: true });
  fs2.writeFileSync(path2.join(tmp, 'wiki', 'content', 'a.md'),
`---
title: A
department: content
tags: []
behaviors: []
updated: 2026-07-07
---
# A

Points to [B](b.md).
`);
  fs2.writeFileSync(path2.join(tmp, 'wiki', 'content', 'b.md'),
`---
title: B
department: content
tags: []
behaviors: []
updated: 2026-07-07
---
# B body text
`);
  const { buildDataNodes } = require('../system/build-viz.js');
  const graphNodes = [
    { id: 'wiki/content/a.md', type: 'file', title: 'A', department: 'content', arms: 'memory', behaviors: [], keywords: [], links: ['wiki/content/b.md'], updated: '2026-07-07' },
    { id: 'wiki/content/b.md', type: 'file', title: 'B', department: 'content', arms: 'memory', behaviors: [], keywords: [], links: [], updated: '2026-07-07' }
  ];
  const out = buildDataNodes(graphNodes, tmp);
  const b = out.find(n => n.id === 'wiki/content/b.md');
  assert.match(b.content, /B body text/);
  assert.deepStrictEqual(b.inbound, ['wiki/content/a.md']);
});
