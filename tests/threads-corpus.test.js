'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderPost, postKind } = require('../system/ingest/threads-corpus.js');

test('postKind precedence: repost > quote > reply > post', () => {
  assert.equal(postKind({ is_repost: true, is_reply: true }), 'repost');
  assert.equal(postKind({ is_quote_post: true }), 'quote');
  assert.equal(postKind({ is_reply: true }), 'reply');
  assert.equal(postKind({}), 'post');
});

test('renderPost produces catalog-parseable file', () => {
  const { name, text } = renderPost({
    shortcode: 'C2lCAiavoSg',
    username: 'samexample',
    text_content: 'Did you know I had a weekly newsletter?\nMore below.',
    created_at: '2024-01-26T21:30:12+00:00',
    like_count: 201, reply_count: 21, view_count: 27134,
    has_media: true, media_type: 'photo', is_pinned: false,
    post_url: 'https://www.threads.net/@samexample/post/C2lCAiavoSg',
  });
  assert.equal(name, '2024-01-26-threads-C2lCAiavoSg-did-you-know-i-had-a-weekly-newsletter-more-below.md');
  assert.match(text, /^---\nid: threads-C2lCAiavoSg\nplatform: threads\ntype: post\n/);
  assert.match(text, /title: Did you know I had a weekly newsletter\?\n/);
  assert.match(text, /views: 27134\n/);
  assert.match(text, /word_count: 10\n/);
});

test('renderPost handles media-only posts', () => {
  const { text } = renderPost({
    shortcode: 'abc123', has_media: true, media_type: 'video',
    created_at: '2025-03-01T00:00:00+00:00',
  });
  assert.match(text, /\[media-only video\]/);
  assert.match(text, /word_count: 0\n/);
});
