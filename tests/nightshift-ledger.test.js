'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendSparks, readRecent } = require('../system/nightshift/ledger.js');

test('appendSparks writes JSONL with ids; readRecent filters by window', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-led-')), 'ledger.jsonl');
  appendSparks(p, '2026-07-01', [{ department: 'content', title: 'Old', text: 't?', sources: ['a', 'b'] }]);
  appendSparks(p, '2026-07-09', [{ department: 'business', title: 'New', text: 't?', sources: ['a', 'b'] },
    { department: 'content', title: 'New2', text: 't?', sources: ['a', 'b'] }]);
  const all = readRecent(p, 365, '2026-07-09');
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[1].id, '2026-07-09-1');
  assert.strictEqual(all[2].id, '2026-07-09-2');
  assert.strictEqual(all[0].reaction, null);
  const recent = readRecent(p, 7, '2026-07-09');
  assert.deepStrictEqual(recent.map(e => e.title), ['New', 'New2']);
});

test('readRecent: missing file -> [], malformed lines skipped', () => {
  assert.deepStrictEqual(readRecent('/nonexistent/ledger.jsonl', 7, '2026-07-09'), []);
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-led-')), 'ledger.jsonl');
  fs.writeFileSync(p, 'not json\n' + JSON.stringify({ date: '2026-07-09', id: 'x', title: 'ok' }) + '\n');
  assert.strictEqual(readRecent(p, 7, '2026-07-09').length, 1);
});

test('appendSparks twice for the same date continues numbering (no id collision)', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-led-')), 'ledger.jsonl');
  appendSparks(p, '2026-07-09', [{ department: 'content', title: 'A', text: 't?', sources: ['a', 'b'] }]);
  appendSparks(p, '2026-07-09', [{ department: 'content', title: 'B', text: 't?', sources: ['a', 'b'] }]);
  const ids = readRecent(p, 7, '2026-07-09').map(e => e.id);
  assert.deepStrictEqual(ids, ['2026-07-09-1', '2026-07-09-2']);
});
