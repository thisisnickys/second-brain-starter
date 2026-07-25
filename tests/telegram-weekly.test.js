const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  windowLabel, weekWindow, readArchives, doneInWindow, notesInWindow, noteBody,
  journalTexts, capturesInWindow, workoutsInWindow, weeklyBehaviorCounts,
  latestPulse, healthLine, buildWeeklyPrompt, plainWeekly
} = require('../system/telegram/weekly.js');
const { captureReflection, parseReport } = require('../system/telegram/evening.js');

const NOW = new Date(2026, 6, 19, 22, 0); // Sun Jul 19 2026, 10pm
const DAYS = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'];

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-test-'));
}

function mkNote(root, rel, front, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\n${front}\n---\n\n${body || 'body'}\n`);
}

test('weekWindow is the Monday→Sunday week containing now', () => {
  const w = weekWindow(NOW);
  assert.strictEqual(w.start, '2026-07-13');
  assert.strictEqual(w.end, '2026-07-19');
  assert.deepStrictEqual(w.days, DAYS);
  assert.strictEqual(w.label, 'Jul 13–19');
  // mid-week now still resolves to the same window
  assert.strictEqual(weekWindow(new Date(2026, 6, 15, 9, 0)).start, '2026-07-13');
});

test('windowLabel handles a month-spanning week', () => {
  assert.strictEqual(windowLabel('2026-06-29', '2026-07-05'), 'Jun 29 – Jul 5');
});

test('doneInWindow reads across a month boundary via per-month archives', () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, 'tasks', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'archive', '2026-06.md'),
    '- [x] june thing | src:manual | done:2026-06-30\n- [x] older | done:2026-06-20\n');
  fs.writeFileSync(path.join(root, 'tasks', 'archive', '2026-07.md'),
    '- [x] july thing | src:manual | done:2026-07-01\n');
  const days = ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
  const archives = readArchives(root, days);
  assert.deepStrictEqual(doneInWindow(archives, days), [
    { date: '2026-06-30', title: 'june thing' },
    { date: '2026-07-01', title: 'july thing' }
  ]);
});

test('notesInWindow keeps in-window notes and classifies by directory', () => {
  const root = mkRoot();
  mkNote(root, 'wiki/content/learning/a.md', 'title: Fresh learning\ndepartment: content\nupdated: 2026-07-15');
  mkNote(root, 'wiki/content/remembered/b.md', 'title: A fact\ndepartment: content\nupdated: 2026-07-13');
  mkNote(root, 'wiki/personal/journal/2026-07-14-brain-dump.md', 'title: Dump\ndepartment: personal\nupdated: 2026-07-14');
  mkNote(root, 'wiki/personal/health/2026-07-15.md', 'title: Health\ndepartment: personal\nupdated: 2026-07-15');
  mkNote(root, 'wiki/personal/people/jo.md', 'title: Jo\ndepartment: personal\nupdated: 2026-07-16');
  mkNote(root, 'wiki/business/plan.md', 'title: Plan\ndepartment: business\nupdated: 2026-07-17');
  mkNote(root, 'wiki/content/learning/stale.md', 'title: Stale\ndepartment: content\nupdated: 2026-07-05');
  const got = notesInWindow(root, DAYS);
  const byTitle = Object.fromEntries(got.map(n => [n.title, n.kind]));
  assert.deepStrictEqual(byTitle, {
    'Fresh learning': 'learning', 'A fact': 'remembered', Dump: 'journal',
    Health: 'health', Jo: 'person', Plan: 'note'
  });
});

test('noteBody strips frontmatter and caps length', () => {
  const t = '---\ntitle: X\nupdated: 2026-07-15\n---\n\nreal body here\n';
  assert.strictEqual(noteBody(t), 'real body here');
  assert.strictEqual(noteBody('abcdef', 3), 'abc…');
});

test('journalTexts returns only in-window dated journal files, full body', () => {
  const root = mkRoot();
  mkNote(root, 'wiki/personal/journal/2026-07-14-brain-dump.md', 'title: D1\ndepartment: personal\nupdated: 2026-07-14', 'felt scattered today');
  mkNote(root, 'wiki/personal/journal/2026-07-16-evening-reflection.md', 'title: R1\ndepartment: personal\nupdated: 2026-07-16', 'answered the question');
  mkNote(root, 'wiki/personal/journal/2026-07-05-brain-dump.md', 'title: Old\ndepartment: personal\nupdated: 2026-07-05', 'old week');
  const got = journalTexts(root, DAYS);
  assert.deepStrictEqual(got.map(j => [j.date, j.name]), [
    ['2026-07-14', 'brain-dump'], ['2026-07-16', 'evening-reflection']
  ]);
  assert.strictEqual(got[0].text, 'felt scattered today');
});

test('capturesInWindow collects dated inbox lines across the week', () => {
  const md = '- [2026-07-05] old\n- [2026-07-13] monday capture\n- [2026-07-19] sunday capture\n';
  assert.deepStrictEqual(capturesInWindow(md, DAYS), [
    { date: '2026-07-13', text: 'monday capture' },
    { date: '2026-07-19', text: 'sunday capture' }
  ]);
});

test('workoutsInWindow pulls workout bullets from daily health notes', () => {
  const root = mkRoot();
  const p = path.join(root, 'wiki', 'personal', 'health', '2026-07-14.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '---\ntitle: H\ndepartment: personal\nupdated: 2026-07-14\n---\n\n**Summary:** 9k steps\n\n## Workouts\n- 30 min strength\n');
  assert.deepStrictEqual(workoutsInWindow(root, DAYS), [{ date: '2026-07-14', workout: '30 min strength' }]);
});

test('weeklyBehaviorCounts counts days touched and flags barely-touched', () => {
  const root = mkRoot();
  // create-tagged done task on two days; nothing else all week
  const archives = {
    '2026-07': [
      '- [x] write script | behaviors:create | done:2026-07-14',
      '- [x] edit video | behaviors:create | done:2026-07-16'
    ].join('\n')
  };
  const got = weeklyBehaviorCounts(root, DAYS, archives);
  assert.strictEqual(got.counts.create, 2);
  assert.strictEqual(got.counts.move, 0);
  assert.ok(got.line.includes('create 2/7'));
  assert.ok(got.low.includes('move'));
  assert.ok(!got.low.includes('create'));
});

test('latestPulse honors the 10-day freshness cutoff', () => {
  const root = mkRoot();
  mkNote(root, 'wiki/business/pulse/2026-07-12.md', 'title: Pulse\ndepartment: business\nupdated: 2026-07-12', 'MRR steady');
  const fresh = latestPulse(root, '2026-07-19');
  assert.strictEqual(fresh.date, '2026-07-12');
  assert.ok(fresh.excerpt.includes('MRR steady'));
  assert.strictEqual(latestPulse(root, '2026-08-19'), null);
  assert.strictEqual(latestPulse(mkRoot(), '2026-07-19'), null);
});

test('healthLine formats an aggregated week and survives no data', () => {
  const cur = { health: { days: 6, coverage: '6/7', avgSteps: 8799.4, exerciseMin: 293, avgHrv: 38, avgRestingHr: null, mindfulMin: 12, mindfulDays: 3 } };
  const line = healthLine(cur);
  assert.ok(line.includes('avg steps 8799'));
  assert.ok(line.includes('exercise 293 min'));
  assert.strictEqual(healthLine({ health: { days: 0 } }), '(no health data this week)');
});

function sampleData() {
  return {
    window: { start: '2026-07-13', end: '2026-07-19', days: DAYS, label: 'Jul 13–19' },
    done: [{ date: '2026-07-14', title: 'shipped the fix' }],
    open: ['record intro'],
    learned: [{ title: 'Fresh learning', kind: 'learning', relPath: 'x', updated: '2026-07-15' }],
    people: [{ title: 'Jo', kind: 'person', relPath: 'y', updated: '2026-07-16' }],
    journals: [{ date: '2026-07-14', name: 'brain-dump', text: 'felt scattered' }],
    captures: [{ date: '2026-07-13', text: 'a link' }],
    health: {
      cur: { week: '2026-W29', health: { days: 6, coverage: '6/7', avgSteps: 4886, exerciseMin: null, avgHrv: null, avgRestingHr: null, mindfulMin: null, mindfulDays: 0 } },
      flags: [{ id: 'movement-collapse', week: '2026-W29', message: '2026-W29: movement collapsed.' }]
    },
    workouts: [{ date: '2026-07-14', workout: '30 min strength' }],
    behaviors: { counts: { move: 1, breathe: 0, create: 5, learn: 6, connect: 1 }, line: 'move 1/7 · breathe 0/7 · create 5/7 · learn 6/7 · connect 1/7', low: ['move', 'breathe', 'connect'] },
    pulse: { date: '2026-07-12', excerpt: 'MRR steady' }
  };
}

test('buildWeeklyPrompt carries every section, the she/her guard, and the focus ask', () => {
  const p = buildWeeklyPrompt(sampleData());
  for (const want of [
    'WEEKLY report for the week of Jul 13–19',
    'shipped the fix', 'Fresh learning', 'felt scattered', 'movement collapsed',
    'move 1/7', 'MRR steady',
    'What you\'re not seeing', 'Focus of the week',
    'she/her', 'COMMIT to the proposed focus',
    '300-450 word'
  ]) assert.ok(p.includes(want), `prompt missing: ${want}`);
});

test('plainWeekly fallback always yields text, speech, and a focus question', () => {
  const r = plainWeekly(sampleData());
  assert.ok(r.text.startsWith('🗓 Weekly report — Jul 13–19'));
  assert.ok(r.text.includes('movement collapsed'));
  assert.ok(r.question.includes('ONE focus'));
  assert.ok(r.speech.includes(r.question));
  assert.ok(parseReport(JSON.stringify(r))); // shape round-trips through the parser
});

test('captureReflection kind:weekly files a weekly-reflection note', () => {
  const root = mkRoot();
  const rel = captureReflection('Commit to the focus?', 'Yes — ship the launch.', { rootDir: root, date: '2026-07-19', kind: 'weekly' });
  assert.strictEqual(rel, path.join('wiki', 'personal', 'journal', '2026-07-19-weekly-reflection.md'));
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.ok(text.includes('title: Weekly reflection 2026-07-19'));
  assert.ok(text.includes('source: telegram:weekly'));
  assert.ok(text.includes('tags: [reflection, weekly-report]'));
  // default stays the nightly shape
  const rel2 = captureReflection('Q', 'A', { rootDir: root, date: '2026-07-18' });
  assert.ok(rel2.endsWith('2026-07-18-evening-reflection.md'));
});
