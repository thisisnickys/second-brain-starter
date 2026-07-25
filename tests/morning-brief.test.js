const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  daysBetween, parseLooseDate, tasksForToday,
  parseDealNote, dealDeadlineSoon, dealGoingCold, dealNurtureDue, dealSignals, readDeals,
  behaviorInvitation, todaysBlocks, ledgerProjectId, countsLine,
  buildBriefPrompt, parseBrief, plainBrief, loadMorningConfig, gather, syncTickTickTruth
} = require('../system/telegram/morning-brief.js');

const NOW = new Date(2026, 6, 8, 8, 0); // Wed Jul 8 2026, 8am
const TODAY = '2026-07-08';

/* ------------------------------- loose dates -------------------------------- */

test('parseLooseDate handles ISO, month-name, and year rollover', () => {
  assert.strictEqual(parseLooseDate('next follow-up 2026-07-10 if no reply', TODAY), '2026-07-10');
  assert.strictEqual(parseLooseDate('planning call Jul 23', TODAY), '2026-07-23');
  assert.strictEqual(parseLooseDate('due July 9', TODAY), '2026-07-09');
  // A month-name date >60 days in the past rolls to next year.
  assert.strictEqual(parseLooseDate('Jan 5', TODAY), '2027-01-05');
  assert.strictEqual(parseLooseDate('none stated', TODAY), null);
  assert.strictEqual(parseLooseDate('', TODAY), null);
});

test('daysBetween is signed whole days', () => {
  assert.strictEqual(daysBetween('2026-07-10', TODAY), 2);
  assert.strictEqual(daysBetween('2026-07-01', TODAY), -7);
  assert.strictEqual(daysBetween('garbage', TODAY), null);
});

/* --------------------------------- tasks ------------------------------------ */

test('tasksForToday splits due-today/overdue vs other Actives', () => {
  const md = [
    '# Tasks', '', '## Active', '',
    '- [ ] Ship the brief | due:2026-07-08 | src:manual | behaviors:none | link:none',
    '- [ ] Old one | due:2026-07-05 | src:telegram | behaviors:none | link:none',
    '- [ ] Future | due:2026-07-20 | src:manual | behaviors:none | link:none',
    '- [ ] No due | due:none | src:manual | behaviors:none | link:none',
    '- [x] Done | due:2026-07-08 | done:2026-07-08',
    '', '## Proposed (confirm or kill)',
    '- [ ] proposal | due:2026-07-08 | src:manual | behaviors:none | link:none'
  ].join('\n');
  const r = tasksForToday(md, TODAY);
  assert.deepStrictEqual(r.dueNow.map(t => t.title), ['Old one', 'Ship the brief']); // sorted by due
  assert.strictEqual(r.dueNow[0].overdue, true);
  assert.strictEqual(r.dueNow[1].overdue, false);
  assert.strictEqual(r.otherActive, 2); // Future + No due
  assert.deepStrictEqual(tasksForToday('', TODAY), { dueNow: [], otherActive: 0 });
});

/* --------------------------------- deals ------------------------------------ */

const dealMd = (fields) => [
  '---',
  `title: ${fields.title || 'Acme sponsorship'}`,
  'department: business',
  `updated: ${fields.updated || '2026-07-08'}`,
  '---',
  '',
  `**Status:** ${fields.status || 'new'}`,
  fields.deadline != null ? `**Deadline:** ${fields.deadline}` : null,
  fields.nurture != null ? `**Nurture:** ${fields.nurture}` : null,
  fields.nextAction != null ? `**Next action:** ${fields.nextAction}` : null
].filter(l => l !== null).join('\n');

test('parseDealNote extracts the signal fields', () => {
  const d = parseDealNote(dealMd({ deadline: 'planning call Jul 23', nurture: 'next follow-up 2026-07-10', nextAction: 'reply yes' }), 'x.md');
  assert.strictEqual(d.title, 'Acme sponsorship');
  assert.strictEqual(d.status, 'new');
  assert.strictEqual(d.updated, '2026-07-08');
  assert.strictEqual(d.deadlineRaw, 'planning call Jul 23');
  assert.strictEqual(d.nurtureRaw, 'next follow-up 2026-07-10');
  assert.strictEqual(d.nextAction, 'reply yes');
});

test('dealDeadlineSoon: within 7 days, urgency text, and the none/status/far filters', () => {
  const mk = f => parseDealNote(dealMd(f));
  // dated within 7 days
  const hit = dealDeadlineSoon(mk({ deadline: 'call on Jul 10' }), TODAY);
  assert.deepStrictEqual(hit, { date: '2026-07-10', daysLeft: 2 });
  // deadline TODAY
  assert.strictEqual(dealDeadlineSoon(mk({ deadline: '2026-07-08 signature' }), TODAY).daysLeft, 0);
  // urgency text with no parseable date
  const urgent = dealDeadlineSoon(mk({ deadline: 'roster finalized this week' }), TODAY);
  assert.deepStrictEqual(urgent, { date: null, daysLeft: null });
  // dated beyond 7 days → not hot, even though 'this week' style words absent
  assert.strictEqual(dealDeadlineSoon(mk({ deadline: 'publish window Jul 21' }), TODAY), null);
  // already past → not hot
  assert.strictEqual(dealDeadlineSoon(mk({ deadline: 'was due Jul 6' }), TODAY), null);
  // "none — ..." lines never count
  assert.strictEqual(dealDeadlineSoon(mk({ deadline: 'none — GOING COLD (7 weeks)' }), TODAY), null);
  // only new/reviewed statuses
  assert.strictEqual(dealDeadlineSoon(mk({ deadline: 'Jul 10', status: 'won' }), TODAY), null);
  assert.ok(dealDeadlineSoon(mk({ deadline: 'Jul 10', status: 'reviewed' }), TODAY));
});

test('dealGoingCold: new/reviewed untouched 7+ days', () => {
  const mk = f => parseDealNote(dealMd(f));
  assert.strictEqual(dealGoingCold(mk({ updated: '2026-07-01' }), TODAY), true);   // 7 days
  assert.strictEqual(dealGoingCold(mk({ updated: '2026-07-02' }), TODAY), false);  // 6 days
  assert.strictEqual(dealGoingCold(mk({ updated: '2026-06-01', status: 'negotiating' }), TODAY), false);
  assert.strictEqual(dealGoingCold(mk({ updated: '2026-06-01', status: 'reviewed' }), TODAY), true);
});

test('dealNurtureDue: "next follow-up <date>" today or overdue, never on dead deals', () => {
  const mk = f => parseDealNote(dealMd(f));
  const due = dealNurtureDue(mk({ nurture: 'next follow-up 2026-07-08 if no reply' }), TODAY);
  assert.deepStrictEqual(due, { date: '2026-07-08', overdueDays: 0 });
  const over = dealNurtureDue(mk({ nurture: 'next follow-up 2026-07-05' }), TODAY);
  assert.strictEqual(over.overdueDays, 3);
  assert.strictEqual(dealNurtureDue(mk({ nurture: 'next follow-up 2026-07-12' }), TODAY), null);
  assert.strictEqual(dealNurtureDue(mk({ nurture: 'post-event — testimonial + case study' }), TODAY), null);
  assert.strictEqual(dealNurtureDue(mk({ nurture: 'next follow-up 2026-07-05', status: 'dead' }), TODAY), null);
});

test('dealSignals sorts hot by nearest deadline (urgency-only last) and counts statuses', () => {
  const deals = [
    parseDealNote(dealMd({ title: 'B', deadline: 'Jul 12' })),
    parseDealNote(dealMd({ title: 'A', deadline: 'Jul 9' })),
    parseDealNote(dealMd({ title: 'C', deadline: 'needs answer this week' })),
    parseDealNote(dealMd({ title: 'W', status: 'won' })),
    parseDealNote(dealMd({ title: 'N', status: 'negotiating' }))
  ];
  const s = dealSignals(deals, TODAY);
  assert.deepStrictEqual(s.hot.map(d => d.title), ['A', 'B', 'C']);
  assert.deepStrictEqual(s.counts, { new: 3, won: 1, negotiating: 1 });
  assert.strictEqual(countsLine(s.counts), '3 new · 1 negotiating · 1 won');
});

test('readDeals walks the opportunities dir (fixture)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-test-'));
  const dir = path.join(root, 'wiki', 'business', 'opportunities');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), dealMd({ title: 'Fixture deal', deadline: 'Jul 10' }));
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not a note');
  const deals = readDeals(root);
  assert.strictEqual(deals.length, 1);
  assert.strictEqual(deals[0].title, 'Fixture deal');
  assert.deepStrictEqual(readDeals(path.join(root, 'nope')), []);
});

/* ---------------------------- behaviors + blocks ----------------------------- */

test('behaviorInvitation picks one untouched behavior, rotating by day', () => {
  assert.strictEqual(behaviorInvitation([], NOW), null);
  assert.strictEqual(behaviorInvitation(null, NOW), null);
  assert.strictEqual(behaviorInvitation(['connect'], NOW), 'connect');
  const pick = behaviorInvitation(['create', 'connect'], NOW); // day 8 → index 0
  assert.strictEqual(pick, 'create');
});

test('todaysBlocks keeps open tasks starting today, sorted, all-day without a time', () => {
  const iso = (h, m) => new Date(2026, 6, 8, h, m).toISOString();
  const tasks = [
    { title: 'Deep work', startDate: iso(13, 0), status: 0 },
    { title: 'Gym', startDate: iso(7, 30), status: 0 },
    { title: 'Done already', startDate: iso(9, 0), status: 2 },
    { title: 'Tomorrow', startDate: new Date(2026, 6, 9, 9, 0).toISOString(), status: 0 },
    { title: 'All day', startDate: iso(0, 0), status: 0, isAllDay: true },
    { title: 'No start', status: 0 }
  ];
  const b = todaysBlocks(tasks, TODAY);
  assert.deepStrictEqual(b, [
    { title: 'All day', time: null },
    { title: 'Gym', time: '7:30 AM' },
    { title: 'Deep work', time: '1:00 PM' }
  ]);
  assert.deepStrictEqual(todaysBlocks(null, TODAY), []);
});

test('ledgerProjectId returns the newest valid projectId, skipping junk lines', () => {
  const text = [
    '{"id":"t1","projectId":"inboxABC","title":"a","date":"2026-07-07"}',
    'not json',
    '{"id":"t2","title":"no project"}',
    '{"id":"t3","projectId":"inboxXYZ","title":"b","date":"2026-07-08"}'
  ].join('\n');
  assert.strictEqual(ledgerProjectId(text), 'inboxXYZ');
  assert.strictEqual(ledgerProjectId(''), null);
  assert.strictEqual(ledgerProjectId(null), null);
});

/* ------------------------------ compose + config ----------------------------- */

const sampleData = () => ({
  today: TODAY, yesterday: '2026-07-07',
  tasks: { dueNow: [{ title: 'Ship it', due: TODAY, overdue: false }], otherActive: 2 },
  deals: {
    hot: [parseDealNote(dealMd({ title: 'Acme', deadline: 'Jul 10', nextAction: 'send counter' }))].map(d => ({ ...d, deadline: { date: '2026-07-10', daysLeft: 2 } })),
    cold: [parseDealNote(dealMd({ title: 'Frosty', updated: '2026-06-20' }))],
    nurture: [{ ...parseDealNote(dealMd({ title: 'Warm' })), nurture: { date: '2026-07-08', overdueDays: 0 } }],
    counts: { new: 3, won: 1 }
  },
  behaviorsUntouched: ['create', 'connect'],
  invitation: 'connect',
  blocks: [{ title: 'Gym', time: '7:30 AM' }]
});

test('buildBriefPrompt carries every gathered section', () => {
  const p = buildBriefPrompt(sampleData(), NOW);
  assert.ok(p.includes('Wednesday Jul 8'));
  assert.ok(p.includes('7:30 AM — Gym'));
  assert.ok(p.includes('Ship it'));
  assert.ok(p.includes('Acme'));
  assert.ok(p.includes('send counter'));
  assert.ok(p.includes('Frosty'));
  assert.ok(p.includes('Warm'));
  assert.ok(p.includes('connect'));
  assert.ok(p.includes('Under 1800 characters'));
  assert.ok(p.includes('she/her'));
});

test('parseBrief extracts {text} and rejects junk', () => {
  assert.deepStrictEqual(parseBrief('noise {"text": "hi"} tail'), { text: 'hi' });
  assert.strictEqual(parseBrief('{"text": ""}'), null);
  assert.strictEqual(parseBrief('no json here'), null);
  assert.strictEqual(parseBrief('{"speech": "x"}'), null);
});

test('plainBrief includes all sections mechanically and skips empty ones', () => {
  const t = plainBrief(sampleData(), NOW).text;
  assert.ok(t.startsWith('☀️ Morning brief — Wednesday Jul 8'));
  assert.ok(t.includes('Gym'));
  assert.ok(t.includes('Ship it'));
  assert.ok(t.includes('Acme'));
  assert.ok(t.includes('deadline 2026-07-10'));
  assert.ok(t.includes('Frosty'));
  assert.ok(t.includes('Warm'));
  assert.ok(t.includes('Pipeline: 3 new · 1 won'));
  assert.ok(t.includes('"connect" went untouched'));
  // empty everything → still a valid brief, no empty headers
  const empty = plainBrief({
    today: TODAY, yesterday: '2026-07-07',
    tasks: { dueNow: [], otherActive: 0 },
    deals: { hot: [], cold: [], nurture: [], counts: {} },
    behaviorsUntouched: [], invitation: null, blocks: null
  }, NOW).text;
  assert.ok(empty.startsWith('☀️ Morning brief'));
  assert.ok(!empty.includes('💼'));
  assert.ok(!empty.includes('📅'));
});

test('loadMorningConfig reads .env keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-env-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_ALLOWED_USER_ID=42\nTICKTICK_ACCESS_TOKEN=tt\n# comment\n');
  const cfg = loadMorningConfig(envPath);
  assert.strictEqual(cfg.token, 'tok');
  assert.strictEqual(cfg.chatId, '42');
  assert.strictEqual(cfg.ticktickToken, 'tt');
  assert.strictEqual(cfg.ticktickListId, '');
});

test('gather wires tasks, deals, and yesterday-behaviors from a fixture root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-gather-'));
  fs.mkdirSync(path.join(root, 'tasks', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki', 'business', 'opportunities'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'tasks.md'), [
    '## Active',
    '- [ ] Due thing | due:2026-07-08 | src:manual | behaviors:none | link:none',
    '- [ ] Someday | due:none | src:manual | behaviors:none | link:none'
  ].join('\n'));
  // yesterday's archive: only "move" touched → invitation from the untouched four
  fs.writeFileSync(path.join(root, 'tasks', 'archive', '2026-07.md'),
    '- [x] Walk | due:none | src:manual | behaviors:move | link:none | done:2026-07-07\n');
  fs.writeFileSync(path.join(root, 'wiki', 'business', 'opportunities', 'd.md'),
    dealMd({ title: 'Hot deal', deadline: 'Jul 9' }));
  const data = gather(root, NOW);
  assert.strictEqual(data.today, TODAY);
  assert.strictEqual(data.yesterday, '2026-07-07');
  assert.deepStrictEqual(data.tasks.dueNow.map(t => t.title), ['Due thing']);
  assert.strictEqual(data.tasks.otherActive, 1);
  assert.strictEqual(data.deals.hot[0].title, 'Hot deal');
  assert.ok(!data.behaviorsUntouched.includes('move'));
  assert.ok(data.behaviorsUntouched.length === 4);
  assert.ok(data.behaviorsUntouched.includes(data.invitation));
  assert.strictEqual(data.blocks, null);
});

/* --------------------------- TickTick pre-sync ------------------------------ */
// Tasks checked off in the TickTick app AFTER the 10pm evening report must be
// marked done in tasks.md before the 8am brief gathers — otherwise the brief
// lists finished work as due (the Jul 12 2026 cruise-prep bug).

test('syncTickTickTruth runs the injected sync with rootDir/cfg/today', async () => {
  const calls = [];
  const cfg = { ticktickToken: 'tok' };
  const out = await syncTickTickTruth('/root', cfg, TODAY,
    async (...args) => { calls.push(args); return ['Pack for cruise']; });
  assert.deepStrictEqual(calls, [['/root', cfg, TODAY]]);
  assert.deepStrictEqual(out, ['Pack for cruise']);
});

test('syncTickTickTruth is fail-soft: a sync error never blocks the brief', async () => {
  const out = await syncTickTickTruth('/root', {}, TODAY,
    async () => { throw new Error('ticktick down'); });
  assert.deepStrictEqual(out, []);
});

test('syncTickTickTruth defaults to the evening report sync (shared code path)', () => {
  const evening = require('../system/telegram/evening.js');
  assert.strictEqual(typeof evening.syncTickTick, 'function');
});
