'use strict';
// Jul 22 2026 audit fixes: list-add phrasing, plan-session persistence,
// behavior tagging, Notion 3-Pages journal, Limitless known-people gating,
// health backfill decisions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseListAdd, routeVoice } = require('../system/telegram/intent.js');
const { saveSession, clearSession, loadSessions, storePath } = require('../system/telegram/session-store.js');
const { parsePlan } = require('../system/telegram/morning.js');
const { classify, appendTodo } = require('../system/telegram/bot.js');
const { extractText, buildNote } = require('../system/ingest/notion-journal.js');
const { extractPeople, loadKnownPeople } = require('../system/ingest/limitless-connect.js');
const { shouldReingest, parseBackfill } = require('../system/ingest/health-ingest.js');
const { noteErrors } = require('../system/lib/note-write.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-'));

/* --------------------------- fix 1: list-add --------------------------- */

test('parseListAdd catches polite list-add phrasings (incl. the sunscreen loss)', () => {
  assert.strictEqual(
    parseListAdd('Can you put on my test list to buy the super goop sunscreen for the face?'),
    'buy the super goop sunscreen for the face');
  assert.strictEqual(parseListAdd('can you add call the vet to my task list'), 'call the vet');
  assert.strictEqual(parseListAdd('add driver registration to my to-do list.'), 'driver registration');
  assert.strictEqual(parseListAdd('Okay so, can you put on my to-do list, order new mic'), 'order new mic');
});

test('parseListAdd leaves non-list messages alone', () => {
  assert.strictEqual(parseListAdd('can you tell me what is on my list'), null);
  assert.strictEqual(parseListAdd('what did I decide about thumbnails'), null);
  assert.strictEqual(parseListAdd('I listed the tools yesterday'), null);
  assert.strictEqual(parseListAdd(''), null);
});

test('routeVoice and classify route list-adds to todo', () => {
  const v = routeVoice('Can you put on my test list to buy the super goop sunscreen?');
  assert.strictEqual(v.kind, 'todo');
  assert.strictEqual(v.payload, 'buy the super goop sunscreen');
  const c = classify('can you add call the vet to my task list');
  assert.strictEqual(c.kind, 'todo');
  assert.strictEqual(c.payload, 'call the vet');
});

/* ---------------------- fix 1: session persistence ---------------------- */

test('sessions persist same-day, expire across days, and clear', () => {
  const root = tmp();
  const now = new Date(2026, 6, 22, 10, 0);
  saveSession('123', { plan: [{ title: 'Walk' }], busy: ['10:00-11:00 x'] }, root, now);
  const sameDay = loadSessions(root, now);
  assert.deepStrictEqual(sameDay.get('123').plan, [{ title: 'Walk' }]);
  // A restart the next morning must NOT resurrect yesterday's plan.
  const nextDay = loadSessions(root, new Date(2026, 6, 23, 8, 0));
  assert.strictEqual(nextDay.size, 0);
  clearSession('123', root);
  assert.strictEqual(loadSessions(root, now).size, 0);
  assert.ok(fs.existsSync(storePath(root)));
});

/* ----------------------- fix 4: behavior tagging ----------------------- */

test('parsePlan sanitizes behaviors to the canonical five', () => {
  const plan = parsePlan(JSON.stringify([
    { title: 'Walk', date: null, start: null, end: null, calendar: false, behaviors: ['Move', 'cardio', 'move'] },
    { title: 'Edit video', date: null, start: null, end: null, calendar: false }
  ]));
  assert.deepStrictEqual(plan[0].behaviors, ['move']);
  assert.deepStrictEqual(plan[1].behaviors, []);
});

test('appendTodo writes behaviors csv (and keeps none as default)', () => {
  const withB = appendTodo('', 'Walk', '2026-07-22', ['move']);
  assert.match(withB, /- \[ \] Walk \| due:2026-07-22 \| src:telegram \| behaviors:move \| link:none/);
  const without = appendTodo('', 'Email ET', '2026-07-22');
  assert.match(without, /behaviors:none/);
});

/* ---------------------- fix 2: notion journal pull ---------------------- */

test('extractText renders journal block types and skips empties', () => {
  const blocks = [
    { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Morning' }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Slept well. ' }, { plain_text: 'Grateful.' }] } },
    { type: 'paragraph', paragraph: { rich_text: [] } },
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'ship the audit' }] } },
    { type: 'quote', quote: { rich_text: [{ plain_text: 'trust the reps' }] } },
    { type: 'divider', divider: {} },
    // Audio journal: transcription blocks carry a title, not rich_text.
    { type: 'transcription', transcription: { title: [{ plain_text: 'Check-In: Foundation' }] } }
  ];
  assert.strictEqual(extractText(blocks),
    '## Morning\n\nSlept well. Grateful.\n\n- ship the audit\n\n> trust the reps\n\n## Check-In: Foundation');
});

test('buildNote passes the frontmatter lint', () => {
  const note = buildNote('2026-07-22', 'Slept well.\n\n- ship the audit');
  assert.deepStrictEqual(noteErrors(note), []);
  assert.ok(note.includes('tags: [journal, three-pages]'));
  assert.ok(note.includes('behaviors: [breathe, learn]'));
});

/* --------------------- fix 3: limitless people gate --------------------- */

function lifelogWith(speakers) {
  return [{ contents: speakers.map(([name, text]) => ({ type: 'blockquote', speakerName: name, content: text })) }];
}

test('extractPeople gated: only known people count; media voices dropped', () => {
  const logs = lifelogWith([
    ['Jordan', 'Yo, about the lock-in'],
    ['Marques Brownlee', 'This is the newest flagship'],
    ['Dharius Daniels', 'Luke chapter eleven']
  ]);
  const known = new Set(['jordan', 'jordan reyes']);
  const gated = extractPeople(logs, known);
  assert.deepStrictEqual(gated.map(p => p.name), ['Jordan']);
  // Ungated (legacy signature) still returns everyone — main() always gates.
  assert.strictEqual(extractPeople(logs).length, 3);
});

test('loadKnownPeople reads person-page titles (full + first name), empty dir -> empty set', () => {
  const root = tmp();
  assert.strictEqual(loadKnownPeople(root).size, 0);
  const dir = path.join(root, 'wiki', 'personal', 'people');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jordan-reyes.md'),
    '---\ntitle: Jordan Reyes\ndepartment: personal\ntype: person\nupdated: 2026-07-22\n---\n');
  const known = loadKnownPeople(root);
  assert.ok(known.has('jordan reyes'));
  assert.ok(known.has('jordan'));
});

/* ----------------------- fix 5: health backfill ----------------------- */

test('shouldReingest: missing note yes, manual correction never, late-synced hae yes', () => {
  assert.strictEqual(shouldReingest({ noteExists: false }), true);
  assert.strictEqual(shouldReingest({
    noteExists: true, noteText: '_Corrected manually Jul 22: …_', noteMtimeMs: 1, haeMtimeMs: 99
  }), false);
  assert.strictEqual(shouldReingest({
    noteExists: true, noteText: 'Steps 5,698', noteMtimeMs: 100, haeMtimeMs: 200
  }), true);
  assert.strictEqual(shouldReingest({
    noteExists: true, noteText: 'Steps 9,000', noteMtimeMs: 200, haeMtimeMs: 100
  }), false);
});

test('parseBackfill parses and bounds the flag', () => {
  assert.strictEqual(parseBackfill(['--backfill', '7']), 7);
  assert.strictEqual(parseBackfill(['--backfill', '99']), 30);
  assert.strictEqual(parseBackfill(['--backfill']), 7);
  assert.strictEqual(parseBackfill(['--date', '2026-07-22']), null);
});
