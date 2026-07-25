const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex } = require('../system/build-index.js');

test('buildIndex groups pages by department', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  fs.mkdirSync(path.join(tmp, 'content'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'content', 'a.md'),
`---
title: Page A
department: content
tags: [x]
behaviors: [create]
updated: 2026-07-06
---
Body`);
  const idx = buildIndex(tmp);
  assert.strictEqual(idx.byDepartment.content.length, 1);
  assert.strictEqual(idx.byDepartment.content[0].title, 'Page A');
  assert.strictEqual(idx.byDepartment.content[0].relPath, 'content/a.md');
});

test('page with prototype-colliding department is skipped, not crashed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  fs.mkdirSync(path.join(tmp, 'x'));
  fs.writeFileSync(path.join(tmp, 'x', 'bad.md'),
`---
title: Bad
department: constructor
tags: []
behaviors: []
updated: 2026-07-06
---
B`);
  const idx = buildIndex(tmp);
  assert.strictEqual(Object.values(idx.byDepartment).flat().length, 0);
});
