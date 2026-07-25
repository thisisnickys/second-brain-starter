'use strict';
// Idea bank: parseIdea triggers, bank note format + lint, append, listBank,
// recordIdea fallback, voice routing, dump-distill ideas, and the connect
// credit on evening reflections.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseIdea, buildBankNote, appendIdeaEntries, listBank, appendToBank,
  recordIdea, parseIdeaDistill, bankPath
} = require('../system/telegram/idea.js');
const { routeVoice } = require('../system/telegram/intent.js');
const { parseDumpDistill } = require('../system/telegram/dump.js');
const { reflectionBehaviors } = require('../system/telegram/evening.js');
const { noteErrors } = require('../system/lib/note-write.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bank-'));
}

/* ------------------------------ parseIdea ------------------------------ */

test('parseIdea catches the explicit triggers', () => {
  assert.strictEqual(parseIdea('I have an idea: a vox short on AI burnout'), 'a vox short on AI burnout');
  assert.strictEqual(parseIdea("I've got an idea — clip the CCL intro"), 'clip the CCL intro');
  assert.strictEqual(parseIdea('got an idea, weekly voice-note recap'), 'weekly voice-note recap');
  assert.strictEqual(parseIdea("here's an idea. merch drop for the lock-in"), 'merch drop for the lock-in');
  assert.strictEqual(parseIdea('new idea: idea wall in the galaxy'), 'idea wall in the galaxy');
  assert.strictEqual(parseIdea('idea: turn the audit into a lead magnet'), 'turn the audit into a lead magnet');
  assert.strictEqual(parseIdea('add to my idea bank the substack series'), 'the substack series');
});

test('parseIdea tolerates spoken filler preamble', () => {
  assert.strictEqual(parseIdea('Okay so, um, I have an idea for a series'), 'for a series');
});

test('parseIdea returns empty string for a bare trigger', () => {
  assert.strictEqual(parseIdea('I have an idea'), '');
});

test('parseIdea leaves non-idea messages alone', () => {
  assert.strictEqual(parseIdea('idea brief'), null);
  assert.strictEqual(parseIdea('what ideas did I have this week'), null);
  assert.strictEqual(parseIdea('idea bank'), null);
  assert.strictEqual(parseIdea('show me my idea bank'), null);
  assert.strictEqual(parseIdea('today I want to work on that idea from Tuesday'), null);
  assert.strictEqual(parseIdea('remind me to write down my idea'), null);
  assert.strictEqual(parseIdea(''), null);
  assert.strictEqual(parseIdea(null), null);
});

/* --------------------------- bank note format --------------------------- */

test('buildBankNote passes the frontmatter lint', () => {
  const note = buildBankNote(
    [{ date: '2026-07-22', text: 'A vox short on AI burnout.', src: 'voice' }],
    '2026-07-22'
  );
  assert.deepStrictEqual(noteErrors(note), []);
  assert.ok(note.includes('- **2026-07-22** — A vox short on AI burnout. _(voice)_'));
});

test('appendIdeaEntries appends and moves updated:', () => {
  const note = buildBankNote(
    [{ date: '2026-07-20', text: 'First idea.', src: 'text' }],
    '2026-07-20'
  );
  const out = appendIdeaEntries(
    note,
    [{ date: '2026-07-22', text: 'Second idea.', src: 'brain dump' }],
    '2026-07-22'
  );
  assert.deepStrictEqual(noteErrors(out), []);
  assert.ok(out.includes('updated: 2026-07-22'));
  assert.ok(!out.includes('updated: 2026-07-20'));
  assert.ok(out.indexOf('First idea.') < out.indexOf('Second idea.'));
});

/* --------------------------- append + listBank --------------------------- */

test('appendToBank creates then appends; listBank returns newest first', () => {
  const root = tmpRoot();
  appendToBank([{ date: '2026-07-21', text: 'Idea one.', src: 'text' }], { rootDir: root, date: '2026-07-21' });
  appendToBank([{ date: '2026-07-22', text: 'Idea two.', src: 'voice' }], { rootDir: root, date: '2026-07-22' });
  const raw = fs.readFileSync(bankPath(root), 'utf8');
  assert.deepStrictEqual(noteErrors(raw), []);
  const recent = listBank(root, 15);
  assert.strictEqual(recent.length, 2);
  assert.ok(recent[0].includes('Idea two.'));
  assert.ok(recent[1].includes('Idea one.'));
});

test('listBank returns [] when the bank does not exist', () => {
  assert.deepStrictEqual(listBank(tmpRoot(), 15), []);
});

/* ------------------------------ recordIdea ------------------------------ */

test('recordIdea banks the distilled text', async () => {
  const root = tmpRoot();
  const r = await recordIdea('so um basically a clip series', {
    rootDir: root, src: 'voice',
    distill: async () => 'A clip series.'
  });
  assert.strictEqual(r.entry.text, 'A clip series.');
  assert.ok(fs.readFileSync(bankPath(root), 'utf8').includes('A clip series. _(voice)_'));
});

test('recordIdea falls back to raw text when distill fails', async () => {
  const root = tmpRoot();
  const r = await recordIdea('raw idea text', {
    rootDir: root, src: 'text',
    distill: async () => { throw new Error('claude down'); }
  });
  assert.strictEqual(r.entry.text, 'raw idea text');
});

test('parseIdeaDistill extracts the idea and rejects junk', () => {
  assert.strictEqual(parseIdeaDistill('noise {"idea": "The idea."} noise'), 'The idea.');
  assert.throws(() => parseIdeaDistill('no json here'));
  assert.throws(() => parseIdeaDistill('{"idea": ""}'));
});

/* ------------------------------ voice routing ------------------------------ */

test('routeVoice routes ideas, briefs, and keeps existing wins', () => {
  assert.strictEqual(routeVoice('I have an idea: a vox short').kind, 'idea');
  assert.strictEqual(routeVoice('idea brief').kind, 'ideabrief');
  assert.strictEqual(routeVoice('what ideas did I have this week').kind, 'ideabrief');
  // dump keyword still beats everything, even with "idea" in it
  assert.strictEqual(routeVoice('brain dump I have an idea about clips').kind, 'dump');
  // planning talk still reaches the planner
  assert.strictEqual(routeVoice('Today I need to film, edit, and post the short. Then walk.').kind, 'plan');
  // idea capture wins even mid-plan-session
  assert.strictEqual(routeVoice('I have an idea: bank this', { hasSession: true }).kind, 'idea');
});

/* --------------------------- dump ideas extraction --------------------------- */

test('parseDumpDistill carries ideas through (and defaults to [])', () => {
  const withIdeas = parseDumpDistill(JSON.stringify({
    title: 'T', bullets_md: '- a', apply: '', ideas: [' One. ', '', 'Two.', 'Three.', 'Four.']
  }));
  assert.deepStrictEqual(withIdeas.ideas, ['One.', 'Two.', 'Three.']);
  const without = parseDumpDistill(JSON.stringify({ title: 'T', bullets_md: '- a', apply: '' }));
  assert.deepStrictEqual(without.ideas, []);
});

/* --------------------------- connect reflection --------------------------- */

test('reflectionBehaviors credits connect only on a real answer to the connect ask', () => {
  const q = 'Who did you connect with today?';
  assert.deepStrictEqual(reflectionBehaviors(q, 'Talked with Jordan about the lock-in'), ['learn', 'breathe', 'connect']);
  assert.deepStrictEqual(reflectionBehaviors(q, 'no one really'), ['learn', 'breathe']);
  assert.deepStrictEqual(reflectionBehaviors(q, 'Nobody today'), ['learn', 'breathe']);
  assert.deepStrictEqual(reflectionBehaviors(q, "didn't get to anyone"), ['learn', 'breathe']);
  assert.deepStrictEqual(reflectionBehaviors(q, ''), ['learn', 'breathe']);
  // a non-connect question never credits connect
  assert.deepStrictEqual(
    reflectionBehaviors('What do you want tomorrow to build on?', 'Called my mom'),
    ['learn', 'breathe']
  );
});
