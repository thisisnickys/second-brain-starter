const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parsePerson,
  personPath,
  buildPersonNote,
  appendPersonNote,
  upsertPerson
} = require('../system/telegram/person.js');
const { noteErrors } = require('../system/lib/note-write.js');
const { classify } = require('../system/telegram/bot.js');

/* --------------------------------- parsePerson --------------------------------- */

test('parsePerson handles "person: Name — note" (em dash)', () => {
  assert.deepStrictEqual(parsePerson('person: Jordan Lee — met at the Austin Lock-In'), {
    name: 'Jordan Lee',
    note: 'met at the Austin Lock-In'
  });
});

test('parsePerson accepts en dash, spaced hyphen, and colon separators', () => {
  assert.deepStrictEqual(parsePerson('person: Jordan – runs a podcast'), {
    name: 'Jordan',
    note: 'runs a podcast'
  });
  assert.deepStrictEqual(parsePerson('person: Jordan Lee - loves Kling demos'), {
    name: 'Jordan Lee',
    note: 'loves Kling demos'
  });
  assert.deepStrictEqual(parsePerson('person: Jordan: intro to Jordan pending'), {
    name: 'Jordan',
    note: 'intro to Jordan pending'
  });
});

test('parsePerson handles "note about Name: note"', () => {
  assert.deepStrictEqual(parsePerson('note about Jordan Lee: wants to join the pilot'), {
    name: 'Jordan Lee',
    note: 'wants to join the pilot'
  });
  assert.deepStrictEqual(parsePerson('Note About Jordan — asked about the World Builder'), {
    name: 'Jordan',
    note: 'asked about the World Builder'
  });
});

test('parsePerson splits at the EARLIEST separator (note may contain colons/dashes)', () => {
  assert.deepStrictEqual(parsePerson('person: John - note: call him Tuesday'), {
    name: 'John',
    note: 'note: call him Tuesday'
  });
});

test('parsePerson keeps hyphenated names intact (no spaced hyphen inside name)', () => {
  assert.deepStrictEqual(parsePerson('person: Mary-Jane: illustrator from CCL chat'), {
    name: 'Mary-Jane',
    note: 'illustrator from CCL chat'
  });
});

test('parsePerson returns null for non-person messages and malformed input', () => {
  assert.strictEqual(parsePerson('remember: people matter'), null);
  assert.strictEqual(parsePerson('what did I decide about thumbnails'), null);
  assert.strictEqual(parsePerson('person: JustANameNoSeparator'), null);
  assert.strictEqual(parsePerson('person: — note with no name'), null);
  assert.strictEqual(parsePerson(''), null);
  assert.strictEqual(parsePerson(null), null);
});

/* -------------------------------- classify routing ----------------------------- */

test('classify routes person messages before the generic ask fallback', () => {
  const c = classify('person: Jordan Lee — met at the Austin Lock-In');
  assert.strictEqual(c.kind, 'person');
  assert.deepStrictEqual(c.payload, { name: 'Jordan Lee', note: 'met at the Austin Lock-In' });

  const c2 = classify('note about Jordan: wants the pilot');
  assert.strictEqual(c2.kind, 'person');
});

test('classify still routes remember/todo/capture ahead of or independent of person', () => {
  assert.strictEqual(classify('remember: Jordan — likes orange').kind, 'remember');
  assert.strictEqual(classify('todo: call Jordan').kind, 'todo');
  assert.strictEqual(classify('https://example.com').kind, 'web');
  assert.strictEqual(classify('who is Jordan').kind, 'ask');
});

test('classify person wins over bare-URL capture when the note contains a URL', () => {
  const c = classify('person: Jordan — site is https://example.com');
  assert.strictEqual(c.kind, 'person');
});

/* ---------------------------- slugging / file naming ---------------------------- */

test('personPath slugifies the name into wiki/personal/people/', () => {
  const p = personPath("D'Angelo Smith-Jones", '/root');
  assert.strictEqual(p, path.join('/root', 'wiki', 'personal', 'people', 'dangelo-smith-jones.md'));
});

/* ------------------------------ note building/appending ------------------------- */

test('buildPersonNote produces a lint-clean person page with a ## Notes section', () => {
  const md = buildPersonNote('Jordan Lee', 'met at the Lock-In', '2026-07-08');
  assert.deepStrictEqual(noteErrors(md), []);
  assert.match(md, /^title: Jordan Lee$/m);
  assert.match(md, /^department: personal$/m);
  assert.match(md, /^type: person$/m);
  assert.match(md, /^behaviors: \[connect\]$/m);
  assert.match(md, /^tags: \[people\]$/m);
  assert.match(md, /^source: telegram$/m);
  assert.match(md, /^updated: 2026-07-08$/m);
  assert.match(md, /^## Notes$/m);
  assert.match(md, /^- 2026-07-08 — met at the Lock-In$/m);
});

test('appendPersonNote adds a dated bullet under ## Notes and bumps updated:', () => {
  const original = buildPersonNote('Jordan Lee', 'first note', '2026-07-01');
  const updated = appendPersonNote(original, 'second note', '2026-07-08');
  assert.deepStrictEqual(noteErrors(updated), []);
  assert.match(updated, /^updated: 2026-07-08$/m);
  assert.doesNotMatch(updated, /^updated: 2026-07-01$/m);
  const notesIdx = updated.indexOf('## Notes');
  assert.ok(updated.indexOf('- 2026-07-01 — first note') > notesIdx);
  assert.ok(updated.indexOf('- 2026-07-08 — second note') > updated.indexOf('- 2026-07-01 — first note'));
});

test('appendPersonNote inserts before a following section, not at end of file', () => {
  const md = [
    '---',
    'title: Jordan',
    'department: personal',
    'type: person',
    'behaviors: [connect]',
    'tags: [people]',
    'source: telegram',
    'updated: 2026-07-01',
    '---',
    '',
    '## Notes',
    '',
    '- 2026-07-01 — first',
    '',
    '## Links',
    '',
    '- something',
    ''
  ].join('\n');
  const out = appendPersonNote(md, 'second', '2026-07-08');
  const bullet = out.indexOf('- 2026-07-08 — second');
  assert.ok(bullet !== -1);
  assert.ok(bullet < out.indexOf('## Links'));
});

test('appendPersonNote recreates a missing ## Notes section', () => {
  const md = buildPersonNote('Jordan', 'x', '2026-07-01').replace(/## Notes\n\n- .*\n/, '');
  const out = appendPersonNote(md, 'back again', '2026-07-08');
  assert.match(out, /^## Notes$/m);
  assert.match(out, /- 2026-07-08 — back again/);
});

/* ------------------------------- upsertPerson (fs) ------------------------------ */

test('upsertPerson creates a new file, then appends on the second call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'person-'));
  const r1 = upsertPerson('Test Person', 'first note', { rootDir: root, date: '2026-07-07' });
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.path, path.join('wiki', 'personal', 'people', 'test-person.md'));
  const abs = path.join(root, r1.path);
  assert.ok(fs.existsSync(abs));

  const r2 = upsertPerson('Test Person', 'second note', { rootDir: root, date: '2026-07-08' });
  assert.strictEqual(r2.created, false);
  assert.strictEqual(r2.path, r1.path);
  const md = fs.readFileSync(abs, 'utf8');
  assert.deepStrictEqual(noteErrors(md), []);
  assert.match(md, /^updated: 2026-07-08$/m);
  assert.match(md, /- 2026-07-07 — first note/);
  assert.match(md, /- 2026-07-08 — second note/);
});

test('upsertPerson refuses to write a note that fails lint (nothing lands)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'person-'));
  // A multi-line "name" would break single-line frontmatter → must throw,
  // and nothing may be written.
  assert.throws(() => upsertPerson('Bad\nName', 'note', { rootDir: root, date: '2026-07-08' }));
  assert.ok(!fs.existsSync(path.join(root, 'wiki')));
});
