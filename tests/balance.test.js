const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MIN_COVERAGE_DAYS,
  addDays, mondayOf, isoWeekKey,
  parseHealthNote, aggregateWeeks, computeFlags, formatTable
} = require('../system/balance.js');

// Fixed "today": Wed 2026-07-08 (ISO week 2026-W28, Mon 2026-07-06).
const TODAY = '2026-07-08';

/* ------------------------------- fixtures -------------------------------- */

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'balance-'));
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function healthNote(date, m) {
  const rows = [];
  if (m.steps != null) rows.push(`| Steps | ${m.steps} |`);
  if (m.exercise != null) rows.push(`| Exercise | ${m.exercise}min |`);
  if (m.hrv != null) rows.push(`| HRV | ${m.hrv}ms |`);
  if (m.rhr != null) rows.push(`| Resting HR | ${m.rhr}bpm |`);
  if (m.mindful != null) rows.push(`| Mindful minutes | ${m.mindful}min |`);
  const workouts = (m.workouts || []).map(w => `- ${w}`).join('\n');
  return [
    '---', `title: Health ${date}`, 'department: personal', 'tags: [health]',
    'behaviors: [move, breathe]', 'source: capture:health-auto-export', `updated: ${date}`, '---', '',
    `**Summary:** health for ${date}`, '',
    '| Metric | Value |', '|---|---|', ...rows, '',
    '## Workouts', '', workouts, ''
  ].join('\n');
}

function wikiNote(title, dept, date, behaviors) {
  return [
    '---', `title: ${title}`, `department: ${dept}`,
    `behaviors: [${(behaviors || []).join(', ')}]`, `updated: ${date}`, '---', '', 'body', ''
  ].join('\n');
}

// A full week of healthy data starting at monday, n days (default 7).
function fillHealthWeek(root, monday, n, m) {
  for (let i = 0; i < (n == null ? 7 : n); i++) {
    const d = addDays(monday, i);
    write(root, `wiki/personal/health/${d}.md`, healthNote(d, m));
  }
}

function agg(root, weeks) {
  return aggregateWeeks(root, { today: TODAY, weeks: weeks || 4 });
}

// Synthetic week objects for direct flag-boundary tests.
function mkWeek(over) {
  const w = {
    week: '2026-W28', start: '2026-07-06', end: '2026-07-12', partial: false,
    health: { days: 7, coverage: '7/7', avgSteps: 8000, exerciseMin: 200, avgHrv: 40, avgRestingHr: 60, mindfulMin: 60, mindfulDays: 7, workouts: 5 },
    output: { tasksDone: 10, notesByDept: {}, workNotes: 0, workOutput: 10, inboxCaptures: 0 },
    connect: 2,
    behaviorDays: { move: 3, breathe: 3, create: 3, learn: 3, connect: 2 }
  };
  const merged = { ...w, ...over };
  merged.health = { ...w.health, ...(over && over.health) };
  merged.output = { ...w.output, ...(over && over.output) };
  merged.behaviorDays = { ...w.behaviorDays, ...(over && over.behaviorDays) };
  return merged;
}

/* ----------------------------- date handling ----------------------------- */

test('isoWeekKey: ISO weeks incl. year boundaries', () => {
  assert.strictEqual(isoWeekKey('2026-07-08'), '2026-W28');
  assert.strictEqual(isoWeekKey('2026-07-06'), '2026-W28'); // Monday
  assert.strictEqual(isoWeekKey('2026-07-05'), '2026-W27'); // Sunday before
  assert.strictEqual(isoWeekKey('2025-12-29'), '2026-W01'); // ISO year != calendar year
  assert.strictEqual(isoWeekKey('2026-01-01'), '2026-W01');
  assert.strictEqual(isoWeekKey('2027-01-03'), '2026-W53'); // 2026 has 53 ISO weeks
  assert.strictEqual(isoWeekKey('garbage'), null);
});

test('mondayOf/addDays stay in local time across the US DST switch (no UTC drift)', () => {
  // 2026-03-08 (DST starts, US) is a Sunday: its ISO week starts Mon 2026-03-02.
  assert.strictEqual(mondayOf('2026-03-08'), '2026-03-02');
  assert.strictEqual(addDays('2026-03-07', 1), '2026-03-08');
  assert.strictEqual(addDays('2026-03-08', 1), '2026-03-09');
  // 2026-11-01 (DST ends): +1 day is still exactly one calendar day.
  assert.strictEqual(addDays('2026-10-31', 2), '2026-11-02');
});

/* -------------------------- health note parsing -------------------------- */

test('parseHealthNote: full real-format note', () => {
  const n = parseHealthNote(healthNote('2026-07-07', {
    steps: '11,769', exercise: 36, hrv: 38, rhr: 64, mindful: 29,
    workouts: ['Mind and Body (30min)', 'Walking (48min)']
  }));
  assert.strictEqual(n.steps, 11769);
  assert.strictEqual(n.exerciseMin, 36);
  assert.strictEqual(n.hrv, 38);
  assert.strictEqual(n.restingHr, 64);
  assert.strictEqual(n.mindfulMin, 29);
  assert.strictEqual(n.workouts, 2);
  assert.strictEqual(n.hasData, true);
});

test('parseHealthNote: missing fields are null, partial table still counts', () => {
  const n = parseHealthNote(healthNote('2026-07-07', { steps: 5000 }));
  assert.strictEqual(n.steps, 5000);
  assert.strictEqual(n.hrv, null);
  assert.strictEqual(n.restingHr, null);
  assert.strictEqual(n.mindfulMin, null);
  assert.strictEqual(n.workouts, 0);
  assert.strictEqual(n.hasData, true);
});

test('parseHealthNote: falls back to the Summary line when the table is absent', () => {
  const n = parseHealthNote([
    '---', 'title: Health', '---', '',
    '**Summary:** 11,769 steps, 36min exercise, HRV 38ms, resting HR 64bpm, 29min mindful', ''
  ].join('\n'));
  assert.strictEqual(n.steps, 11769);
  assert.strictEqual(n.exerciseMin, 36);
  assert.strictEqual(n.hrv, 38);
  assert.strictEqual(n.restingHr, 64);
  assert.strictEqual(n.mindfulMin, 29);
});

test('parseHealthNote: junk / empty input has no data', () => {
  assert.strictEqual(parseHealthNote('').hasData, false);
  assert.strictEqual(parseHealthNote(null).hasData, false);
  assert.strictEqual(parseHealthNote('just some prose, no metrics').hasData, false);
});

/* ------------------------------ aggregation ------------------------------ */

test('aggregateWeeks: ISO week bucketing across the boundary + coverage', () => {
  const root = mkRoot();
  // Sun 2026-07-05 belongs to W27; Mon 2026-07-06 to W28 (current, partial).
  write(root, 'wiki/personal/health/2026-07-05.md', healthNote('2026-07-05', { steps: 4000, hrv: 40 }));
  write(root, 'wiki/personal/health/2026-07-06.md', healthNote('2026-07-06', { steps: 5405, hrv: 38 }));
  write(root, 'wiki/personal/health/2026-07-07.md', healthNote('2026-07-07', { steps: 11769, hrv: 38 }));
  // Out of window entirely (months earlier) — ignored.
  write(root, 'wiki/personal/health/2026-01-01.md', healthNote('2026-01-01', { steps: 999 }));

  const weeks = agg(root);
  assert.strictEqual(weeks.length, 4);
  assert.deepStrictEqual(weeks.map(w => w.week), ['2026-W25', '2026-W26', '2026-W27', '2026-W28']);
  const [w27, w28] = weeks.slice(2);
  assert.strictEqual(w27.health.days, 1);
  assert.strictEqual(w27.health.coverage, '1/7');
  assert.strictEqual(w27.health.avgSteps, 4000);
  assert.strictEqual(w27.partial, false);
  assert.strictEqual(w28.health.days, 2);
  assert.strictEqual(w28.health.avgSteps, (5405 + 11769) / 2);
  assert.strictEqual(w28.health.avgHrv, 38);
  assert.strictEqual(w28.partial, true);
  assert.strictEqual(weeks[0].health.days, 0); // untouched week stays empty
  // health notes feed the health columns only — never the notes-updated count
  assert.strictEqual(w28.output.notesByDept.personal, undefined);
});

test('aggregateWeeks: output load, connect signals, and inbox captures', () => {
  const root = mkRoot();
  // Tasks: two done in W28, one in W27, one outside the window.
  write(root, 'tasks/archive/2026-07.md', [
    '# Archive 2026-07',
    '- [x] a | due:none | src:manual | behaviors:create | link:none | done:2026-07-06',
    '- [x] b | due:none | src:manual | behaviors:none | link:none | done:2026-07-07',
    '- [x] c | due:none | src:manual | behaviors:none | link:none | done:2026-07-05',
    '- [x] old | due:none | src:manual | behaviors:none | link:none | done:2026-01-02',
    '- [ ] not done | due:none | src:manual | behaviors:none | link:none', ''
  ].join('\n'));
  // Wiki notes: content + business = work output; personal is not.
  write(root, 'wiki/content/idea.md', wikiNote('Idea', 'content', '2026-07-07', ['create']));
  write(root, 'wiki/business/pulse/x.md', wikiNote('Pulse', 'business', '2026-07-06', []));
  write(root, 'wiki/personal/journal/j.md', wikiNote('Journal', 'personal', '2026-07-07', []));
  // Connect: a people note + a connections journal note, both in W28.
  write(root, 'wiki/personal/people/jordan.md', wikiNote('Jordan', 'personal', '2026-07-07', ['connect']));
  write(root, 'wiki/personal/journal/2026-07-06-connections.md', wikiNote('Connections', 'personal', '2026-07-06', ['connect']));
  // Inbox captures.
  write(root, 'inbox/inbox.md', [
    '- [2026-07-07] https://example.com/thing',
    '- [2026-07-01] older capture',
    '- [2026-07-07]    ', // blank text → not a capture
    '- [ ] not a capture', ''
  ].join('\n'));

  const weeks = agg(root);
  const w27 = weeks[2], w28 = weeks[3];
  assert.strictEqual(w28.output.tasksDone, 2);
  assert.strictEqual(w27.output.tasksDone, 1);
  assert.strictEqual(w28.output.notesByDept.content, 1);
  assert.strictEqual(w28.output.notesByDept.business, 1);
  assert.strictEqual(w28.output.workNotes, 2);
  assert.strictEqual(w28.output.workOutput, 4); // 2 tasks + 2 work notes
  assert.strictEqual(w28.connect, 2); // people note + connections note
  assert.strictEqual(w28.output.inboxCaptures, 1);
  assert.strictEqual(w27.output.inboxCaptures, 1); // 2026-07-01 is in W27
  assert.strictEqual(w28.behaviorDays.connect, 2); // two distinct days
  assert.strictEqual(w28.behaviorDays.create, 2); // task 07-06 + note 07-07
});

/* ----------------------------- flag boundaries ---------------------------- */

test('recovery-down-output-up: fires past both thresholds, not at them', () => {
  const prior = mkWeek({ week: '2026-W27', health: { avgHrv: 40 }, output: { workOutput: 100 } });
  // HRV -11%, output +26% → fires
  let flags = computeFlags([prior, mkWeek({ health: { avgHrv: 35.6 }, output: { workOutput: 126 } })]);
  assert.deepStrictEqual(flags.map(f => f.id), ['recovery-down-output-up']);
  assert.strictEqual(flags[0].week, '2026-W28');
  assert.ok(flags[0].message.length > 20);
  // HRV exactly -10% → no fire
  flags = computeFlags([prior, mkWeek({ health: { avgHrv: 36 }, output: { workOutput: 126 } })]);
  assert.deepStrictEqual(flags, []);
  // HRV -11% but output exactly +25% → no fire
  flags = computeFlags([prior, mkWeek({ health: { avgHrv: 35.6 }, output: { workOutput: 125 } })]);
  assert.deepStrictEqual(flags, []);
  // prior output 0 → any output counts as up
  flags = computeFlags([
    mkWeek({ week: '2026-W27', health: { avgHrv: 40 }, output: { workOutput: 0 } }),
    mkWeek({ health: { avgHrv: 35 }, output: { workOutput: 3 } })
  ]);
  assert.deepStrictEqual(flags.map(f => f.id), ['recovery-down-output-up']);
});

test('movement-collapse: fires below -40% of the window mean, not at -40%', () => {
  const base = n => mkWeek({ week: `2026-W2${n}`, health: { avgSteps: 10000 } });
  // 5900 vs mean 10000 → -41% → fires (for the last week only)
  let flags = computeFlags([base(5), base(6), base(7), mkWeek({ health: { avgSteps: 5900 } })]);
  assert.deepStrictEqual(flags.map(f => f.id), ['movement-collapse']);
  assert.strictEqual(flags[0].week, '2026-W28');
  // exactly -40% → no fire
  flags = computeFlags([base(5), base(6), base(7), mkWeek({ health: { avgSteps: 6000 } })]);
  assert.deepStrictEqual(flags, []);
});

test('no-breathe: fires at zero mindful with output >= mean, not with any mindful', () => {
  const busy = mkWeek({ week: '2026-W27', output: { workOutput: 10 } });
  // mindful 0, output 10 = mean 10 → fires (>= mean)
  let flags = computeFlags([busy, mkWeek({ health: { mindfulMin: 0 }, output: { workOutput: 10 } })]);
  assert.deepStrictEqual(flags.map(f => f.id), ['no-breathe']);
  // mindful 0 but output below mean → no fire
  flags = computeFlags([busy, mkWeek({ health: { mindfulMin: 0 }, output: { workOutput: 5 } })]);
  assert.deepStrictEqual(flags, []);
  // any mindful minutes → no fire
  flags = computeFlags([busy, mkWeek({ health: { mindfulMin: 5 }, output: { workOutput: 20 } })]);
  assert.deepStrictEqual(flags, []);
});

test('connect-drought: needs 2+ consecutive zero weeks; fires once per run', () => {
  // one zero week → no fire
  let flags = computeFlags([mkWeek({ week: '2026-W27', connect: 3 }), mkWeek({ connect: 0 })]);
  assert.deepStrictEqual(flags, []);
  // two zero weeks → fires once, at the run's end
  flags = computeFlags([mkWeek({ week: '2026-W27', connect: 0 }), mkWeek({ connect: 0 })]);
  assert.deepStrictEqual(flags.map(f => f.id), ['connect-drought']);
  assert.strictEqual(flags.length, 1);
  assert.strictEqual(flags[0].week, '2026-W28');
  // three zero weeks → still one flag, mentioning 3 weeks
  flags = computeFlags([
    mkWeek({ week: '2026-W26', connect: 0 }),
    mkWeek({ week: '2026-W27', connect: 0 }),
    mkWeek({ connect: 0 })
  ]);
  assert.strictEqual(flags.length, 1);
  assert.match(flags[0].message, /3 consecutive weeks/);
});

test('streak: all five behaviors on >= 5 days fires; one behavior at 4 does not', () => {
  const all5 = { move: 5, breathe: 5, create: 6, learn: 5, connect: 7 };
  let flags = computeFlags([mkWeek({ behaviorDays: all5 })]);
  assert.deepStrictEqual(flags.map(f => f.id), ['streak']);
  assert.match(flags[0].message, /balanced/i); // says it's positive
  flags = computeFlags([mkWeek({ behaviorDays: { ...all5, learn: 4 } })]);
  assert.deepStrictEqual(flags, []);
});

/* ----------------------------- coverage guard ----------------------------- */

test('coverage guard: no health/connect flags when either week has <4 days of data', () => {
  assert.strictEqual(MIN_COVERAGE_DAYS, 4);
  const sparse = { days: 3, coverage: '3/7' };
  // dramatic HRV drop + output spike, but only 3 days of data each week
  let flags = computeFlags([
    mkWeek({ week: '2026-W27', health: { ...sparse, avgHrv: 60 }, output: { workOutput: 1 } }),
    mkWeek({ health: { ...sparse, avgHrv: 20, avgSteps: 100, mindfulMin: 0 }, output: { workOutput: 50 }, connect: 0 })
  ]);
  assert.deepStrictEqual(flags, []);
  // same numbers with 4-day coverage → flags fire
  flags = computeFlags([
    mkWeek({ week: '2026-W27', health: { days: 4, avgHrv: 60, avgSteps: 10000 }, output: { workOutput: 1 }, connect: 0 }),
    mkWeek({ health: { days: 4, avgHrv: 20, avgSteps: 100, mindfulMin: 0 }, output: { workOutput: 50 }, connect: 0 })
  ]);
  assert.deepStrictEqual(
    flags.map(f => f.id).sort(),
    ['connect-drought', 'movement-collapse', 'no-breathe', 'recovery-down-output-up']);
});

test('end-to-end on sparse real-shaped fixture: aggregates fine, zero flags', () => {
  const root = mkRoot();
  // Only 2 days of health notes (like the real repo right now) with scary deltas.
  write(root, 'wiki/personal/health/2026-07-06.md', healthNote('2026-07-06', { steps: 20000, hrv: 80, mindful: 0 }));
  write(root, 'wiki/personal/health/2026-07-07.md', healthNote('2026-07-07', { steps: 500, hrv: 20, mindful: 0 }));
  write(root, 'tasks/archive/2026-07.md', '- [x] t | behaviors:none | done:2026-07-07\n');
  const weeks = agg(root);
  assert.strictEqual(weeks[3].health.days, 2);
  assert.deepStrictEqual(computeFlags(weeks), []);
  const table = formatTable(weeks, []);
  assert.match(table, /none — nothing tripping/);
});

test('end-to-end fixture with dense data: recovery flag fires from real files', () => {
  const root = mkRoot();
  // Dense data in the two FULL weeks before the current partial one:
  // W26 full week HRV 50, W27 full week HRV 40 (-20%), same steps + mindful.
  const w26mon = '2026-06-22', w27mon = '2026-06-29';
  fillHealthWeek(root, w26mon, 7, { steps: 9000, hrv: 50, mindful: 10 });
  fillHealthWeek(root, w27mon, 7, { steps: 9000, hrv: 40, mindful: 10 });
  // Output: W26 has 4 done tasks, W27 has 8 (+100%).
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(`- [x] a${i} | behaviors:none | done:${addDays(w26mon, i)}`);
  for (let i = 0; i < 8; i++) lines.push(`- [x] b${i} | behaviors:none | done:${addDays(w27mon, i % 7)}`);
  write(root, 'tasks/archive/2026-06.md', lines.join('\n') + '\n');
  const weeks = agg(root);
  const flags = computeFlags(weeks);
  assert.ok(flags.some(f => f.id === 'recovery-down-output-up' && f.week === '2026-W27'),
    `expected recovery flag, got ${JSON.stringify(flags)}`);
});

/* --------------------------------- output --------------------------------- */

test('formatTable: one row per week, partial marker, em-dash for missing data', () => {
  const root = mkRoot();
  write(root, 'wiki/personal/health/2026-07-07.md', healthNote('2026-07-07', { steps: 11769, exercise: 36, hrv: 38 }));
  const weeks = agg(root);
  const out = formatTable(weeks, computeFlags(weeks));
  assert.match(out, /week\s+cov\s+steps avg\s+exercise min\s+HRV\s+done\s+notes\s+connect/);
  assert.match(out, /2026-W28\*/); // current week marked partial
  assert.match(out, /2026-W25\s+0\/7\s+—/); // empty week shows em-dashes
  assert.match(out, /11769/);
  assert.strictEqual(out.split('\n').filter(l => /^\d{4}-W\d{2}/.test(l)).length, 4);
});

test('JSON shape: weeks + flags round-trips', () => {
  const root = mkRoot();
  write(root, 'wiki/personal/health/2026-07-07.md', healthNote('2026-07-07', { steps: 100 }));
  const weeks = agg(root);
  const parsed = JSON.parse(JSON.stringify({ weeks, flags: computeFlags(weeks) }));
  assert.strictEqual(parsed.weeks.length, 4);
  assert.deepStrictEqual(parsed.flags, []);
  const w = parsed.weeks[3];
  assert.strictEqual(w.week, '2026-W28');
  assert.strictEqual(w.health.coverage, '1/7');
  assert.ok('tasksDone' in w.output && 'workOutput' in w.output && 'inboxCaptures' in w.output);
  assert.ok('connect' in w && 'behaviorDays' in w);
});
