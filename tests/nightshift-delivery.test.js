'use strict';
// Phase 3 — delivery. Sparks file → morning Telegram messages, stale-file
// refusal, ledger messageId marking, same-night rerun guard, quotePath flag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readTodaysSparks, sparkMessage } = require('../system/telegram/morning-brief.js');
const { appendSparks, markSent, readRecent } = require('../system/nightshift/ledger.js');
const { gatherDelta } = require('../system/nightshift/delta.js');
const { runNightShift } = require('../system/nightshift/run.js');

/* ------------------------------ readTodaysSparks ------------------------------ */

const FRESH = JSON.stringify({
  date: '2026-07-10',
  sparks: [
    { id: '2026-07-10-1', department: 'business', title: 'One thing', text: 'Pattern → thesis → what if?', sources: ['wiki/a.md', 'wiki/b.md'] }
  ],
  gapQuestion: 'Which ring is the pilot really for?'
});

test('readTodaysSparks: fresh file for today returns sparks + gap question', () => {
  const r = readTodaysSparks(FRESH, '2026-07-10');
  assert.strictEqual(r.sparks.length, 1);
  assert.strictEqual(r.gapQuestion, 'Which ring is the pilot really for?');
});

test('readTodaysSparks: stale file (yesterday) is never sent', () => {
  const r = readTodaysSparks(FRESH, '2026-07-11');
  assert.deepStrictEqual(r, { sparks: [], gapQuestion: null });
});

test('readTodaysSparks: malformed / empty / missing text are silence', () => {
  assert.deepStrictEqual(readTodaysSparks('not json', '2026-07-10'), { sparks: [], gapQuestion: null });
  assert.deepStrictEqual(readTodaysSparks('', '2026-07-10'), { sparks: [], gapQuestion: null });
  const noText = JSON.stringify({ date: '2026-07-10', sparks: [{ title: 'x' }], gapQuestion: null });
  assert.deepStrictEqual(readTodaysSparks(noText, '2026-07-10').sparks, []);
});

test('sparkMessage: ⚡ prefix, title then text', () => {
  const m = sparkMessage({ title: 'One thing', text: 'Body here' });
  assert.ok(m.startsWith('⚡ One thing'));
  assert.match(m, /Body here/);
});

/* ------------------------------ ledger markSent ------------------------------ */

test('appendSparks returns entries with ids; markSent stamps messageIds in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ledger-'));
  const lp = path.join(dir, 'ledger.jsonl');
  const entries = appendSparks(lp, '2026-07-10', [
    { department: 'business', title: 'A', text: 't', sources: [] },
    { department: 'content', title: 'B', text: 't', sources: [] }
  ]);
  assert.deepStrictEqual(entries.map(e => e.id), ['2026-07-10-1', '2026-07-10-2']);
  const n = markSent(lp, '2026-07-10', { '2026-07-10-2': 555 });
  assert.strictEqual(n, 1);
  const rows = readRecent(lp, 2, '2026-07-10');
  assert.strictEqual(rows.find(r => r.id === '2026-07-10-2').messageId, 555);
  assert.strictEqual(rows.find(r => r.id === '2026-07-10-1').messageId, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ delta quotePath ------------------------------ */

test('gatherDelta passes -c core.quotePath=off to git (M1)', () => {
  const calls = [];
  gatherDelta({ rootDir: '/tmp', exec: (cmd, args) => { calls.push(args); return ''; } });
  for (const args of calls) {
    assert.strictEqual(args[0], '-c');
    assert.strictEqual(args[1], 'core.quotePath=off');
  }
  assert.ok(calls.length >= 2);
});

/* --------------------------- same-night rerun guard --------------------------- */

test('runNightShift refuses a same-night rerun when the sparks file exists (M3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-rerun-'));
  fs.mkdirSync(path.join(dir, 'system', 'nightshift', 'sparks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'system', 'nightshift', 'sparks', '2026-07-10.json'),
    JSON.stringify({ date: '2026-07-10', sparks: [], gapQuestion: null }));
  let claudeCalled = false;
  const logs = [];
  const r = await runNightShift({
    rootDir: dir, date: '2026-07-10',
    deps: {
      log: m => logs.push(m), logError: m => logs.push(m),
      exec: () => 'wiki/x.md\n',
      execClaude: async () => { claudeCalled = true; return '{}'; }
    }
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.wrote, false);
  assert.ok(logs.some(l => /already ran/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
