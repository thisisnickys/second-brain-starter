'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runNightShift } = require('../system/nightshift/run.js');

function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-run-'));
  const note = 'wiki/content/learning/2026-07-08-a.md';
  const note2 = 'wiki/business/2026-07-09-deal.md';
  for (const rel of [note, note2]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), ['---', `title: ${path.basename(rel)}`,
      `department: ${rel.split('/')[1]}`, 'type: file', 'updated: 2026-07-09', '---', '', 'Body.'].join('\n'));
  }
  fs.mkdirSync(path.join(root, 'wiki', 'personal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'content', 'compass.md'),
    ['---', 'title: Content Compass', 'department: content', 'type: compass', 'updated: 2026-07-09', '---', '', 'The empire picture.'].join('\n'));
  return { root, note, note2 };
}

function goodClaudeOutput(note, note2) {
  return 'explored...\n' + JSON.stringify({
    sparks: [{ department: 'content', title: 'One thesis', text: 'x'.repeat(120) + ' What if this is one thing?', sources: [note, note2] }],
    gapQuestion: null
  });
}

test('dry-run: returns gated sparks, writes NOTHING', async () => {
  const { root, note, note2 } = scaffold();
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: true,
    deps: { execClaude: async () => goodClaudeOutput(note, note2), exec: () => `${note}\n${note2}\n`, log: () => {} }
  });
  assert.strictEqual(r.sparks.length, 1);
  assert.strictEqual(r.wrote, false);
  assert.ok(!fs.existsSync(path.join(root, 'system', 'nightshift', 'sparks', '2026-07-09.json')));
  assert.ok(!fs.existsSync(path.join(root, 'system', 'nightshift', 'ledger.jsonl')));
});

test('real run: writes sparks file + ledger', async () => {
  const { root, note, note2 } = scaffold();
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => goodClaudeOutput(note, note2), exec: () => `${note}\n${note2}\n`, log: () => {} }
  });
  assert.strictEqual(r.wrote, true);
  const f = JSON.parse(fs.readFileSync(path.join(root, 'system', 'nightshift', 'sparks', '2026-07-09.json'), 'utf8'));
  assert.strictEqual(f.sparks.length, 1);
  assert.strictEqual(f.date, '2026-07-09');
  const ledger = fs.readFileSync(path.join(root, 'system', 'nightshift', 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(JSON.parse(ledger[0]).id, '2026-07-09-1');
});

test('empty delta -> silence, no claude call, no file', async () => {
  const { root } = scaffold();
  let called = false;
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => { called = true; return ''; }, exec: () => '', log: () => {} }
  });
  assert.strictEqual(called, false);
  assert.deepStrictEqual(r.sparks, []);
  assert.strictEqual(r.wrote, false);
});

test('claude failure or garbage -> silence, never throws', async () => {
  const { root, note, note2 } = scaffold();
  for (const execClaude of [async () => { throw new Error('boom'); }, async () => 'no json']) {
    const r = await runNightShift({
      rootDir: root, date: '2026-07-09', dryRun: false,
      deps: { execClaude, exec: () => `${note}\n${note2}\n`, log: () => {} }
    });
    assert.deepStrictEqual(r.sparks, []);
    assert.strictEqual(r.wrote, false);
  }
});

test('all sparks gated out -> no file written', async () => {
  const { root, note, note2 } = scaffold();
  const bad = JSON.stringify({ sparks: [{ department: 'content', title: 'Bad', text: 'You need to do this. '.repeat(10), sources: [note, note2] }], gapQuestion: null });
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => bad, exec: () => `${note}\n${note2}\n`, log: () => {} }
  });
  assert.deepStrictEqual(r.sparks, []);
  assert.strictEqual(r.dropped.length, 1);
  assert.strictEqual(r.wrote, false);
});

test('claude output had no valid JSON but stdout non-empty -> distinct silence log via deps.logError', async () => {
  const { root, note, note2 } = scaffold();
  const errors = [];
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => 'no json', exec: () => `${note}\n${note2}\n`, log: () => {}, logError: msg => errors.push(msg) }
  });
  assert.deepStrictEqual(r.sparks, []);
  assert.strictEqual(r.wrote, false);
  assert.ok(errors.some(m => /no valid JSON/.test(m)), `expected a "no valid JSON" log, got: ${JSON.stringify(errors)}`);
});

test('claude execClaude failure uses deps.logError', async () => {
  const { root, note, note2 } = scaffold();
  const errors = [];
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => { throw new Error('boom'); }, exec: () => `${note}\n${note2}\n`, log: () => {}, logError: msg => errors.push(msg) }
  });
  assert.strictEqual(r.wrote, false);
  assert.ok(errors.some(m => /claude failed/.test(m)));
});

test('gapQuestion failing voice gate is dropped (treated as null, does not force a write)', async () => {
  const { root, note, note2 } = scaffold();
  const out = JSON.stringify({ sparks: [], gapQuestion: 'You need to define your Q4 target' });
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => out, exec: () => `${note}\n${note2}\n`, log: () => {} }
  });
  assert.strictEqual(r.gapQuestion, null);
  assert.strictEqual(r.wrote, false);
});

test('gapQuestion alone still writes the file (delivered without sparks)', async () => {
  const { root, note, note2 } = scaffold();
  const out = JSON.stringify({ sparks: [], gapQuestion: 'What does LB look like end of 2026?' });
  const r = await runNightShift({
    rootDir: root, date: '2026-07-09', dryRun: false,
    deps: { execClaude: async () => out, exec: () => `${note}\n${note2}\n`, log: () => {} }
  });
  assert.strictEqual(r.wrote, true);
  const f = JSON.parse(fs.readFileSync(path.join(root, 'system', 'nightshift', 'sparks', '2026-07-09.json'), 'utf8'));
  assert.deepStrictEqual(f.sparks, []);
  assert.match(f.gapQuestion, /end of 2026/);
});
