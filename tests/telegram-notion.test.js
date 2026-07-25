const { test } = require('node:test');
const assert = require('node:assert');

const {
  textChunks,
  mdRichText,
  imageBlock,
  mdToBlocks,
  transcriptBlocks,
  chunkArray,
  buildPagePayload
} = require('../system/telegram/notion.js');

/* ------------------------------- mdRichText ----------------------------- */

test('mdRichText renders **bold** as an annotation, not literal asterisks', () => {
  const rt = mdRichText('**Fix 1 — limits:** AI does fast work');
  assert.strictEqual(rt.length, 2);
  assert.strictEqual(rt[0].text.content, 'Fix 1 — limits:');
  assert.deepStrictEqual(rt[0].annotations, { bold: true });
  assert.strictEqual(rt[1].text.content, ' AI does fast work');
  assert.strictEqual(rt[1].annotations, undefined);
});

test('mdRichText: plain text and empty input stay simple', () => {
  assert.strictEqual(mdRichText('no markup here').length, 1);
  assert.strictEqual(mdRichText('')[0].text.content, '');
});

test('mdToBlocks bullets carry bold annotations through', () => {
  const blocks = mdToBlocks('- **key point:** the rest');
  assert.deepStrictEqual(blocks[0].bulleted_list_item.rich_text[0].annotations, { bold: true });
});

/* -------------------------------- imageBlock ---------------------------- */

test('imageBlock builds an external image block', () => {
  const b = imageBlock('https://i.ytimg.com/vi/abc/hqdefault.jpg');
  assert.strictEqual(b.type, 'image');
  assert.strictEqual(b.image.external.url, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
});

/* ------------------------------- textChunks ----------------------------- */

test('textChunks splits at the 2000-char Notion limit', () => {
  const chunks = textChunks('x'.repeat(4500));
  assert.deepStrictEqual(chunks.map(c => c.length), [2000, 2000, 500]);
});

test('textChunks on empty input returns one empty chunk', () => {
  assert.deepStrictEqual(textChunks(''), ['']);
});

/* ------------------------------- mdToBlocks ----------------------------- */

test('mdToBlocks maps headings, bullets, quotes, paragraphs', () => {
  const blocks = mdToBlocks('## Core ideas\n- first point\n> a quote\nplain text\n\n### Sub');
  assert.deepStrictEqual(blocks.map(b => b.type),
    ['heading_2', 'bulleted_list_item', 'quote', 'paragraph', 'heading_3']);
  assert.strictEqual(blocks[0].heading_2.rich_text[0].text.content, 'Core ideas');
  assert.strictEqual(blocks[1].bulleted_list_item.rich_text[0].text.content, 'first point');
});

test('mdToBlocks skips blank lines and handles empty input', () => {
  assert.deepStrictEqual(mdToBlocks('\n\n\n'), []);
  assert.deepStrictEqual(mdToBlocks(''), []);
});

test('mdToBlocks chunks an over-long bullet into multiple rich_text items', () => {
  const blocks = mdToBlocks('- ' + 'y'.repeat(4100));
  assert.strictEqual(blocks.length, 1);
  const rt = blocks[0].bulleted_list_item.rich_text;
  assert.strictEqual(rt.length, 3);
  assert.ok(rt.every(item => item.text.content.length <= 2000));
});

/* ---------------------------- transcriptBlocks -------------------------- */

test('transcriptBlocks makes <=2000-char paragraphs and drops empties', () => {
  const blocks = transcriptBlocks('t'.repeat(5000));
  assert.strictEqual(blocks.length, 3);
  assert.ok(blocks.every(b => b.type === 'paragraph'));
  assert.deepStrictEqual(transcriptBlocks(''), []);
});

/* ------------------------------- chunkArray ----------------------------- */

test('chunkArray batches at 100 for the blocks API', () => {
  const batches = chunkArray(new Array(250).fill(0));
  assert.deepStrictEqual(batches.map(b => b.length), [100, 100, 50]);
  assert.deepStrictEqual(chunkArray([]), []);
});

/* ----------------------------- buildPagePayload ------------------------- */

test('buildPagePayload matches the Read/Watch List schema', () => {
  const p = buildPagePayload({
    dbId: 'db1',
    title: 'A video',
    channel: 'A channel',
    url: 'https://www.youtube.com/watch?v=abc',
    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    dateStr: '2026-07-07'
  });
  assert.strictEqual(p.parent.database_id, 'db1');
  assert.strictEqual(p.properties.Type.select.name, 'Youtube');
  assert.strictEqual(p.properties.Status.status.name, 'Done');
  assert.strictEqual(p.properties.Score.select.name, 'TBD');
  assert.strictEqual(p.properties.Completed.date.start, '2026-07-07');
  assert.strictEqual(p.properties.Author.rich_text[0].text.content, 'A channel');
  assert.strictEqual(p.properties.Name.title[0].text.content, 'A video');
  assert.strictEqual(p.cover.external.url, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
});

test('buildPagePayload omits cover when no thumbnail', () => {
  const p = buildPagePayload({ dbId: 'db1', title: 't', channel: '', url: 'u', dateStr: '2026-07-07' });
  assert.strictEqual(p.cover, undefined);
});
