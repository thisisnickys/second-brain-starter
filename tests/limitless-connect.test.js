const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractPeople,
  buildNote,
  cleanContext,
  isExcludedSpeaker,
} = require('../system/ingest/limitless-connect.js');
const { parseFrontmatter, validatePage } = require('../system/lib/frontmatter.js');
const { noteErrors } = require('../system/lib/note-write.js');

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'limitless-lifelogs.json'), 'utf8')
);

test('extracts partners and excludes Sam (user identifier + name)', () => {
  const people = extractPeople(FIXTURES.threeSpeakers);
  assert.deepStrictEqual(
    people.map(p => p.name).sort(),
    ['Jordan', 'Riley']
  );
  const jordan = people.find(p => p.name === 'Jordan');
  assert.match(jordan.context, /thumbnail needs the result/);
});

test('Sam-only lifelog yields no people (no note case)', () => {
  assert.deepStrictEqual(extractPeople(FIXTURES.ownerOnly), []);
});

test('repeated speaker across lifelogs with mixed casing dedupes to one, first-seen casing wins', () => {
  const people = extractPeople(FIXTURES.mixedCasingAcrossLogs);
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].name, 'Jordan');
  assert.match(people[0].context, /community call moved/);
});

test('unnamed speakers ("Speaker N", "Unknown", empty) are skipped', () => {
  assert.deepStrictEqual(extractPeople(FIXTURES.unnamedSpeakers), []);
});

test('context skips trivial segments, strips newlines/pipes, truncates ~100 chars single-line', () => {
  const people = extractPeople(FIXTURES.messyContext);
  assert.strictEqual(people.length, 1);
  const ctx = people[0].context;
  assert.notStrictEqual(ctx, 'Ok'); // trivial first segment skipped
  assert.ok(!/[\r\n|]/.test(ctx), 'context must be single-line, no pipes');
  assert.ok(ctx.length <= 101, `context too long: ${ctx.length}`);
  assert.match(ctx, /^So the plan \/ is: first we ship the pilot/);
});

test('nested children blockquotes are walked (speaker inside children found/excluded correctly)', () => {
  const logs = [
    {
      contents: [
        {
          type: 'heading2',
          content: 'Chat',
          children: [
            {
              type: 'blockquote',
              content: 'Deep in the tree but still a real person talking.',
              speakerName: 'Ray',
              speakerIdentifier: null,
            },
          ],
        },
      ],
    },
  ];
  const people = extractPeople(logs);
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].name, 'Ray');
});

test('isExcludedSpeaker rules', () => {
  assert.strictEqual(isExcludedSpeaker('Anyone', 'user'), true);
  assert.strictEqual(isExcludedSpeaker('sam', null), true);
  assert.strictEqual(isExcludedSpeaker('You', null), true);
  assert.strictEqual(isExcludedSpeaker('UNKNOWN', null), true);
  assert.strictEqual(isExcludedSpeaker('Speaker 3', null), true);
  assert.strictEqual(isExcludedSpeaker(null, null), true);
  assert.strictEqual(isExcludedSpeaker('  ', null), true);
  assert.strictEqual(isExcludedSpeaker('Jordan', null), false);
});

test('cleanContext truncates long text with ellipsis', () => {
  const long = 'a'.repeat(250);
  const out = cleanContext(long);
  assert.strictEqual(out.length, 101);
  assert.ok(out.endsWith('…'));
});

test('note builder output passes the frontmatter lint with correct fields', () => {
  const date = '2026-07-07';
  const people = extractPeople(FIXTURES.threeSpeakers);
  const note = buildNote(date, people);

  assert.deepStrictEqual(noteErrors(note), []);

  const { data, body, errors } = parseFrontmatter(note);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(validatePage(data), []);
  assert.strictEqual(data.title, `Connections ${date}`);
  assert.strictEqual(data.department, 'personal');
  assert.deepStrictEqual(data.tags, ['connections', 'people']);
  assert.deepStrictEqual(data.behaviors, ['connect']);
  assert.strictEqual(data.source, 'capture:limitless-auto');
  assert.strictEqual(data.updated, date);

  // One bullet per person, single-line each.
  const bullets = body.split('\n').filter(l => l.startsWith('- '));
  assert.strictEqual(bullets.length, people.length);
  for (const p of people) {
    assert.ok(bullets.some(b => b.startsWith(`- ${p.name} — `)), `missing bullet for ${p.name}`);
  }
  assert.ok(body.includes(`# Connections ${date}`));
});

test('note builder handles a person with no usable context (name-only bullet, still lints)', () => {
  const note = buildNote('2026-07-07', [{ name: 'Maya', context: '' }]);
  assert.deepStrictEqual(noteErrors(note), []);
  assert.ok(note.includes('\n- Maya\n'));
});
