const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseDump,
  fmtTime,
  buildDumpPrompt,
  parseDumpDistill,
  buildDumpNote,
  appendDumpSection,
  dumpSection
} = require('../system/telegram/dump.js');
const { noteErrors } = require('../system/lib/note-write.js');

/* -------------------------------- parseDump ------------------------------ */

test('parseDump: leading trigger, text form', () => {
  assert.strictEqual(
    parseDump('brain dump: today I learned fxtwitter exists'),
    'today I learned fxtwitter exists'
  );
  assert.strictEqual(parseDump('Brain dump — met with Jordan about the framework'),
    'met with Jordan about the framework');
});

test('parseDump: voice-style filler preamble is allowed', () => {
  assert.strictEqual(
    parseDump('Okay, so, brain dump. Today the GPT-Live launch happened and I tested it.'),
    'Today the GPT-Live launch happened and I tested it.'
  );
  assert.strictEqual(
    parseDump("Hey, this is a brain dump. Two things happened."),
    'Two things happened.'
  );
});

test('parseDump: braindump and brain-dump variants', () => {
  assert.strictEqual(parseDump('braindump today was wild'), 'today was wild');
  assert.strictEqual(parseDump('brain-dump: one thing'), 'one thing');
});

test('parseDump: bare trigger with no body -> empty string (not null)', () => {
  assert.strictEqual(parseDump('brain dump'), '');
  assert.strictEqual(parseDump('Brain dump.'), '');
});

test('parseDump: questions ABOUT brain dumps are not dumps', () => {
  assert.strictEqual(parseDump('what did my brain dump say yesterday?'), null);
  assert.strictEqual(parseDump('can you find last week\'s brain dump'), null);
  assert.strictEqual(parseDump('remind me to brain dump tonight'), null);
});

test('parseDump: trigger buried deep in a message is not a dump', () => {
  assert.strictEqual(
    parseDump('I was thinking about a lot of stuff today and honestly the whole brain dump idea is cool'),
    null
  );
});

test('parseDump: no trigger / empty -> null', () => {
  assert.strictEqual(parseDump('todo: buy milk'), null);
  assert.strictEqual(parseDump(''), null);
  assert.strictEqual(parseDump(null), null);
});

/* --------------------------------- fmtTime ------------------------------- */

test('fmtTime: 12-hour lowercase with minutes', () => {
  assert.strictEqual(fmtTime(new Date(2026, 6, 8, 14, 35)), '2:35pm');
  assert.strictEqual(fmtTime(new Date(2026, 6, 8, 0, 5)), '12:05am');
  assert.strictEqual(fmtTime(new Date(2026, 6, 8, 12, 0)), '12:00pm');
});

/* ----------------------------- prompt + distill -------------------------- */

test('buildDumpPrompt: forbids task extraction and includes the dump', () => {
  const p = buildDumpPrompt('I learned X and met Y');
  assert.ok(p.includes('I learned X and met Y'));
  assert.ok(/NOT a to-do list/i.test(p));
  assert.ok(p.includes('bullets_md'));
});

test('parseDumpDistill: parses JSON, tolerates fences, requires title+bullets', () => {
  const d = parseDumpDistill('```json\n{"title":"GPT-Live day","bullets_md":"- one\\n- two","apply":"Do it."}\n```');
  assert.strictEqual(d.title, 'GPT-Live day');
  assert.ok(d.bullets_md.includes('- one'));
  assert.strictEqual(d.apply, 'Do it.');
  assert.throws(() => parseDumpDistill('no json here'));
  assert.throws(() => parseDumpDistill('{"title":"x"}'));
});

/* ------------------------------ note building ---------------------------- */

const DISTILL = {
  title: 'GPT-Live launch day',
  bullets_md: '- Tested GPT-Live, full-duplex is real\n- Met with Jordan about element 7',
  apply: 'Record the reaction video tomorrow.'
};

test('buildDumpNote: lint-valid daily journal note with a timed section', () => {
  const note = buildDumpNote({ distill: DISTILL, dateStr: '2026-07-08', timeStr: '2:35pm' });
  assert.deepStrictEqual(noteErrors(note), []);
  assert.ok(note.includes('title: Brain dump — 2026-07-08'));
  assert.ok(note.includes('department: personal'));
  assert.ok(note.includes('behaviors: [learn]'));
  assert.ok(note.includes('## 2:35pm — GPT-Live launch day'));
  assert.ok(note.includes('- Tested GPT-Live'));
  assert.ok(note.includes('**Apply:** Record the reaction video tomorrow.'));
});

test('appendDumpSection: second dump appends a new section and keeps updated: fresh', () => {
  const day1 = buildDumpNote({ distill: DISTILL, dateStr: '2026-07-08', timeStr: '2:35pm' });
  const out = appendDumpSection(day1, dumpSection({
    distill: { title: 'Evening thoughts', bullets_md: '- Threads scraper idea', apply: '' },
    timeStr: '9:10pm'
  }), '2026-07-08');
  assert.deepStrictEqual(noteErrors(out), []);
  assert.ok(out.includes('## 2:35pm — GPT-Live launch day'));
  assert.ok(out.includes('## 9:10pm — Evening thoughts'));
  assert.ok(out.indexOf('2:35pm') < out.indexOf('9:10pm'));
  assert.ok(!out.includes('**Apply:**\n'), 'empty apply should be omitted');
});

/* --------------------------- ideas brief gather -------------------------- */

const { parseIdeasBrief, listDumpSections, buildIdeasBriefPrompt } = require('../system/telegram/dump.js');

test('parseIdeasBrief: trigger phrases and day windows', () => {
  assert.deepStrictEqual(parseIdeasBrief('idea brief'), { days: 7 });
  assert.deepStrictEqual(parseIdeasBrief('Ideas brief for today'), { days: 1 });
  assert.deepStrictEqual(parseIdeasBrief('brief me on my ideas'), { days: 7 });
  assert.deepStrictEqual(parseIdeasBrief('what ideas did I have this week?'), { days: 7 });
  assert.deepStrictEqual(parseIdeasBrief('what ideas did I have this month'), { days: 30 });
  assert.deepStrictEqual(parseIdeasBrief('idea brief last 14 days'), { days: 14 });
});

test('parseIdeasBrief: non-triggers -> null', () => {
  assert.strictEqual(parseIdeasBrief('I have an idea about thumbnails'), null);
  assert.strictEqual(parseIdeasBrief('brain dump: an idea'), null);
  assert.strictEqual(parseIdeasBrief('what did I decide about pricing'), null);
});

test('listDumpSections: returns dump bodies within the window, newest first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-brief-'));
  const dir = path.join(root, 'wiki', 'personal', 'journal');
  fs.mkdirSync(dir, { recursive: true });
  const note = d => `---\ntitle: Brain dump — ${d}\ndepartment: personal\nupdated: ${d}\n---\n\n# Brain dump — ${d}\n\n## 2pm — Stuff\n\n- bullet for ${d}\n`;
  fs.writeFileSync(path.join(dir, '2026-07-08-brain-dump.md'), note('2026-07-08'));
  fs.writeFileSync(path.join(dir, '2026-07-05-brain-dump.md'), note('2026-07-05'));
  fs.writeFileSync(path.join(dir, '2026-06-01-brain-dump.md'), note('2026-06-01'));
  fs.writeFileSync(path.join(dir, '2026-07-07-evening-reflection.md'), '---\ntitle: x\n---\nnot a dump');
  const got = listDumpSections(root, '2026-07-02');
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].date, '2026-07-08');
  assert.strictEqual(got[1].date, '2026-07-05');
  assert.ok(got[0].body.includes('bullet for 2026-07-08'));
  assert.ok(!got[0].body.includes('title:'), 'frontmatter should be stripped');
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildIdeasBriefPrompt: includes the dumps and asks for ideas only', () => {
  const p = buildIdeasBriefPrompt([{ date: '2026-07-08', body: '- the bridge IS the product' }], 7);
  assert.ok(p.includes('the bridge IS the product'));
  assert.ok(/ideas/i.test(p));
  assert.ok(/not.*(tasks|to-dos|status)/i.test(p) || /skip/i.test(p));
});
