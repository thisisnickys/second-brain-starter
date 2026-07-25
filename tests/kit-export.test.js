'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify, slugify, htmlToMd, wordCount, renderFile } = require('../system/ingest/kit-export.js');

test('classify: live announcements by 🔴/📺/Live Now', () => {
  assert.equal(classify({ subject: '🔴  Claude Fable 5 Ends Tomorrow', public: false }), 'live-announcement');
  assert.equal(classify({ subject: '📺  The End Of The Podcast Is Now Live', public: false }), 'live-announcement');
  assert.equal(classify({ subject: 'Something Is Live Right Now', public: false }), 'live-announcement');
});

test('classify: podcast drops, newsletters, updates', () => {
  assert.equal(classify({ subject: '🔉🎧 “Eps 180“ Is Now Out 🎉', public: false }), 'podcast-announcement');
  assert.equal(classify({ subject: 'AI slop isn\'t made by AI', public: true }), 'newsletter');
  assert.equal(classify({ subject: '🦁 New Content Alert', public: false }), 'update');
});

test('slugify strips emoji and caps length', () => {
  assert.equal(slugify('🔴  Claude Fable 5: Ends Tomorrow!'), 'claude-fable-5-ends-tomorrow');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
  assert.equal(slugify('🔴🔴🔴'), 'untitled');
});

test('htmlToMd converts links, headings, lists, entities', () => {
  const html = '<html><head><style>p{color:red}</style></head><body>' +
    '<h1>Big News</h1><p>Hello &amp; welcome&nbsp;back</p>' +
    '<ul><li>First</li><li><a href="https://x.com/a">A link</a></li></ul>' +
    '<a href="#anchor">skip me</a><img alt="pic" src="https://cdn/img.png">' +
    '</body></html>';
  const md = htmlToMd(html);
  assert.match(md, /## Big News/);
  assert.match(md, /Hello & welcome back/);
  assert.match(md, /- First/);
  assert.match(md, /- \[A link\]\(https:\/\/x\.com\/a\)/);
  assert.match(md, /!\[pic\]\(https:\/\/cdn\/img\.png\)/);
  assert.ok(!md.includes('color:red'));
  assert.ok(!md.includes('<'));
  assert.ok(md.includes('skip me')); // anchor link keeps its text
});

test('renderFile produces a parseable header', () => {
  const { text } = renderFile(
    { id: 42, subject: 'Test: Send', public: true, published_at: '2026-07-07T01:00:17Z', public_url: 'https://kit.com/x' },
    'Body words here.'
  );
  assert.match(text, /^---\nid: kit-42\nplatform: kit\ntype: newsletter\ntitle: Test: Send\n/);
  assert.match(text, /word_count: 3\n/);
  assert.match(text, /\n---\n\nBody words here\.\n$/);
});

test('wordCount', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('one  two\nthree'), 3);
});
