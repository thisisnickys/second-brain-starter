'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { uploadDateToIso, renderFile } = require('../system/ingest/youtube-transcripts.js');

test('uploadDateToIso converts yt-dlp YYYYMMDD', () => {
  assert.equal(uploadDateToIso('20260524'), '2026-05-24');
  assert.equal(uploadDateToIso(''), '');
  assert.equal(uploadDateToIso('garbage'), '');
});

test('renderFile produces catalog-parseable header and filename', () => {
  const { name, text } = renderFile(
    { id: 'qLUQTeSj0e8', title: 'fallback', type: 'long' },
    { title: 'Gemini Omni: 2 Minutes', upload_date: '20260524', duration: 512.7, view_count: 4000 },
    'hello world transcript',
    'captions'
  );
  assert.equal(name, '2026-05-24-youtube-qLUQTeSj0e8-gemini-omni-2-minutes.md');
  assert.match(text, /^---\nid: youtube-qLUQTeSj0e8\nplatform: youtube\ntype: long\n/);
  assert.match(text, /duration_sec: 513\n/);
  assert.match(text, /transcript_source: captions\n/);
  assert.match(text, /word_count: 3\n/);
});
