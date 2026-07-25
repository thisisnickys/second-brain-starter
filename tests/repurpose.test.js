const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PILLARS, parseArgs, loadUsedIds, markUsed, monthsOld, recencyWeight,
  pillarTier, gapTier, gapTokens, clusterTier, buildQueue, renderNote, writeQueueNote,
} = require('../system/repurpose.js');
const { noteErrors } = require('../system/lib/note-write.js');

const TODAY = new Date(2026, 6, 8); // Jul 8 2026, local

function item(overrides) {
  return Object.assign({
    id: 'x', platform: 'kit', type: 'newsletter', title: 't',
    date: '2024-01-01', word_count: 100, has_fulltext: true, file: 'raw/corpus/kit/x.md',
  }, overrides);
}

// --- fixture: temp catalog root ---
function makeFixture(items) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repurpose-'));
  fs.mkdirSync(path.join(tmp, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'indexes', 'content-catalog.json'),
    JSON.stringify({ generated: '2026-07-08', platforms: {}, items }));
  return tmp;
}

// --- arg parsing ---
test('parseArgs: flags', () => {
  assert.deepStrictEqual(parseArgs([]), { json: false, write: false, markUsed: null });
  assert.deepStrictEqual(parseArgs(['--json', '--write']), { json: true, write: true, markUsed: null });
});

// --- date math ---
test('monthsOld: whole local months, null on bad dates', () => {
  assert.strictEqual(monthsOld('2025-07-08', TODAY), 12);
  assert.strictEqual(monthsOld('2025-07-09', TODAY), 11); // one day shy of 12 months
  assert.strictEqual(monthsOld('2026-07-01', TODAY), 0);
  assert.strictEqual(monthsOld('', TODAY), null);
  assert.strictEqual(monthsOld('nope', TODAY), null);
});

test('recencyWeight: 1-3 years flat, then decays', () => {
  assert.strictEqual(recencyWeight(1), 1);
  assert.strictEqual(recencyWeight(3), 1);
  assert.ok(recencyWeight(10) < recencyWeight(4));
  assert.ok(recencyWeight(4) < 1);
});

// --- Tier 1: pillar matching + age filter ---
test('pillarTier: matches pillars, enforces 12-month age + has_fulltext, prefers 1-3yr over 10yr', () => {
  const items = [
    item({ id: 'young', title: 'My favorite AI tool ever', date: '2026-05-01' }),          // too young
    item({ id: 'nofull', title: 'The AI tool that changed me', date: '2024-05-01', has_fulltext: false }), // no fulltext
    item({ id: 'sweet', title: 'ChatGPT automation workflow for creators', date: '2024-05-01' }),  // ~2yrs
    item({ id: 'old', title: 'ChatGPT automation workflow for creators', date: '2016-05-01' }),    // ~10yrs, same title
    item({ id: 'intro', title: 'Introvert burnout confessions', date: '2023-08-01' }),
    item({ id: 'thin', title: 'Introverted?', date: '2023-08-01' }), // <3 title tokens = not evergreen material
    item({ id: 'nomatch', title: 'Random musings about sparring', date: '2023-08-01' }),
  ];
  const t1 = pillarTier(items, TODAY);
  const aiIds = t1['ai-tools'].map(c => c.id);
  assert.ok(!aiIds.includes('young'), 'items <12 months old excluded');
  assert.ok(!aiIds.includes('nofull'), 'items without fulltext excluded');
  assert.ok(aiIds.includes('sweet') && aiIds.includes('old'));
  assert.ok(aiIds.indexOf('sweet') < aiIds.indexOf('old'), '2yr-old ranks above 10yr-old at same density');
  assert.deepStrictEqual(t1['creator-identity'].map(c => c.id), ['intro'], 'thin one-word title excluded');
  assert.deepStrictEqual(t1['community'], []);
  for (const cands of Object.values(t1)) assert.ok(cands.length <= 5);
});

test('pillarTier: top 5 per pillar cap', () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    items.push(item({ id: 'ai' + i, title: `AI tool number ${i} review`, date: `2023-0${(i % 8) + 1}-15` }));
  }
  const t1 = pillarTier(items, TODAY);
  assert.strictEqual(t1['ai-tools'].length, 5);
});

// --- Tier 3: cross-platform gap detection ---
test('gapTier: youtube-long with no 2-token topic overlap in kit/threads is a gap', () => {
  const items = [
    item({ id: 'yt-gap', platform: 'youtube', type: 'long', title: 'Quantum blogging masterclass secrets', date: '2025-06-01' }),
    item({ id: 'yt-crossed', platform: 'youtube', type: 'long', title: 'Thumbnail psychology explained', date: '2025-06-01' }),
    item({ id: 'yt-young', platform: 'youtube', type: 'long', title: 'Zorbified xylophone economics', date: '2026-06-01' }), // <6 months
    item({ id: 'yt-short', platform: 'youtube', type: 'short', title: 'Unrelated flurble content', date: '2025-06-01' }),   // wrong type
    item({ id: 'threads-1', platform: 'threads', type: 'post', title: 'thumbnail psychology tips for reels', date: '2025-01-01' }),
  ];
  const gaps = gapTier(items, TODAY);
  const ids = gaps.map(g => g.id);
  assert.ok(ids.includes('yt-gap'));
  assert.ok(!ids.includes('yt-crossed'), '"thumbnail psychology" already covered on threads');
  assert.ok(!ids.includes('yt-young'), '<6 months old excluded');
  assert.ok(!ids.includes('yt-short'), 'only youtube-long checked');
  assert.strictEqual(gaps.find(g => g.id === 'yt-gap').direction, 'youtube → kit/threads');
});

test('gapTier: single shared token is coincidence, not a crossing', () => {
  const items = [
    item({ id: 'yt-1', platform: 'youtube', type: 'long', title: 'Thumbnail secrets nobody teaches', date: '2025-06-01' }),
    item({ id: 'threads-1', platform: 'threads', type: 'post', title: 'thumbnail tips for reels', date: '2025-01-01' }), // shares only "thumbnail"
  ];
  assert.ok(gapTier(items, TODAY).some(g => g.id === 'yt-1'));
});

test('gapTier: reverse direction — kit-newsletter never made into youtube', () => {
  const items = [
    item({ id: 'kit-gap', platform: 'kit', type: 'newsletter', title: 'Pricing psychology deepdive nobody asked', date: '2025-09-01' }),
    item({ id: 'kit-crossed', platform: 'kit', type: 'newsletter', title: 'Thumbnail breakdown issue', date: '2025-09-01' }),
    item({ id: 'kit-update', platform: 'kit', type: 'update', title: 'Gribble frobnicate zanzibar', date: '2025-09-01' }), // wrong type
    item({ id: 'yt-1', platform: 'youtube', type: 'long', title: 'thumbnail breakdown formula video', date: '2024-01-01' }),
  ];
  const gaps = gapTier(items, TODAY);
  const ids = gaps.map(g => g.id);
  assert.ok(ids.includes('kit-gap'));
  assert.ok(!ids.includes('kit-crossed'), '"thumbnail breakdown" already a youtube video');
  assert.ok(!ids.includes('kit-update'), 'only kit-newsletter checked in reverse');
  assert.strictEqual(gaps.find(g => g.id === 'kit-gap').direction, 'kit → youtube');
});

test('gapTokens: min length 4, stopwords already dropped', () => {
  assert.deepStrictEqual(gapTokens('The Big AI Quantum Leap'), ['quantum', 'leap']);
});

// --- Tier 4: compilation clusters ---
test('clusterTier: needs 5+ items, 2+ platforms, 2+ years; reports counts + span', () => {
  const clusterable = [
    item({ id: 'c1', platform: 'kit', title: 'Repurposing your content', date: '2022-01-01' }),
    item({ id: 'c2', platform: 'threads', type: 'post', title: 'repurposing tips', date: '2023-01-01' }),
    item({ id: 'c3', platform: 'threads', type: 'post', title: 'more repurposing thoughts', date: '2023-06-01' }),
    item({ id: 'c4', platform: 'youtube', type: 'long', title: 'Repurposing masterclass', date: '2024-01-01' }),
    item({ id: 'c5', platform: 'kit', title: 'the repurposing engine', date: '2025-01-01' }),
    // "sparring": 5 items but a single platform -> excluded
    ...[1, 2, 3, 4, 5].map(i => item({ id: 's' + i, platform: 'instagram', type: 'image', title: `sparring session ${i}`, date: `202${i}-01-01` })),
    // "elephant": 2 platforms but only 4 items -> excluded
    ...[1, 2, 3, 4].map(i => item({ id: 'e' + i, platform: i % 2 ? 'kit' : 'threads', type: 'post', title: `elephant story ${i}`, date: `202${i}-01-01` })),
    // "zebra": 5 items, 2 platforms, single year -> excluded
    ...[1, 2, 3, 4, 5].map(i => item({ id: 'z' + i, platform: i % 2 ? 'kit' : 'threads', type: 'post', title: `zebra thing ${i}`, date: `2024-0${i}-01` })),
  ];
  const clusters = clusterTier(clusterable);
  const themes = clusters.map(c => c.theme);
  assert.ok(themes.includes('repurposing'));
  assert.ok(!themes.includes('sparring'), 'single-platform token excluded');
  assert.ok(!themes.includes('elephant'), '<5 items excluded');
  assert.ok(!themes.includes('zebra'), 'single-year token excluded');
  const rep = clusters.find(c => c.theme === 'repurposing');
  assert.strictEqual(rep.count, 5);
  assert.strictEqual(rep.yearSpan, '2022–2025');
  assert.deepStrictEqual(rep.platforms, ['kit', 'threads', 'youtube']);
  assert.ok(rep.sample.length <= 3);
});

test('clusterTier: short tokens (<5 chars) and generic filler words never cluster', () => {
  const short = [1, 2, 3, 4, 5].map(i =>
    item({ id: 'a' + i, platform: i % 2 ? 'kit' : 'youtube', type: 'long', title: `nice idea ${i}`, date: `202${i}-01-01` }));
  assert.deepStrictEqual(clusterTier(short), []);
  const generic = [1, 2, 3, 4, 5].map(i =>
    item({ id: 'g' + i, platform: i % 2 ? 'kit' : 'youtube', type: 'long', title: `because something ${i}`, date: `202${i}-01-01` }));
  assert.deepStrictEqual(clusterTier(generic), []);
});

test('clusterTier: tokens in more than 1% of a large catalog are too generic', () => {
  const items = [];
  for (let i = 0; i < 11; i++) { // 11 "penguin" items over 1000 total -> above the 1% cap (10)
    items.push(item({ id: 'p' + i, platform: i % 2 ? 'kit' : 'youtube', type: 'long', title: `penguin move ${i}`, date: `20${15 + (i % 5)}-01-01` }));
  }
  for (let i = 0; i < 990; i++) {
    items.push(item({ id: 'f' + i, platform: 'threads', type: 'post', title: `filler${i}`, date: '2024-01-01' }));
  }
  assert.deepStrictEqual(clusterTier(items), []);
  // at 10 items (exactly 1%) the same cluster survives
  assert.deepStrictEqual(clusterTier(items.filter(it => it.id !== 'p10')).map(c => c.theme), ['penguin']);
});

// --- used-ids skipping ---
test('used ids: loadUsedIds tolerates missing file; markUsed dedupes; buildQueue skips them', () => {
  const items = [
    item({ id: 'used-one', title: 'Introvert burnout mindset', date: '2024-05-01' }),
    item({ id: 'kept-one', title: 'Introvert confidence journey', date: '2024-05-01' }),
  ];
  const tmp = makeFixture(items);
  assert.deepStrictEqual(loadUsedIds(tmp), new Set()); // file absent = empty
  markUsed(tmp, ['used-one']);
  markUsed(tmp, ['used-one']); // dedupe
  assert.deepStrictEqual(Array.from(loadUsedIds(tmp)), ['used-one']);
  const q = buildQueue(tmp, TODAY);
  const ids = q.tier1['creator-identity'].map(c => c.id);
  assert.ok(ids.includes('kept-one'));
  assert.ok(!ids.includes('used-one'));
});

// --- note format ---
test('renderNote: lints clean and carries the header + tiers', () => {
  const tmp = makeFixture([
    item({ id: 'n1', title: 'Introvert burnout story', date: '2024-05-01' }),
    item({ id: 'n2', platform: 'youtube', type: 'long', title: 'Xylozorp flimflam economics', date: '2025-01-01' }),
  ]);
  const q = buildQueue(tmp, TODAY);
  const note = renderNote(q);
  assert.deepStrictEqual(noteErrors(note), [], 'generated note must pass the frontmatter lint');
  assert.ok(note.includes('title: Repurpose Queue'));
  assert.ok(note.includes(`Generated ${q.generated} — candidates only; you decide.`));
  assert.ok(note.includes('## Tier 1 — Pillar-match evergreen'));
  assert.ok(note.includes('## Tier 3 — Cross-platform gaps'));
  assert.ok(note.includes('## Tier 4 — Compilation clusters'));
  assert.ok(note.includes('- [kit-newsletter · 2024-05-01] Introvert burnout story — raw/corpus/kit/x.md'));
});

test('writeQueueNote: overwrites in place (generated surface, not history)', () => {
  const tmp = makeFixture([item({ id: 'w1', title: 'Introvert systems talk', date: '2024-05-01' })]);
  const q = buildQueue(tmp, TODAY);
  const p1 = writeQueueNote(tmp, q);
  const p2 = writeQueueNote(tmp, q); // second run must NOT create queue-2.md
  assert.strictEqual(p1, p2);
  assert.strictEqual(p1, path.join(tmp, 'wiki', 'content', 'repurpose', 'queue.md'));
  assert.ok(fs.existsSync(p1));
  assert.ok(!fs.existsSync(path.join(tmp, 'wiki', 'content', 'repurpose', 'queue-2.md')));
});

// --- pillar map sanity ---
test('PILLARS: contains the four pillars', () => {
  assert.deepStrictEqual(Object.keys(PILLARS).sort(),
    ['ai-tools', 'community', 'creator-identity', 'creator-systems']);
});
