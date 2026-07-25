'use strict';
// Jul 22 2026 audit feature wave: reflection mining (people + system asks),
// system-ask queueing + dedupe, related-capture linking, Night Shift Phase 4
// reactions, morning-brief staleness nudges, repurpose --mark-used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseExtract, buildReflectionPrompt, buildJournalPrompt } = require('../system/telegram/reflection-extract.js');
const { queueSkillRequest, hasSimilarRequest } = require('../system/telegram/skill-request.js');
const { tokens, findRelated, linkRelated } = require('../system/lib/related-notes.js');
const { appendSparks, markSent, recordReaction, promoteSpark } = require('../system/nightshift/ledger.js');
const { pulseStaleness, researchStaleness } = require('../system/telegram/morning-brief.js');
const { parseArgs: repurposeArgs } = require('../system/repurpose.js');
const { noteErrors } = require('../system/lib/note-write.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-feat-'));

/* ------------------------- reflection extraction ------------------------- */

test('parseExtract keeps real people and asks, drops junk', () => {
  const out = parseExtract(JSON.stringify({
    people: [
      { name: 'Mom', context: 'long phone call' },
      { name: 'Jordan', context: 'lock-in planning' },
      { name: 'nobody', context: 'x' },
      { name: 'her', context: 'x' },
      { name: 'DROP TABLE;--', context: 'x' }
    ],
    system_asks: [
      'Ask me the connect question every night in the evening report',
      'short',
      'x'.repeat(400)
    ]
  }));
  assert.deepStrictEqual(out.people.map(p => p.name), ['Mom', 'Jordan']);
  assert.deepStrictEqual(out.system_asks, ['Ask me the connect question every night in the evening report']);
});

test('parseExtract returns empty on junk output', () => {
  assert.deepStrictEqual(parseExtract('no json at all'), { people: [], system_asks: [] });
  assert.deepStrictEqual(parseExtract('{"people": "nope"}'), { people: [], system_asks: [] });
});

test('prompts embed the source text', () => {
  assert.ok(buildReflectionPrompt('Who did you connect with today?', 'Mom and Connie').includes('Mom and Connie'));
  assert.ok(buildJournalPrompt('fix the brain to track sauna').includes('sauna'));
});

/* --------------------- system-ask queue + dedupe --------------------- */

test('queueSkillRequest kind system-ask writes the system-ask shape', () => {
  const dir = path.join(tmp(), 'skill-requests');
  const r = queueSkillRequest('Track my sauna sessions in the health note', null,
    { dir, dateStr: '2026-07-22', kind: 'system-ask', source: 'notion journal' });
  const text = fs.readFileSync(r.path, 'utf8');
  assert.match(text, /^kind: system-ask$/m);
  assert.match(text, /# System ask — /);
  assert.match(text, /SECOND BRAIN ITSELF/);
  assert.match(text, /\*\*Source:\*\* notion journal/);
  assert.match(text, /^status: pending$/m);
});

test('hasSimilarRequest catches re-mined asks, misses fresh ones', () => {
  const dir = path.join(tmp(), 'skill-requests');
  queueSkillRequest('Ask me the connect question every night', null, { dir, dateStr: '2026-07-21', kind: 'system-ask' });
  assert.strictEqual(hasSimilarRequest('ask the connect question at night please', { dir }), true);
  assert.strictEqual(hasSimilarRequest('build a carousel clipper for vertical video', { dir }), false);
  assert.strictEqual(hasSimilarRequest('', { dir }), false);
});

/* ------------------------- related-note linking ------------------------- */

function seedLearning(root, rel, title) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\ntitle: ${title}\ndepartment: content\nupdated: 2026-07-10\n---\n\nbody\n`);
}

test('findRelated links the GPT-5.6 fragmentation case, skips unrelated', () => {
  const root = tmp();
  seedLearning(root, 'wiki/content/learning/2026-07-08-gpt56-launch.md',
    'OpenAI launching GPT-5.6 Sol, Terra, and Luna this Thursday');
  seedLearning(root, 'wiki/content/learning/2026-07-09-clipper-styles.md',
    'Clipper caption styles for retention');
  const hit = findRelated('GPT-5.6 Launch — Agentic Coding Deep Dive', root);
  assert.ok(hit);
  assert.match(hit.title, /GPT-5\.6 Sol/);
  assert.strictEqual(findRelated('Sunday meal prep habits', root), null);
});

test('linkRelated stamps a Related line and excludes the note itself', () => {
  const root = tmp();
  seedLearning(root, 'wiki/content/learning/old-gpt.md', 'GPT-5.6 launch first look');
  seedLearning(root, 'wiki/content/learning/new-gpt.md', 'GPT-5.6 launch agentic breakdown');
  const rel = linkRelated(root, 'wiki/content/learning/new-gpt.md', 'GPT-5.6 launch agentic breakdown');
  assert.ok(rel);
  assert.strictEqual(rel.relPath, path.join('wiki', 'content', 'learning', 'old-gpt.md'));
  const text = fs.readFileSync(path.join(root, 'wiki/content/learning/new-gpt.md'), 'utf8');
  assert.match(text, /\*\*Related:\*\* \[\[old-gpt\]\] — GPT-5\.6 launch first look/);
});

test('tokens stems so launch/launching collide', () => {
  const a = tokens('Launching GPT-5.6 Thursday');
  assert.ok(a.has('launch'));
});

/* ----------------------- night shift reactions ----------------------- */

test('recordReaction stamps the matching ledger row; promoteSpark files a lint-clean note', () => {
  const root = tmp();
  const ledger = path.join(root, 'ledger.jsonl');
  const [entry] = appendSparks(ledger, '2026-07-22', [{
    department: 'content', title: 'The dead channel already voted',
    text: '• Streamer University is episode one.', sources: ['wiki/content/ccl/content-corner-strategy.md']
  }]);
  markSent(ledger, '2026-07-22', { [entry.id]: 342 });

  assert.strictEqual(recordReaction(ledger, 999, '🔥'), null, 'non-spark message ignored');
  const hit = recordReaction(ledger, 342, '🔥');
  assert.ok(hit);
  assert.strictEqual(hit.reaction, '🔥');
  const reread = fs.readFileSync(ledger, 'utf8').trim();
  assert.match(reread, /"reaction":"🔥"/);

  const rel = promoteSpark(hit, root);
  const note = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.deepStrictEqual(noteErrors(note), []);
  assert.match(note, /source: nightshift-spark/);
  assert.match(note, /Streamer University is episode one/);
  // Re-reacting must not duplicate or overwrite.
  assert.strictEqual(promoteSpark(hit, root), rel);
});

/* ----------------------- morning-brief nudges ----------------------- */

test('pulseStaleness measures days since the newest pulse note', () => {
  const root = tmp();
  assert.strictEqual(pulseStaleness(root, '2026-07-22'), null);
  const dir = path.join(root, 'wiki', 'business', 'pulse');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-07-08.md'), 'x');
  assert.strictEqual(pulseStaleness(root, '2026-07-22'), 14);
  fs.writeFileSync(path.join(dir, '2026-07-21.md'), 'x');
  assert.strictEqual(pulseStaleness(root, '2026-07-22'), 1);
});

test('researchStaleness reads the intel-feed heartbeat from mirror mtimes', () => {
  const root = tmp();
  assert.strictEqual(researchStaleness(root), null);
  const dir = path.join(root, 'wiki', 'content', 'research');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '2026-W29.md');
  fs.writeFileSync(f, 'x');
  const now = Date.now();
  // Fresh file → 0 days; backdate the mtime 6 days → 6.
  assert.strictEqual(researchStaleness(root, now), 0);
  const old = new Date(now - 6 * 86400000);
  fs.utimesSync(f, old, old);
  assert.strictEqual(researchStaleness(root, now), 6);
});

/* ------------------------- repurpose mark-used ------------------------- */

test('repurpose parseArgs reads --mark-used ids', () => {
  assert.deepStrictEqual(repurposeArgs(['--mark-used', 'a1, b2,c3']).markUsed, ['a1', 'b2', 'c3']);
  assert.strictEqual(repurposeArgs(['--write']).markUsed, null);
});
