const { test } = require('node:test');
const assert = require('node:assert');
const { fmt12, fmtDay, parsePlan, formatProposal, confirmIntent } = require('../system/telegram/morning.js');
const { buildPlanPrompt, busyLines } = require('../system/telegram/extract.js');

const DAY = new Date(2026, 6, 7); // Jul 7 2026

test('fmt12 renders 24h HH:MM as 12-hour am/pm, null on junk', () => {
  assert.strictEqual(fmt12('13:00'), '1:00pm');
  assert.strictEqual(fmt12('00:05'), '12:05am');
  assert.strictEqual(fmt12('12:00'), '12:00pm');
  assert.strictEqual(fmt12('09:30'), '9:30am');
  assert.strictEqual(fmt12('18:00'), '6:00pm');
  assert.strictEqual(fmt12('nope'), null);
  assert.strictEqual(fmt12('25:00'), null);
});

test('parsePlan validates items and honors timed blocks', () => {
  const reply = '[{"title":"Edit video","start":"12:00","end":"15:00","calendar":true},' +
                '{"title":"Meet Isaiah","start":"18:00","end":"19:00","calendar":true},' +
                '{"title":"Call bank","start":null,"end":null,"calendar":false}]';
  const plan = parsePlan(reply);
  assert.strictEqual(plan.length, 3);
  assert.deepStrictEqual(plan[1], { title: 'Meet Isaiah', date: null, start: '18:00', end: '19:00', calendar: true, behaviors: [] });
  assert.strictEqual(plan[2].calendar, false);
  assert.strictEqual(plan[2].start, null);
});

test('parsePlan keeps a valid date and nulls junk dates', () => {
  const plan = parsePlan('[{"title":"a","date":"2026-07-09","calendar":false},' +
                         '{"title":"b","date":"tomorrow","calendar":false},' +
                         '{"title":"c","calendar":false}]');
  assert.strictEqual(plan[0].date, '2026-07-09');
  assert.strictEqual(plan[1].date, null);
  assert.strictEqual(plan[2].date, null);
});

test('fmtDay renders YYYY-MM-DD as a local weekday label', () => {
  assert.strictEqual(fmtDay('2026-07-09'), 'Thu Jul 9');
  assert.strictEqual(fmtDay('junk'), null);
});

test('parsePlan degrades a calendar item with no valid time to a plain to-do', () => {
  const plan = parsePlan('[{"title":"vague block","calendar":true}]');
  assert.strictEqual(plan[0].calendar, false);
  assert.strictEqual(plan[0].start, null);
});

test('parsePlan tolerates a code fence and drops titleless items', () => {
  const plan = parsePlan('```json\n[{"title":""},{"title":"real","calendar":false}]\n```');
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].title, 'real');
});

test('parsePlan returns [] on junk', () => {
  assert.deepStrictEqual(parsePlan('no plan'), []);
  assert.deepStrictEqual(parsePlan(''), []);
  assert.deepStrictEqual(parsePlan(null), []);
});

test('formatProposal splits calendar blocks from to-dos and honors stated times', () => {
  const plan = [
    { title: 'Edit video', start: '12:00', end: '15:00', calendar: true },
    { title: 'Meet Isaiah', start: '18:00', end: '19:00', calendar: true },
    { title: 'Call bank', start: null, end: null, calendar: false },
  ];
  const msg = formatProposal(plan, DAY);
  assert.match(msg, /Sam's plan — Tue Jul 7/);
  assert.match(msg, /12:00pm–3:00pm {2}Edit video/);
  assert.match(msg, /6:00pm–7:00pm {2}Meet Isaiah/);
  assert.match(msg, / • Call bank/);
  assert.match(msg, /Reply "yes" to save/);
});

test('formatProposal handles an empty plan gracefully', () => {
  assert.match(formatProposal([], DAY), /didn't catch any to-dos/);
});

test('formatProposal tags items dated later than today, leaves today untagged', () => {
  const plan = [
    { title: 'Edit video', date: '2026-07-07', start: '12:00', end: '15:00', calendar: true },
    { title: 'Dentist', date: '2026-07-09', start: '09:00', end: '10:00', calendar: true },
    { title: 'Call bank', date: '2026-07-08', start: null, end: null, calendar: false },
  ];
  const msg = formatProposal(plan, DAY);
  assert.match(msg, /Edit video\n/);           // today: no tag
  assert.match(msg, /Dentist {2}\(Thu Jul 9\)/);
  assert.match(msg, /Call bank {2}\(Wed Jul 8\)/);
});

test('confirmIntent detects yes / no / start-over / neither', () => {
  assert.strictEqual(confirmIntent('yes'), 'yes');
  assert.strictEqual(confirmIntent('looks good'), 'yes');
  assert.strictEqual(confirmIntent('perfect'), 'yes');
  assert.strictEqual(confirmIntent('no'), 'no');
  assert.strictEqual(confirmIntent('start over'), 'no');
  assert.strictEqual(confirmIntent('move Isaiah to 6pm'), null);
  assert.strictEqual(confirmIntent('drop the nap and add a workout'), null);
});

test('buildPlanPrompt embeds the current plan and the new message', () => {
  const cur = [{ title: 'Edit video', start: '12:00', end: '15:00', calendar: true }];
  const p = buildPlanPrompt(cur, 'move Isaiah to 6pm');
  assert.match(p, /CURRENT plan/);
  assert.match(p, /Edit video/);
  assert.match(p, /move Isaiah to 6pm/);
  assert.match(p, /EDIT/);
});

test('buildPlanPrompt tells the model what time it is now and the date rules', () => {
  const now = new Date(2026, 6, 7, 19, 12); // Tue Jul 7 2026, 7:12pm
  const p = buildPlanPrompt([], 'edit the video', now);
  assert.match(p, /Now: Tuesday Jul 7 2026, 7:12pm \(date 2026-07-07, time 19:12\)/);
  assert.match(p, /AFTER the current time/);
  assert.match(p, /"date": "YYYY-MM-DD" \| null/);
});

test('buildPlanPrompt handles the first (empty) turn', () => {
  const p = buildPlanPrompt([], 'edit the video and call the bank');
  assert.match(p, /no plan yet/);
  assert.match(p, /edit the video and call the bank/);
});

/* ------------------------- busy-aware planning --------------------------- */

const NOW = new Date(2026, 6, 8, 9, 0); // Wed Jul 8 2026, 9:00am

// Fixture of raw TickTick /project/{id}/data tasks (no network in tests).
const TT_TASKS = [
  { title: 'Deep work', startDate: '2026-07-08T13:00:00.000+0000', dueDate: '2026-07-08T15:00:00.000+0000', isAllDay: false },
  { title: 'Isaiah call', startDate: '2026-07-09T18:30:00-0400', dueDate: '2026-07-09T19:00:00-0400', isAllDay: false },
  { title: 'Groceries', startDate: null },                                              // dateless → skipped
  { title: 'Conference', startDate: '2026-07-08T00:00:00-0400', isAllDay: true },       // all-day → skipped
  { title: 'Next week thing', startDate: '2026-07-15T10:00:00-0400', dueDate: '2026-07-15T11:00:00-0400' }, // out of window
  { title: '', startDate: '2026-07-08T10:00:00-0400' },                                 // titleless → skipped
];

test('busyLines keeps only today/tomorrow timed tasks, sorted, local HH:MM', () => {
  const lines = busyLines(TT_TASKS, NOW);
  assert.strictEqual(lines.length, 2);
  // '2026-07-08T13:00:00.000+0000' is 9:00am ET; assert against the machine's local render.
  const dw = new Date('2026-07-08T13:00:00.000+0000');
  const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.strictEqual(lines[0], `${hm(dw)}-${hm(new Date('2026-07-08T15:00:00.000+0000'))} Deep work (2026-07-08)`);
  assert.strictEqual(lines[1], '18:30-19:00 Isaiah call (2026-07-09)');
});

test('busyLines tolerates junk input', () => {
  assert.deepStrictEqual(busyLines(null, NOW), []);
  assert.deepStrictEqual(busyLines([{ title: 'x', startDate: 'not a date' }], NOW), []);
});

test('buildPlanPrompt lists busy blocks with the do-not-double-book instruction', () => {
  const busy = ['09:00-10:00 Standup (2026-07-08)', '13:00-15:00 Deep work (2026-07-08)'];
  const p = buildPlanPrompt([], 'edit the video', NOW, busy);
  assert.match(p, /Already scheduled \(do NOT double-book these\):/);
  assert.match(p, /- 09:00-10:00 Standup \(2026-07-08\)/);
  assert.match(p, /- 13:00-15:00 Deep work \(2026-07-08\)/);
  assert.match(p, /remaining GAPS/);
  assert.match(p, /KEEP her stated time/);
  assert.match(p, /"overlaps"/);
});

test('fail-soft: no busy info → prompt is byte-identical to the pre-busy prompt', () => {
  const cur = [{ title: 'Edit video', start: '12:00', end: '15:00', calendar: true }];
  const base = buildPlanPrompt(cur, 'move Isaiah to 6pm', NOW);
  assert.strictEqual(buildPlanPrompt(cur, 'move Isaiah to 6pm', NOW, []), base);
  assert.strictEqual(buildPlanPrompt(cur, 'move Isaiah to 6pm', NOW, null), base);
  assert.doesNotMatch(base, /Already scheduled/);
  assert.doesNotMatch(base, /"overlaps"/);
});

test('parsePlan passes a non-empty overlaps tag through, omits the key otherwise', () => {
  const plan = parsePlan('[{"title":"Meet Isaiah","start":"13:30","end":"14:00","calendar":true,"overlaps":"Deep work"},' +
                         '{"title":"Call bank","calendar":false,"overlaps":null},' +
                         '{"title":"Nap","calendar":false,"overlaps":"  "}]');
  assert.strictEqual(plan[0].overlaps, 'Deep work');
  assert.ok(!('overlaps' in plan[1]));
  assert.ok(!('overlaps' in plan[2]));
});

test('formatProposal surfaces overlap tags on blocks and to-dos', () => {
  const plan = [
    { title: 'Meet Isaiah', start: '13:30', end: '14:00', calendar: true, overlaps: 'Deep work' },
    { title: 'Edit video', start: '15:00', end: '17:00', calendar: true },
    { title: 'Call bank', start: null, end: null, calendar: false, overlaps: 'Standup' },
  ];
  const msg = formatProposal(plan, DAY);
  assert.match(msg, /1:30pm–2:00pm {2}Meet Isaiah {2}⚠️ \(overlaps Deep work\)/);
  assert.match(msg, /Call bank {2}⚠️ \(overlaps Standup\)/);
  assert.doesNotMatch(msg, /Edit video.*overlaps/);
});
