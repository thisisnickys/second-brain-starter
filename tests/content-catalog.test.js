'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCorpusHeader } = require('../system/ingest/content-catalog.js');

test('parseCorpusHeader reads the compact header block', () => {
  const data = parseCorpusHeader('---\nid: kit-42\nplatform: kit\ntype: newsletter\ntitle: Hello: World\ndate: 2026-07-07\nword_count: 812\n---\n\nBody');
  assert.equal(data.id, 'kit-42');
  assert.equal(data.platform, 'kit');
  assert.equal(data.title, 'Hello: World');
  assert.equal(data.word_count, '812');
});

test('parseCorpusHeader returns null without a header', () => {
  assert.equal(parseCorpusHeader('Source: https://youtu.be/x\n\n# Transcript\n...'), null);
});
