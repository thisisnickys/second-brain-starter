const { test } = require('node:test');
const assert = require('node:assert');
const { tokenize, STOPWORDS } = require('../system/lib/text.js');

test('tokenize lowercases, splits, drops stopwords and short tokens, dedupes', () => {
  assert.deepStrictEqual(
    tokenize('Which TTS voice do we use for the Kling launch? TTS!'),
    ['tts', 'voice', 'use', 'kling', 'launch']);
});

test('numbers survive', () => {
  assert.ok(tokenize('rules 1-27 for 2026').includes('27'));
  assert.ok(STOPWORDS.has('the'));
});
