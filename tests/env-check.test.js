'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkEnvText } = require('../system/lib/env-check.js');

const GOOD = 'NOTION_TOKEN=abc123\n\n# comment\nTELEGRAM_BOT_TOKEN=999:xyz\n';

test('clean env text has no problems', () => {
  assert.deepStrictEqual(checkEnvText(GOOD), []);
});

test('detects the fused-line bug (value containing another KEY=)', () => {
  const fused = 'TICKTICK_ACCESS_TOKEN=5266df69NOTION_READWATCH_DB=e0400d4c\n';
  const problems = checkEnvText(fused);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /fused/i);
  assert.match(problems[0], /TICKTICK_ACCESS_TOKEN/);
});

test('base64-style values with = padding are NOT flagged as fused', () => {
  // no underscore in the embedded run -> not a key, just token padding
  const ok = 'KIT_API_KEY=aGVsbG8gd29ybGQABCDEF=\n';
  assert.deepStrictEqual(checkEnvText(ok), []);
});

test('detects missing trailing newline', () => {
  const problems = checkEnvText('NOTION_TOKEN=abc');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /trailing newline/i);
});

test('detects duplicate keys', () => {
  const problems = checkEnvText('A_KEY=1\nA_KEY=2\n');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /duplicate/i);
  assert.match(problems[0], /A_KEY/);
});

test('detects missing required keys', () => {
  const problems = checkEnvText(GOOD, ['NOTION_TOKEN', 'ELEVENLABS_API_KEY']);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /ELEVENLABS_API_KEY/);
});

test('flags stray non KEY=VALUE text', () => {
  const problems = checkEnvText('NOTION_TOKEN=abc\nsome stray words\n');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /line 2/);
});

test('empty or unreadable file is one problem', () => {
  const problems = checkEnvText('');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /empty/i);
});
