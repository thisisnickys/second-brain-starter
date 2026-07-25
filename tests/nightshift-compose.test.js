'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, parseOutput } = require('../system/nightshift/compose.js');

const INPUTS = {
  date: '2026-07-09',
  rootDir: '/tmp/second-brain',
  delta: { notes: [{ path: 'wiki/content/learning/2026-07-09-x.md', title: 'X', department: 'content', type: 'file', updated: '2026-07-09' }] },
  compass: { business: 'B compass body', content: 'C compass body', 'projects': '', personal: 'P compass body' },
  recentLedger: [{ date: '2026-07-08', id: '2026-07-08-1', title: 'Prior spark', reaction: null }]
};

test('buildPrompt carries the essentials', () => {
  const p = buildPrompt(INPUTS);
  assert.match(p, /2026-07-09/);
  assert.match(p, /X note|wiki\/content\/learning\/2026-07-09-x\.md/);
  assert.match(p, /C compass body/);
  assert.match(p, /Prior spark/);              // don't repeat yourself
  assert.match(p, /pattern.*thesis.*opportunit/is); // the validated shape
  assert.match(p, /never.*imperative|no imperatives/i);
  assert.match(p, /zero sparks|0 sparks|silence/i); // silence is valid
  assert.match(p, /brain\.js/);                 // exploration tools named
  assert.match(p, /corpus\.js/);
  assert.match(p, /JSON/);                      // output contract stated
  assert.match(p, /2\+ departments or 2\+ distinct days.*filename or note 'updated' date/i);
});

test('buildPrompt omits empty compass sections without crashing', () => {
  const p = buildPrompt(INPUTS);
  assert.ok(!/projects compass\s*:\s*\n\s*\n/i.test(p));
});

test('parseOutput extracts the LAST JSON object from noisy stdout', () => {
  const out = 'I explored the brain.\n{"note":"decoy"}\nFinal answer:\n' +
    JSON.stringify({ sparks: [{ department: 'content', title: 'T', text: 'body?', sources: ['a', 'b'] }], gapQuestion: null });
  const r = parseOutput(out);
  assert.strictEqual(r.sparks.length, 1);
  assert.strictEqual(r.sparks[0].title, 'T');
  assert.strictEqual(r.gapQuestion, null);
  assert.strictEqual(r.found, true);
});

test('parseOutput: garbage or missing JSON -> empty result, found === false', () => {
  assert.deepStrictEqual(parseOutput('no json here'), { sparks: [], gapQuestion: null, found: false });
  assert.deepStrictEqual(parseOutput(''), { sparks: [], gapQuestion: null, found: false });
  assert.deepStrictEqual(parseOutput('{"sparks": "not-an-array"}'), { sparks: [], gapQuestion: null, found: false });
});

test('parseOutput picks up gapQuestion', () => {
  const r = parseOutput(JSON.stringify({ sparks: [], gapQuestion: 'What does LB look like at the end of 2026?' }));
  assert.match(r.gapQuestion, /end of 2026/);
  assert.strictEqual(r.found, true);
});

test('parseOutput survives trailing garbage after the real JSON', () => {
  const out = JSON.stringify({ sparks: [{ department: 'content', title: 'T', text: 'body?', sources: ['a', 'b'] }], gapQuestion: null }) + '\nDone}';
  const r = parseOutput(out);
  assert.strictEqual(r.sparks.length, 1);
  assert.strictEqual(r.found, true);
});

test('parseOutput handles braces inside JSON string values', () => {
  const out = 'noise {"decoy":1}\n' + JSON.stringify({ sparks: [{ department: 'content', title: 'T {curly}', text: 'has } and { inside? yes', sources: ['a', 'b'] }], gapQuestion: null });
  const r = parseOutput(out);
  assert.strictEqual(r.sparks[0].title, 'T {curly}');
  assert.strictEqual(r.found, true);
});

test('parseOutput: decoy sparks-shaped object BEFORE the real one — last wins', () => {
  const a = JSON.stringify({ sparks: [{ title: 'first' }], gapQuestion: null });
  const b = JSON.stringify({ sparks: [{ title: 'second' }], gapQuestion: null });
  const r = parseOutput(a + '\n' + b);
  assert.strictEqual(r.sparks[0].title, 'second');
  assert.strictEqual(r.found, true);
});

test('buildPrompt carries the novelty bar', () => {
  const p = buildPrompt(INPUTS);
  assert.match(p, /novelty bar/i);
  assert.match(p, /MIRROR, not a spark/);
  assert.match(p, /could they have written this spark from memory/i);
  // Pronouns must come from brain.config.json, never be hardcoded.
  assert.match(p, /\(they\/them\)/);
  assert.doesNotMatch(p, /\bshe\b|\bher\b/i);
});
