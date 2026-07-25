const { test } = require('node:test');
const assert = require('node:assert');
const blocks = require('./fixtures/notion-blocks.json');
const { blocksToMarkdown } = require('../system/ingest/notion-snapshot.js');

test('converts common notion blocks to markdown', () => {
  const md = blocksToMarkdown(blocks);
  assert.match(md, /^# Big Title$/m);
  assert.match(md, /^Hello world$/m);
  assert.match(md, /^- Point one$/m);
  assert.match(md, /^1\. Step one$/m);
  assert.match(md, /^> Wise words$/m);
  assert.match(md, /^> \*\*Note:\*\* Note this$/m);
  assert.match(md, /```python\nx = 1\n```/);
  assert.match(md, /^---$/m);
  assert.ok(!md.includes('unsupported_thing'));
});

test('table rows get a header separator after the first row', () => {
  const tbl = [
    {"type": "table_row", "table_row": {"cells": [[{"plain_text": "A"}], [{"plain_text": "B"}]]}},
    {"type": "table_row", "table_row": {"cells": [[{"plain_text": "1"}], [{"plain_text": "2"}]]}},
    {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": "after"}]}},
    {"type": "table_row", "table_row": {"cells": [[{"plain_text": "X"}]]}}
  ];
  const md = blocksToMarkdown(tbl);
  const lines = md.split('\n').filter(Boolean);
  assert.strictEqual(lines[0], '| A | B |');
  assert.strictEqual(lines[1], '| --- | --- |');
  assert.strictEqual(lines[2], '| 1 | 2 |');
  assert.match(md, /\| X \|\n\| --- \|/);
});
