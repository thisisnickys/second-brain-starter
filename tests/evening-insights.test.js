const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  behaviorsFromFrontmatter, behaviorsFromTaskLine, behaviorsToday, behaviorsLine, behaviorsRollup,
  daysBetween, extractApply, listLearningNotes, pickResurface,
  loadResurfaceState, markResurfaced
} = require('../system/lib/evening-insights.js');

const TODAY = '2026-07-07';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evening-insights-'));
}

function mkNote(root, rel, fm, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${fm.join('\n')}\n---\n\n${body || 'body'}\n`);
  return p;
}

/* ------------------------------ five behaviors ------------------------------ */

test('behaviorsFromFrontmatter parses bracketed and bare lists, drops junk', () => {
  assert.deepStrictEqual(behaviorsFromFrontmatter('---\nbehaviors: [move, breathe]\n---'), ['move', 'breathe']);
  assert.deepStrictEqual(behaviorsFromFrontmatter('behaviors: create,learn'), ['create', 'learn']);
  assert.deepStrictEqual(behaviorsFromFrontmatter('behaviors: [flying, learn]'), ['learn']);
  assert.deepStrictEqual(behaviorsFromFrontmatter('title: no behaviors here'), []);
  assert.deepStrictEqual(behaviorsFromFrontmatter(null), []);
});

test('behaviorsFromTaskLine reads the behaviors: field, "none" yields empty', () => {
  assert.deepStrictEqual(
    behaviorsFromTaskLine('Walk | due:none | src:telegram | behaviors:move,breathe | link:none | done:2026-07-07'),
    ['move', 'breathe']);
  assert.deepStrictEqual(behaviorsFromTaskLine('Walk | behaviors:none | link:none'), []);
  assert.deepStrictEqual(behaviorsFromTaskLine('Walk | due:none | link:none'), []);
});

test('behaviorsToday unions tasks, wiki notes, health, and people notes', () => {
  const root = mkRoot();
  // wiki note updated today → create
  mkNote(root, 'wiki/content/learning/a.md',
    ['title: A', 'department: content', 'behaviors: [create]', `updated: ${TODAY}`]);
  // stale note → ignored
  mkNote(root, 'wiki/content/learning/old.md',
    ['title: Old', 'department: content', 'behaviors: [breathe]', 'updated: 2026-06-01']);
  // people note updated today, no behaviors field → connect
  mkNote(root, 'wiki/personal/people/jordan.md',
    ['title: Jordan', 'department: personal', `updated: ${TODAY}`]);
  // health note → move, breathe
  mkNote(root, `wiki/personal/health/${TODAY}.md`,
    ['title: Health', 'department: personal', 'behaviors: [move, breathe]', `updated: ${TODAY}`]);
  // archive: done today with learn, done yesterday with create (ignored)
  const archiveMd = [
    `- [x] Read chapter | due:none | src:manual | behaviors:learn | link:none | done:${TODAY}`,
    '- [x] Old task | due:none | src:manual | behaviors:create | link:none | done:2026-07-06'
  ].join('\n');

  const touched = behaviorsToday(root, TODAY, archiveMd);
  assert.deepStrictEqual([...touched].sort(), ['breathe', 'connect', 'create', 'learn', 'move']);

  // Without health/people/tasks it narrows accordingly.
  const only = behaviorsToday(root, '2026-06-01', '');
  assert.deepStrictEqual([...only].sort(), ['breathe']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('behaviorsLine renders the fixed five-slot ✓/✗ line in order', () => {
  assert.strictEqual(
    behaviorsLine(new Set(['move', 'breathe', 'learn'])),
    'Behaviors: move ✓ · breathe ✓ · create ✗ · learn ✓ · connect ✗');
  assert.strictEqual(
    behaviorsLine([]),
    'Behaviors: move ✗ · breathe ✗ · create ✗ · learn ✗ · connect ✗');
});

test('behaviorsRollup returns touched, untouched, and the line', () => {
  const root = mkRoot();
  mkNote(root, `wiki/personal/health/${TODAY}.md`,
    ['title: Health', 'department: personal', 'behaviors: [move, breathe]', `updated: ${TODAY}`]);
  const r = behaviorsRollup(root, TODAY, '');
  assert.deepStrictEqual(r.touched, ['move', 'breathe']);
  assert.deepStrictEqual(r.untouched, ['create', 'learn', 'connect']);
  assert.match(r.line, /^Behaviors: move ✓ · breathe ✓ · create ✗/);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------------------------- apply-line resurface --------------------------- */

test('daysBetween counts whole local days, null on junk', () => {
  assert.strictEqual(daysBetween('2026-07-07', '2026-06-07'), 30);
  assert.strictEqual(daysBetween('2026-07-07', '2026-07-07'), 0);
  assert.strictEqual(daysBetween('2026-07-07', 'junk'), null);
});

test('extractApply handles **Apply:** lines, ## Apply sections, and truncation', () => {
  assert.strictEqual(extractApply('stuff\n**Apply:** Do the thing tomorrow.\nmore'), 'Do the thing tomorrow.');
  assert.strictEqual(
    extractApply('# T\n\n## Apply\nFirst paragraph\nsecond line.\n\nSecond paragraph.\n\n## Links\n'),
    'First paragraph second line.');
  assert.strictEqual(extractApply('no apply anywhere'), null);
  const long = '## Apply\n' + 'word '.repeat(100);
  const got = extractApply(long);
  assert.ok(got.length <= 301 && got.endsWith('…'), 'long apply is capped with ellipsis');
});

test('listLearningNotes finds wiki/*/learning notes with title/updated/apply', () => {
  const root = mkRoot();
  mkNote(root, 'wiki/content/learning/a.md',
    ['title: Note A', 'department: content', 'updated: 2026-06-07'], '## Apply\nShip it.\n');
  mkNote(root, 'wiki/business/learning/b.md',
    ['title: Note B', 'department: business', 'updated: 2026-06-10'], 'no apply');
  mkNote(root, 'wiki/content/remembered/c.md',
    ['title: Not learning', 'department: content', 'updated: 2026-06-07'], '## Apply\nX.\n');
  const notes = listLearningNotes(root).sort((x, y) => x.title.localeCompare(y.title));
  assert.strictEqual(notes.length, 2);
  assert.deepStrictEqual(
    { title: notes[0].title, updated: notes[0].updated, apply: notes[0].apply },
    { title: 'Note A', updated: '2026-06-07', apply: 'Ship it.' });
  assert.strictEqual(notes[1].apply, null, 'note without Apply is listed but apply-less');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pickResurface: 25-35 day window, closest to 30 wins, needs an Apply line', () => {
  const root = mkRoot();
  mkNote(root, 'wiki/content/learning/d30.md',
    ['title: Thirty', 'department: content', 'updated: 2026-06-07'], '## Apply\nThirty-day move.\n');
  mkNote(root, 'wiki/content/learning/d27.md',
    ['title: TwentySeven', 'department: content', 'updated: 2026-06-10'], '## Apply\nOther move.\n');
  mkNote(root, 'wiki/content/learning/d5.md',
    ['title: Fresh', 'department: content', 'updated: 2026-07-02'], '## Apply\nToo fresh.\n');
  mkNote(root, 'wiki/content/learning/d31-noapply.md',
    ['title: NoApply', 'department: content', 'updated: 2026-06-06'], 'nothing to apply');
  const pick = pickResurface(root, TODAY, []);
  assert.strictEqual(pick.title, 'Thirty');
  assert.strictEqual(pick.daysAgo, 30);
  assert.strictEqual(pick.apply, 'Thirty-day move.');
  assert.strictEqual(pick.relPath, path.join('wiki', 'content', 'learning', 'd30.md'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pickResurface skips already-resurfaced notes, widens to 20-45, else null', () => {
  const root = mkRoot();
  const p30 = mkNote(root, 'wiki/content/learning/d30.md',
    ['title: Thirty', 'department: content', 'updated: 2026-06-07'], '## Apply\nA.\n');
  mkNote(root, 'wiki/content/learning/d40.md',
    ['title: Forty', 'department: content', 'updated: 2026-05-28'], '## Apply\nB.\n');
  // 30-day note already resurfaced → widen window catches the 40-day note.
  const pick = pickResurface(root, TODAY, [path.relative(root, p30)]);
  assert.strictEqual(pick.title, 'Forty');
  assert.strictEqual(pick.daysAgo, 40);
  // Everything resurfaced → skip silently.
  assert.strictEqual(pickResurface(root, TODAY,
    [path.relative(root, p30), path.join('wiki', 'content', 'learning', 'd40.md')]), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pickResurface returns null on an empty brain', () => {
  const root = mkRoot();
  assert.strictEqual(pickResurface(root, TODAY, []), null);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------ resurface state ------------------------------ */

test('resurface state round-trips and dedupes; corrupt file reads as empty', () => {
  const root = mkRoot();
  assert.deepStrictEqual(loadResurfaceState(root), []);
  markResurfaced(root, 'wiki/content/learning/a.md');
  markResurfaced(root, 'wiki/content/learning/b.md');
  markResurfaced(root, 'wiki/content/learning/a.md'); // dupe ignored
  assert.deepStrictEqual(loadResurfaceState(root),
    ['wiki/content/learning/a.md', 'wiki/content/learning/b.md']);
  fs.writeFileSync(path.join(root, 'system', 'logs', 'resurface-state.json'), 'not json');
  assert.deepStrictEqual(loadResurfaceState(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
