const { test } = require('node:test');
const assert = require('node:assert');

const {
  findSocialUrl,
  canonicalSocialUrl,
  buildSocialMeta,
  buildDistillPrompt,
  buildWikiNote
} = require('../system/telegram/social.js');
const { classify } = require('../system/telegram/bot.js');

/* ----------------------------- findSocialUrl ---------------------------- */

test('findSocialUrl: instagram reel with share params', () => {
  const r = findSocialUrl('https://www.instagram.com/reel/DZLDPGExR-1/?igsh=MTdwMTNkemE2ZDQ2OA==');
  assert.ok(r);
  assert.strictEqual(r.platform, 'instagram');
  assert.strictEqual(r.id, 'DZLDPGExR-1');
});

test('findSocialUrl: instagram /p/ and /reels/ and /tv/ forms', () => {
  assert.strictEqual(findSocialUrl('https://instagram.com/p/Cabc123_xy/').id, 'Cabc123_xy');
  assert.strictEqual(findSocialUrl('https://www.instagram.com/reels/DZLDPGExR-1/').id, 'DZLDPGExR-1');
  assert.strictEqual(findSocialUrl('https://www.instagram.com/tv/Babc123/').platform, 'instagram');
});

test('findSocialUrl: tiktok full video URL', () => {
  const r = findSocialUrl('https://www.tiktok.com/@somecreator/video/7301234567890123456');
  assert.ok(r);
  assert.strictEqual(r.platform, 'tiktok');
  assert.strictEqual(r.id, '7301234567890123456');
});

test('findSocialUrl: tiktok short links (vm/vt/t) match with null id', () => {
  const vm = findSocialUrl('https://vm.tiktok.com/ZMabcdef/');
  assert.ok(vm);
  assert.strictEqual(vm.platform, 'tiktok');
  assert.strictEqual(vm.id, null);
  assert.ok(findSocialUrl('https://vt.tiktok.com/ZSabcdef/'));
  assert.ok(findSocialUrl('https://www.tiktok.com/t/ZTabcdef/'));
});

test('findSocialUrl: URL embedded in a sentence is still found', () => {
  const r = findSocialUrl('check this out https://www.instagram.com/reel/DZLDPGExR-1/?igsh=xyz so good');
  assert.ok(r);
  assert.strictEqual(r.id, 'DZLDPGExR-1');
});

test('findSocialUrl: profile pages, YouTube, plain text return null', () => {
  assert.strictEqual(findSocialUrl('https://www.instagram.com/patrickwithprospectflo/'), null);
  assert.strictEqual(findSocialUrl('https://www.tiktok.com/@somecreator'), null);
  assert.strictEqual(findSocialUrl('https://youtu.be/VoKiKvgpk78'), null);
  assert.strictEqual(findSocialUrl('what should I post on instagram'), null);
  assert.strictEqual(findSocialUrl(''), null);
  assert.strictEqual(findSocialUrl(null), null);
});

/* --------------------------- canonicalSocialUrl ------------------------- */

test('canonicalSocialUrl: instagram reel strips params, keeps id form', () => {
  assert.strictEqual(
    canonicalSocialUrl({ platform: 'instagram', id: 'DZLDPGExR-1' }),
    'https://www.instagram.com/reel/DZLDPGExR-1/'
  );
});

test('canonicalSocialUrl: tiktok uses @user form when known, /video/ fallback', () => {
  assert.strictEqual(
    canonicalSocialUrl({ platform: 'tiktok', id: '7301234567890123456', user: 'somecreator' }),
    'https://www.tiktok.com/@somecreator/video/7301234567890123456'
  );
  assert.strictEqual(
    canonicalSocialUrl({ platform: 'tiktok', id: '7301234567890123456' }),
    'https://www.tiktok.com/video/7301234567890123456'
  );
});

/* ------------------------------ buildSocialMeta -------------------------- */

test('buildSocialMeta: instagram yt-dlp JSON with generic title and null description', () => {
  const m = buildSocialMeta({
    id: 'DZLDPGExR-1',
    title: 'Video by patrickwithprospectflo',
    description: null,
    uploader: 'Patrick Minardi (Prospectflo)',
    channel: 'patrickwithprospectflo',
    thumbnail: 'https://scontent.cdninstagram.com/thumb.jpg',
    duration: 44.8
  }, 'instagram');
  assert.strictEqual(m.id, 'DZLDPGExR-1');
  assert.strictEqual(m.title, 'Video by patrickwithprospectflo');
  assert.strictEqual(m.channel, 'Patrick Minardi (Prospectflo)');
  assert.strictEqual(m.url, 'https://www.instagram.com/reel/DZLDPGExR-1/');
  assert.strictEqual(m.thumbnail, 'https://scontent.cdninstagram.com/thumb.jpg');
  assert.strictEqual(m.durationSec, 44.8);
  assert.strictEqual(m.platform, 'instagram');
});

test('buildSocialMeta: generic "Video by" title upgraded from description first line', () => {
  const m = buildSocialMeta({
    id: 'Cabc123',
    title: 'Video by someone',
    description: 'How I book 20 sales calls a week with one automation.\nMore below…',
    uploader: 'Someone',
    duration: 30
  }, 'instagram');
  assert.strictEqual(m.title, 'How I book 20 sales calls a week with one automation.');
});

test('buildSocialMeta: long description first line is capped for the title', () => {
  const m = buildSocialMeta({
    id: 'X', title: 'Video by x', description: 'y'.repeat(200), uploader: 'x', duration: 5
  }, 'instagram');
  assert.ok(m.title.length <= 80);
});

test('buildSocialMeta: tiktok keeps its caption title and builds tiktok URL', () => {
  const m = buildSocialMeta({
    id: '7301234567890123456',
    title: 'my morning routine as a founder',
    uploader: 'somecreator',
    duration: 61
  }, 'tiktok');
  assert.strictEqual(m.title, 'my morning routine as a founder');
  assert.strictEqual(m.url, 'https://www.tiktok.com/@somecreator/video/7301234567890123456');
  assert.strictEqual(m.platform, 'tiktok');
});

/* --------------------------- prompt + note builders ---------------------- */

test('buildDistillPrompt names the platform and embeds the transcript', () => {
  const meta = { title: 'T', channel: 'C', url: 'https://www.instagram.com/reel/X/', platform: 'instagram' };
  const p = buildDistillPrompt(meta, 'the transcript body');
  assert.ok(/instagram/i.test(p));
  assert.ok(p.includes('the transcript body'));
  assert.ok(p.includes('https://www.instagram.com/reel/X/'));
});

test('buildDistillPrompt caps a huge transcript', () => {
  const meta = { title: 'T', channel: 'C', url: 'u', platform: 'tiktok' };
  const p = buildDistillPrompt(meta, 'x'.repeat(200000));
  assert.ok(p.length < 120000);
  assert.ok(p.includes('[transcript truncated]'));
});

test('buildWikiNote carries platform label, source url and transcript path', () => {
  const note = buildWikiNote({
    meta: { title: 'Reel title', channel: 'Patrick', url: 'https://www.instagram.com/reel/X/', platform: 'instagram' },
    distill: { title: 'Prospecting automation', department: 'business', tags: ['sales'], takeaway: 't', apply: 'a', notes_md: '## Core ideas\n- one' },
    dateStr: '2026-07-11',
    transcriptRelPath: 'raw/transcripts/2026-07-11-prospecting-automation.md'
  });
  assert.ok(note.includes('title: Prospecting automation'));
  assert.ok(note.includes('department: business'));
  assert.ok(note.includes('source: capture:https://www.instagram.com/reel/X/'));
  assert.ok(/instagram/i.test(note));
  assert.ok(note.includes('raw/transcripts/2026-07-11-prospecting-automation.md'));
  assert.ok(note.includes('updated: 2026-07-11'));
});

/* ------------------------------ bot routing ------------------------------ */

test('classify: instagram and tiktok links route to social capture', () => {
  assert.strictEqual(classify('https://www.instagram.com/reel/DZLDPGExR-1/?igsh=xyz').kind, 'social');
  assert.strictEqual(classify('https://www.tiktok.com/@x/video/7301234567890123456').kind, 'social');
  assert.strictEqual(classify('https://vm.tiktok.com/ZMabcdef/').kind, 'social');
});

test('classify: youtube still wins its own route, articles still route web', () => {
  assert.strictEqual(classify('https://youtu.be/VoKiKvgpk78').kind, 'youtube');
  assert.strictEqual(classify('https://example.com/some-article').kind, 'web');
});
