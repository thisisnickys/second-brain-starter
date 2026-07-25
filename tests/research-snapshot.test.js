'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isoWeek, weekSlug, extractRow, buildNote } =
  require('../system/ingest/research-snapshot.js');
const { noteErrors } = require('../system/lib/note-write.js');

// --- fixtures (fake Notion page objects, no network) ---------------------------
function fakePage(over) {
  return Object.assign({
    id: 'abc-123',
    created_time: '2026-07-05T14:22:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Kling 3.0 launched with ' }, { plain_text: 'native audio' }] },
      Pillar: { type: 'select', select: { name: 'Tools Curation' } },
      Score: { type: 'number', number: 8.5 },
      URL: { type: 'url', url: 'https://example.com/kling' },
    },
  }, over || {});
}

// --- ISO week slug ---------------------------------------------------------------
test('weekSlug: mid-year date', () => {
  // Jul 8 2026 is a Wednesday in ISO week 28
  assert.strictEqual(weekSlug(new Date(2026, 6, 8)), '2026-W28');
});

test('weekSlug: ISO week-year rollover (Dec 29 2025 belongs to 2026-W01)', () => {
  assert.strictEqual(weekSlug(new Date(2025, 11, 29)), '2026-W01');
});

test('weekSlug: Jan 1 in week 53 of prior ISO year (Jan 1 2027 -> 2026-W53)', () => {
  assert.strictEqual(weekSlug(new Date(2027, 0, 1)), '2026-W53');
});

test('isoWeek: pads single-digit weeks in slug', () => {
  const { week } = isoWeek(new Date(2026, 0, 7));
  assert.strictEqual(week, 2);
  assert.strictEqual(weekSlug(new Date(2026, 0, 7)), '2026-W02');
});

// --- row extraction ----------------------------------------------------------------
test('extractRow: pulls title, pillar, score, url, created', () => {
  const r = extractRow(fakePage());
  assert.strictEqual(r.title, 'Kling 3.0 launched with native audio');
  assert.strictEqual(r.pillar, 'Tools Curation');
  assert.strictEqual(r.score, 8.5);
  assert.strictEqual(r.url, 'https://example.com/kling');
  assert.strictEqual(r.created, '2026-07-05');
});

test('extractRow: multi_select pillar and missing optionals', () => {
  const r = extractRow(fakePage({
    properties: {
      Title: { type: 'title', title: [{ plain_text: 'Bare row' }] },
      Category: { type: 'multi_select', multi_select: [{ name: 'News' }, { name: 'AI' }] },
    },
  }));
  assert.strictEqual(r.title, 'Bare row');
  assert.strictEqual(r.pillar, 'News, AI');
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.url, '');
});

test('extractRow: untitled + empty page never crashes', () => {
  assert.strictEqual(extractRow({}).title, '(untitled)');
  assert.strictEqual(extractRow({ properties: {} }).pillar, '');
});

// --- note building ------------------------------------------------------------------
test('buildNote: null on zero rows (no empty notes)', () => {
  assert.strictEqual(buildNote([], { slug: '2026-W28', today: '2026-07-08' }), null);
  assert.strictEqual(buildNote(null, { slug: '2026-W28', today: '2026-07-08' }), null);
});

test('buildNote: groups by pillar, formats bullets + excerpt, lints clean', () => {
  const rows = [
    Object.assign(extractRow(fakePage()), { excerpt: 'Native audio changes the game for creators.' }),
    Object.assign(extractRow(fakePage({
      properties: { Name: { type: 'title', title: [{ plain_text: 'No pillar row' }] } },
    })), { excerpt: '' }),
  ];
  const note = buildNote(rows, { slug: '2026-W28', today: '2026-07-08' });
  assert.ok(note.includes('title: Research Intel 2026-W28'));
  assert.ok(note.includes('updated: 2026-07-08'));
  assert.ok(note.includes('## Tools Curation'));
  assert.ok(note.includes('- 2026-07-05 — Kling 3.0 launched with native audio (score 8.5) https://example.com/kling'));
  assert.ok(note.includes('\n  Native audio changes the game for creators.'));
  assert.ok(note.includes('## Uncategorized'));
  // Uncategorized always sorts last
  assert.ok(note.indexOf('## Tools Curation') < note.indexOf('## Uncategorized'));
  // must pass the frontmatter lint (lint-gated wiki write)
  assert.deepStrictEqual(noteErrors(note), []);
});

test('buildNote: score 0 is still shown, missing url omitted', () => {
  const rows = [Object.assign(extractRow(fakePage({
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Zero score' }] },
      Score: { type: 'number', number: 0 },
    },
  })), { excerpt: '' })];
  const note = buildNote(rows, { slug: '2026-W28', today: '2026-07-08' });
  assert.ok(note.includes('- 2026-07-05 — Zero score (score 0)\n'));
  assert.deepStrictEqual(noteErrors(note), []);
});
