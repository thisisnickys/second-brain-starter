const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, filterItems, wordFreq, scoreItem, search, inWindow, onThisWeek } = require('../system/corpus.js');

// --- fixture: a tiny fake corpus root ---
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  fs.mkdirSync(path.join(tmp, 'indexes'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'raw', 'corpus', 'kit'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'raw', 'corpus', 'youtube'), { recursive: true });
  const items = [
    { id: 'kit-1', platform: 'kit', type: 'newsletter', title: 'Introvert systems for creators', date: '2024-07-10', word_count: 300, has_fulltext: true, file: 'raw/corpus/kit/a.md' },
    { id: 'kit-2', platform: 'kit', type: 'update', title: 'Weekly update', date: '2023-07-06', word_count: 120, has_fulltext: true, file: 'raw/corpus/kit/b.md' },
    { id: 'yt-1', platform: 'youtube', type: 'long', title: 'How I plan content', date: '2025-01-15', word_count: 900, has_fulltext: true, file: 'raw/corpus/youtube/c.md' },
    { id: 'yt-2', platform: 'youtube', type: 'short', title: 'Introvert energy hack', date: '', word_count: null, has_fulltext: false, file: null },
    { id: 'yt-3', platform: 'youtube', type: 'long', title: 'Missing file item about introvert life', date: '2022-07-08', word_count: 50, has_fulltext: true, file: 'raw/corpus/youtube/gone.md' },
  ];
  fs.writeFileSync(path.join(tmp, 'raw/corpus/kit/a.md'), 'Being an introvert is a superpower. Introvert introvert introvert introvert introvert introvert systems.');
  fs.writeFileSync(path.join(tmp, 'raw/corpus/kit/b.md'), 'Nothing relevant here, just a weekly update about the community.');
  fs.writeFileSync(path.join(tmp, 'raw/corpus/youtube/c.md'), 'One mention of introvert planning in the transcript.');
  // note: gone.md is intentionally NOT written (unreadable-file path)
  fs.writeFileSync(path.join(tmp, 'indexes', 'content-catalog.json'),
    JSON.stringify({ generated: '2026-07-08', platforms: {}, items }));
  return tmp;
}

// --- arg parsing ---
test('parseArgs: full flag set', () => {
  const o = parseArgs(['hello world', '--platform', 'kit', '--type', 'newsletter', '--limit', '3', '--since', '2024-02-01', '--json']);
  assert.deepStrictEqual(o, { query: 'hello world', platform: 'kit', type: 'newsletter', limit: 3, since: '2024-02-01', json: true, onthisweek: false, yearsBack: null });
});

test('parseArgs: defaults, bare-year since, onthisweek', () => {
  assert.strictEqual(parseArgs(['q']).limit, 10);
  assert.strictEqual(parseArgs(['q', '--since', '2024']).since, '2024-01-01');
  const o = parseArgs(['--onthisweek', '--years-back', '2']);
  assert.strictEqual(o.onthisweek, true);
  assert.strictEqual(o.yearsBack, 2);
  assert.strictEqual(o.query, null);
});

test('parseArgs: bad --limit keeps default', () => {
  assert.strictEqual(parseArgs(['q', '--limit', 'nope']).limit, 10);
});

// --- tokenizing / scoring ---
test('scoreItem: title match outweighs body-only match, body capped', () => {
  const tokens = ['introvert'];
  const titleHit = scoreItem(tokens, { title: 'Introvert systems' }, null);
  assert.strictEqual(titleHit, 5);
  const bodyOnly = scoreItem(tokens, { title: 'Other' }, wordFreq('introvert '.repeat(50)));
  assert.strictEqual(bodyOnly, 5); // 50 occurrences capped at 5
  const both = scoreItem(tokens, { title: 'Introvert systems' }, wordFreq('introvert introvert'));
  assert.strictEqual(both, 7);
  assert.strictEqual(scoreItem(['zebra'], { title: 'Introvert systems' }, wordFreq('introvert')), 0);
});

test('wordFreq counts whole words, not substrings', () => {
  const f = wordFreq('maintain the AI ai plan');
  assert.strictEqual(f.get('ai'), 2); // "maintain" does not count
});

// --- filters ---
test('filterItems: platform, type, since (empty date excluded by since)', () => {
  const items = [
    { platform: 'kit', type: 'update', date: '2024-05-01' },
    { platform: 'youtube', type: 'long', date: '' },
  ];
  assert.strictEqual(filterItems(items, { platform: 'kit' }).length, 1);
  assert.strictEqual(filterItems(items, { type: 'long' }).length, 1);
  assert.strictEqual(filterItems(items, { since: '2024-01-01' }).length, 1);
  assert.strictEqual(filterItems(items, {}).length, 2);
});

// --- search end-to-end on fixture ---
test('search: ranks title+body hit first, skips missing files without crashing', () => {
  const tmp = makeFixture();
  const r = search('introvert', { limit: 10 }, tmp);
  assert.strictEqual(r[0].id, 'kit-1'); // title (5) + capped body (5) = 10
  assert.strictEqual(r[0].score, 10);
  const ids = r.map(x => x.id);
  assert.ok(ids.includes('yt-2')); // fulltext-less item still matches on title
  assert.ok(ids.includes('yt-3')); // missing file: title score survives, no crash
  assert.ok(!ids.includes('kit-2'));
});

test('search: platform filter + limit + empty result', () => {
  const tmp = makeFixture();
  const kitOnly = search('introvert', { platform: 'kit', limit: 10 }, tmp);
  assert.deepStrictEqual(kitOnly.map(x => x.platform), ['kit']);
  assert.strictEqual(search('introvert', { limit: 1 }, tmp).length, 1);
  assert.deepStrictEqual(search('qqqzzznomatch', { limit: 10 }, tmp), []);
});

// --- onthisweek window logic ---
test('inWindow: within ±5 days of month/day, any year', () => {
  const today = new Date(2026, 6, 8); // Jul 8 2026
  assert.ok(inWindow('2024-07-10', today, 5));
  assert.ok(inWindow('2019-07-03', today, 5));
  assert.ok(!inWindow('2024-07-20', today, 5));
  assert.ok(!inWindow('', today, 5));
  assert.ok(!inWindow('not-a-date', today, 5));
});

test('inWindow: wraps the year boundary', () => {
  const today = new Date(2026, 0, 2); // Jan 2
  assert.ok(inWindow('2023-12-30', today, 5));
  assert.ok(inWindow('2024-01-05', today, 5));
  assert.ok(!inWindow('2023-12-20', today, 5));
});

test('onThisWeek: prior years only, years-back cutoff, sorted date desc', () => {
  const tmp = makeFixture();
  const today = new Date(2026, 6, 8); // Jul 8 2026
  const all = onThisWeek({ limit: 10 }, tmp, today);
  assert.deepStrictEqual(all.map(x => x.id), ['kit-1', 'kit-2', 'yt-3']); // Jul 10/06/08 of 2024/2023/2022
  const recent = onThisWeek({ limit: 10, yearsBack: 2 }, tmp, today);
  assert.deepStrictEqual(recent.map(x => x.id), ['kit-1']); // 2024 only (>= 2026-2)
  // current-year item excluded
  const cat = JSON.parse(fs.readFileSync(path.join(tmp, 'indexes/content-catalog.json'), 'utf8'));
  cat.items.push({ id: 'now-1', platform: 'kit', type: 'update', title: 'x', date: '2026-07-07', word_count: 1, has_fulltext: false, file: null });
  fs.writeFileSync(path.join(tmp, 'indexes/content-catalog.json'), JSON.stringify(cat));
  assert.ok(!onThisWeek({ limit: 10 }, tmp, today).some(x => x.id === 'now-1'));
});
