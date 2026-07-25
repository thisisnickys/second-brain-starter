'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderPost, postKind } = require('../system/ingest/instagram-corpus.js');

test('postKind maps apify types', () => {
  assert.equal(postKind({ type: 'Video', productType: 'clips' }), 'reel');
  assert.equal(postKind({ type: 'Sidecar', productType: 'carousel_container' }), 'carousel');
  assert.equal(postKind({ type: 'Video', productType: 'feed' }), 'video');
  assert.equal(postKind({ type: 'Image' }), 'image');
});

test('renderPost produces catalog-parseable file', () => {
  const { name, text } = renderPost({
    shortCode: 'DaT0PD5Ntcs',
    type: 'Video', productType: 'clips',
    caption: 'Create WHATEVER you want to do!\n\n#lionsbehavior',
    timestamp: '2026-07-03T00:01:56.000Z',
    likesCount: 261, commentsCount: 35,
    videoViewCount: 2237, videoPlayCount: 5192, videoDuration: 25.285,
    url: 'https://www.instagram.com/p/DaT0PD5Ntcs/',
  });
  assert.equal(name, '2026-07-03-instagram-DaT0PD5Ntcs-create-whatever-you-want-to-do-lionsbehavior.md');
  assert.match(text, /^---\nid: instagram-DaT0PD5Ntcs\nplatform: instagram\ntype: reel\n/);
  assert.match(text, /views: 5192\n/);       // playCount preferred over viewCount
  assert.match(text, /duration_sec: 25\n/);
  assert.match(text, /word_count: 7\n/);
});

test('renderPost handles caption-less posts', () => {
  const { text } = renderPost({ shortCode: 'x1', type: 'Image', timestamp: '2025-01-01T00:00:00.000Z' });
  assert.match(text, /\[no caption — image\]/);
  assert.match(text, /word_count: 0\n/);
});
