const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findYouTubeUrl,
  parseVtt,
  wikiHasVideoId,
  parseDistill,
  buildWikiNote,
  buildTranscriptDoc
} = require('../system/telegram/youtube.js');
const { parseRemember, buildRememberNote } = require('../system/telegram/remember.js');
const { noteErrors } = require('../system/lib/note-write.js');
const { slugify } = require('../system/lib/text.js');

/* ---------------------------- findYouTubeUrl ---------------------------- */

test('findYouTubeUrl: standard watch URL', () => {
  const r = findYouTubeUrl('https://www.youtube.com/watch?v=VoKiKvgpk78');
  assert.ok(r);
  assert.strictEqual(r.id, 'VoKiKvgpk78');
});

test('findYouTubeUrl: youtu.be short link with share params', () => {
  const r = findYouTubeUrl('https://youtu.be/VoKiKvgpk78?si=abc123');
  assert.ok(r);
  assert.strictEqual(r.id, 'VoKiKvgpk78');
});

test('findYouTubeUrl: shorts and live URLs', () => {
  assert.strictEqual(findYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
  assert.strictEqual(findYouTubeUrl('https://www.youtube.com/live/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
});

test('findYouTubeUrl: URL embedded in a sentence is still found', () => {
  const r = findYouTubeUrl('watch this later https://youtu.be/VoKiKvgpk78 so good');
  assert.ok(r);
  assert.strictEqual(r.id, 'VoKiKvgpk78');
});

test('findYouTubeUrl: non-YouTube URLs and plain text return null', () => {
  assert.strictEqual(findYouTubeUrl('https://vimeo.com/12345'), null);
  assert.strictEqual(findYouTubeUrl('what is my youtube strategy'), null);
  assert.strictEqual(findYouTubeUrl(''), null);
  assert.strictEqual(findYouTubeUrl(null), null);
});

/* -------------------------------- parseVtt ------------------------------ */

test('parseVtt strips headers, timings, tags and rolling duplicates', () => {
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    '00:00:00.000 --> 00:00:02.000 align:start position:0%',
    'hello<00:00:00.480><c> world</c>',
    '',
    '00:00:02.000 --> 00:00:04.000',
    'hello world',
    'this is a test',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'this is a test',
    'of captions'
  ].join('\n');
  // "hello world" repeats across cues (rolling captions) → deduped; same for "this is a test".
  assert.strictEqual(parseVtt(vtt), 'hello world this is a test of captions');
});

test('parseVtt dedupes consecutive identical cue lines', () => {
  const vtt = [
    'WEBVTT', '',
    '00:00:00.000 --> 00:00:02.000', 'same line', '',
    '00:00:02.000 --> 00:00:04.000', 'same line', '',
    '00:00:04.000 --> 00:00:06.000', 'new line'
  ].join('\n');
  assert.strictEqual(parseVtt(vtt), 'same line new line');
});

test('parseVtt handles empty/garbage input', () => {
  assert.strictEqual(parseVtt(''), '');
  assert.strictEqual(parseVtt(null), '');
  assert.strictEqual(parseVtt('WEBVTT'), '');
});

/* ------------------------------ parseDistill ---------------------------- */

const GOOD_DISTILL = {
  title: 'Test video note',
  department: 'content',
  tags: ['Thumbnails', 'ctr testing'],
  takeaway: 'Do the thing.',
  notes_md: '## Core ideas\n- one\n\n## Quotes\n> a quote',
  apply: 'Apply it tomorrow.'
};

test('parseDistill: clean JSON passes through, tags get slugified', () => {
  const d = parseDistill(JSON.stringify(GOOD_DISTILL));
  assert.strictEqual(d.title, 'Test video note');
  assert.deepStrictEqual(d.tags, ['thumbnails', 'ctr-testing']);
});

test('parseDistill: tolerates code fences and prose around the JSON', () => {
  const wrapped = 'Sure! Here it is:\n```json\n' + JSON.stringify(GOOD_DISTILL) + '\n```\nDone.';
  assert.strictEqual(parseDistill(wrapped).title, 'Test video note');
});

test('parseDistill: invalid department falls back to content', () => {
  const d = parseDistill(JSON.stringify({ ...GOOD_DISTILL, department: 'nonsense' }));
  assert.strictEqual(d.department, 'content');
});

test('parseDistill: throws on missing JSON or missing keys', () => {
  assert.throws(() => parseDistill('no json here'));
  assert.throws(() => parseDistill(JSON.stringify({ title: 'x' })));
});

/* --------------------------- note builders lint ------------------------- */

const META = {
  id: 'abc123def45',
  title: 'How I Built a Second Brain',
  channel: 'Some Channel',
  url: 'https://www.youtube.com/watch?v=abc123def45',
  thumbnail: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg'
};

test('buildWikiNote output passes the frontmatter lint', () => {
  const d = parseDistill(JSON.stringify(GOOD_DISTILL));
  const md = buildWikiNote({ meta: META, distill: d, dateStr: '2026-07-07', transcriptRelPath: 'raw/transcripts/x.md' });
  assert.deepStrictEqual(noteErrors(md), []);
  assert.ok(md.includes('## Apply'));
  assert.ok(md.includes(META.url));
});

test('buildWikiNote with empty tags still lints (fallback tag)', () => {
  const d = parseDistill(JSON.stringify({ ...GOOD_DISTILL, tags: [] }));
  const md = buildWikiNote({ meta: META, distill: d, dateStr: '2026-07-07', transcriptRelPath: 'raw/transcripts/x.md' });
  assert.deepStrictEqual(noteErrors(md), []);
});

test('buildTranscriptDoc embeds source and transcript', () => {
  const doc = buildTranscriptDoc({ meta: META, dateStr: '2026-07-07', transcript: 'word one two' });
  assert.ok(doc.includes(META.url));
  assert.ok(doc.includes('word one two'));
});

/* ----------------------------- wikiHasVideoId --------------------------- */

test('wikiHasVideoId matches the id in any source URL form, only in source lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-dup-'));
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'content', 'a.md'),
    '---\ntitle: A\nsource: capture:https://youtu.be/VoKiKvgpk78\n---\nbody');
  fs.writeFileSync(path.join(dir, 'content', 'b.md'),
    '---\ntitle: B\nsource: telegram:remember\n---\nmentions dQw4w9WgXcQ only in the body');
  assert.strictEqual(wikiHasVideoId('VoKiKvgpk78', dir), true);  // youtu.be form matches
  assert.strictEqual(wikiHasVideoId('dQw4w9WgXcQ', dir), false); // body mention doesn't count
  assert.strictEqual(wikiHasVideoId('', dir), false);
  assert.strictEqual(wikiHasVideoId('abc', path.join(dir, 'missing')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------- remember ------------------------------- */

test('parseRemember: invalid department falls back to personal', () => {
  const r = parseRemember(JSON.stringify({ title: 'A fact', department: 'x', tags: [], note_md: 'The fact.' }));
  assert.strictEqual(r.department, 'personal');
});

test('buildRememberNote output passes the frontmatter lint', () => {
  const parsed = parseRemember(JSON.stringify({
    title: 'Parking spot at the gym',
    department: 'personal',
    tags: ['gym'],
    note_md: 'Parked on level 3, row C.'
  }));
  const md = buildRememberNote({ parsed, original: 'remember I parked on level 3 row C', dateStr: '2026-07-07' });
  assert.deepStrictEqual(noteErrors(md), []);
  assert.ok(md.includes('level 3, row C'));
});

/* -------------------------------- slugify ------------------------------- */

test('slugify: lowercases, hyphenates, trims, never empty', () => {
  assert.strictEqual(slugify("How I Built a $10K/mo System!"), 'how-i-built-a-10k-mo-system');
  assert.strictEqual(slugify('  '), 'untitled');
  const long = slugify('x'.repeat(100));
  assert.ok(long.length <= 60);
});
