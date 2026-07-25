const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  taskTitle, doneToday, openTasks, dueTodayOpen, todayCaptures, learnedToday, healthSummary,
  readLedger, completedLocalDate, markDoneInTasks, planScore,
  buildReportPrompt, parseReport, plainReport, loadEveningConfig,
  loadPendingQuestion, clearPendingQuestion, captureReflection
} = require('../system/telegram/evening.js');

const NOW = new Date(2026, 6, 7, 22, 0); // Tue Jul 7 2026, 10pm
const TODAY = '2026-07-07';

test('taskTitle strips pipe metadata', () => {
  assert.strictEqual(taskTitle('Walk | due:none | src:telegram | behaviors:none | link:none'), 'Walk');
  assert.strictEqual(taskTitle('plain'), 'plain');
});

test('doneToday keeps only [x] lines done today', () => {
  const md = [
    '# Archive 2026-07',
    '- [x] old thing | due:none | src:manual | behaviors:none | link:none | done:2026-07-06',
    '- [x] shipped the fix | due:2026-07-07 | src:telegram | behaviors:none | link:none | done:2026-07-07',
    '- [ ] not done | done:2026-07-07',
  ].join('\n');
  assert.deepStrictEqual(doneToday(md, TODAY), ['shipped the fix']);
  assert.deepStrictEqual(doneToday('', TODAY), []);
});

test('openTasks reads unchecked Active lines only', () => {
  const md = [
    '## Active', '',
    '- [ ] Walk | due:none | src:telegram | behaviors:none | link:none',
    '- [x] Done one | done:2026-07-07',
    '', '## Proposed (confirm or kill)', '- [ ] proposal',
  ].join('\n');
  assert.deepStrictEqual(openTasks(md), ['Walk']);
});

test('todayCaptures matches only today-stamped inbox lines', () => {
  const md = '- [2026-07-06] yesterday\n- [2026-07-07] a link worth reading\n';
  assert.deepStrictEqual(todayCaptures(md, TODAY), ['a link worth reading']);
});

test('learnedToday finds wiki notes updated today, classifies learning/remembered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evening-test-'));
  const mk = (rel, title, updated) => {
    const p = path.join(root, 'wiki', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `---\ntitle: ${title}\ndepartment: content\nupdated: ${updated}\n---\n\nbody\n`);
  };
  mk('content/learning/a.md', 'Fresh learning', TODAY);
  mk('content/remembered/b.md', 'A remembered fact', TODAY);
  mk('content/learning/c.md', 'Stale note', '2026-07-01');
  const got = learnedToday(root, TODAY).sort((x, y) => x.title.localeCompare(y.title));
  assert.deepStrictEqual(got, [
    { title: 'A remembered fact', kind: 'remembered' },
    { title: 'Fresh learning', kind: 'learning' },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildReportPrompt embeds the data, health, and the JSON contract', () => {
  const p = buildReportPrompt({
    done: ['shipped the fix'], open: ['Walk'],
    learned: [{ title: 'Fresh learning', kind: 'learning' }], captures: [],
    health: { summary: '11,769 steps, 36min exercise', workouts: ['Cycling (16min)'] }
  }, NOW);
  assert.match(p, /Tuesday Jul 7/);
  assert.match(p, /shipped the fix/);
  assert.match(p, /\[learning\] Fresh learning/);
  assert.match(p, /11,769 steps/);
  assert.match(p, /Cycling \(16min\)/);
  assert.match(p, /"text": "\.\.\.", "speech": "\.\.\."/);
  const noHealth = buildReportPrompt({ done: [], open: [], learned: [], captures: [], health: null }, NOW);
  assert.match(noHealth, /no health sync today/);
});

test('healthSummary reads summary line + workouts from the daily note', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evening-health-'));
  const p = path.join(root, 'wiki', 'personal', 'health', `${TODAY}.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '---\ntitle: Health\n---\n\n**Summary:** 11,769 steps, 36min exercise\n\n## Workouts\n\n- Cycling (16min)\n- Walking (20min)\n');
  assert.deepStrictEqual(healthSummary(root, TODAY),
    { summary: '11,769 steps, 36min exercise', workouts: ['Cycling (16min)', 'Walking (20min)'] });
  assert.strictEqual(healthSummary(root, '2026-01-01'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readLedger parses jsonl and drops junk lines', () => {
  const text = '{"id":"a","projectId":"p","title":"Walk","date":"2026-07-07"}\n' +
               'not json\n' +
               '{"id":"b","projectId":"p","title":"Nap"}\n' +
               '{"projectId":"p","title":"missing id"}\n';
  const l = readLedger(text);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].title, 'Walk');
  assert.strictEqual(l[1].id, 'b');
});

test('completedLocalDate converts TickTick UTC stamps to local dates', () => {
  // 2026-07-08T02:17Z = 10:17pm ET Jul 7 — must count as Jul 7, not Jul 8.
  assert.strictEqual(completedLocalDate('2026-07-08T02:17:54.636+0000'), '2026-07-07');
  assert.strictEqual(completedLocalDate('junk'), null);
});

test('pollTickTick surfaces completions observed late instead of silently pruning them', async () => {
  const { pollTickTick } = require('../system/telegram/evening.js');
  // The Jul 10 2026 zombie-task bug: socials checked off in TickTick at
  // 8:51pm ET Jul 9, but first OBSERVED by the Jul 10 poll — "completed
  // earlier" was pruned from the ledger without ever marking tasks.md,
  // so the tasks showed "still open" forever.
  const ledger = [
    { id: 'a', projectId: 'p', title: 'Post 2x on TikTok (Content Corner)', date: '2026-07-06' },
    { id: 'b', projectId: 'p', title: 'Walk', date: '2026-07-07' },
  ];
  const tasks = {
    a: { status: 2, completedTime: '2026-07-07T00:51:00.000+0000' }, // 8:51pm ET Jul 6 — before today
    b: { status: 0 },
  };
  const r = await pollTickTick(ledger, { ticktickToken: 't' }, TODAY,
    { getTaskFn: async (pid, id) => ({ ok: true, task: tasks[id] }) });
  assert.deepStrictEqual(r.doneEarlier, [{ title: 'Post 2x on TikTok (Content Corner)', when: '2026-07-06' }]);
  assert.deepStrictEqual(r.doneToday, []);
  assert.deepStrictEqual(r.stillOpen, ['Walk']);
  assert.deepStrictEqual(r.keep.map(e => e.id), ['b'], 'late completion still pruned from the ledger');
});

test('pollTickTick measures the 14-day retention window from `today`, not wall-clock now', async () => {
  // Regression: the cutoff used `new Date()` — this suite's frozen 2026-07-07
  // fixtures silently aged out of the window once the real calendar passed
  // Jul 21 2026, and the late-completion test went red without a code change.
  const { pollTickTick } = require('../system/telegram/evening.js');
  const ledger = [
    { id: 'old', projectId: 'p', title: 'Ancient task', date: '2026-06-22' },  // 15 days before TODAY
    { id: 'edge', projectId: 'p', title: 'Edge task', date: '2026-06-23' },    // exactly 14 days — kept
  ];
  const polled = [];
  const r = await pollTickTick(ledger, { ticktickToken: 't' }, TODAY,
    { getTaskFn: async (pid, id) => { polled.push(id); return { ok: true, task: { status: 0 } }; } });
  assert.deepStrictEqual(polled, ['edge'], 'only the in-window entry is polled');
  assert.deepStrictEqual(r.stillOpen, ['Edge task']);
  assert.deepStrictEqual(r.keep.map(e => e.id), ['edge']);
});

test('markDoneInTasks checks off matched Active lines and returns archive lines', () => {
  const md = [
    '## Active', '',
    '- [ ] Walk | due:2026-07-07 | src:telegram | behaviors:none | link:none',
    '- [ ] Nap | due:2026-07-07 | src:telegram | behaviors:none | link:none',
    '', '## Proposed (confirm or kill)',
  ].join('\n');
  const { md: out, archived } = markDoneInTasks(md, ['walk', 'Not There'], TODAY);
  assert.ok(!out.includes('Walk'), 'Walk removed from tasks.md');
  assert.ok(out.includes('Nap'), 'Nap untouched');
  assert.strictEqual(archived.length, 1);
  assert.match(archived[0], /^- \[x\] Walk \| due:2026-07-07 .* \| done:2026-07-07$/);
});

test('parseReport extracts JSON, rejects junk, question optional', () => {
  assert.deepStrictEqual(parseReport('noise {"text":"T","speech":"S","question":"Q?"} tail'),
    { text: 'T', speech: 'S', question: 'Q?' });
  assert.deepStrictEqual(parseReport('{"text":"T","speech":"S"}'), { text: 'T', speech: 'S', question: null });
  assert.strictEqual(parseReport('{"text":"only text"}'), null);
  assert.strictEqual(parseReport('no json here'), null);
  assert.strictEqual(parseReport(null), null);
});

test('dueTodayOpen finds unchecked Active lines due today', () => {
  const md = [
    '## Active', '',
    '- [ ] Walk | due:2026-07-07 | src:telegram | behaviors:none | link:none',
    '- [ ] Someday thing | due:none | src:telegram | behaviors:none | link:none',
    '- [ ] Future | due:2026-07-09 | src:telegram | behaviors:none | link:none',
  ].join('\n');
  assert.deepStrictEqual(dueTodayOpen(md, TODAY), ['Walk']);
});

test('planScore computes done vs planned-for-today, null when nothing planned', () => {
  assert.deepStrictEqual(planScore({ done: ['a', 'b', 'c'], dueTodayLeft: ['d'] }), { done: 3, planned: 4, pct: 75 });
  assert.strictEqual(planScore({ done: [], dueTodayLeft: [] }), null);
});

test('question state round-trip: pending today, cleared, stale expired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evening-q-'));
  const statePath = path.join(root, 'system', 'logs', 'evening-question.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const today = new Date();
  const st = { date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`, chatId: '42', messageId: 7, question: 'Q?' };
  fs.writeFileSync(statePath, JSON.stringify(st));
  assert.deepStrictEqual(loadPendingQuestion(root), st);
  clearPendingQuestion(root);
  assert.strictEqual(loadPendingQuestion(root), null);
  fs.writeFileSync(statePath, JSON.stringify({ ...st, date: '2020-01-01' }));
  assert.strictEqual(loadPendingQuestion(root), null, 'stale question expires');
  assert.ok(!fs.existsSync(statePath), 'stale state file removed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('captureReflection writes a lint-clean journal note with Q and A', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evening-refl-'));
  const rel = captureReflection('What moved you today?', 'The walk cleared my head.', { rootDir: root, date: TODAY });
  assert.strictEqual(rel, path.join('wiki', 'personal', 'journal', `${TODAY}-evening-reflection.md`));
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.match(text, /title: Evening reflection 2026-07-07/);
  assert.match(text, /\*\*Question:\*\* What moved you today\?/);
  assert.match(text, /\*\*Answer:\*\* The walk cleared my head\./);
  fs.rmSync(root, { recursive: true, force: true });
});

test('plainReport always produces text, speech, question, and a score line', () => {
  const r = plainReport({ done: ['a', 'b'], dueTodayLeft: ['c2'], open: ['c'], learned: [{ title: 'x', kind: 'note' }], captures: [] }, NOW);
  assert.match(r.text, /🌙 Evening report — Tuesday Jul 7/);
  assert.match(r.text, /✅ Done \(2\)/);
  assert.match(r.text, /📊 Plan: 2\/3 \(67%\)/);
  assert.match(r.speech, /2 tasks today/);
  assert.ok(r.question && r.question.length > 10);
  assert.ok(r.speech.includes(r.question), 'plain speech ends with the question');
  const empty = plainReport({ done: [], dueTodayLeft: [], open: [], learned: [], captures: [] }, NOW);
  assert.match(empty.text, /nothing checked off/);
  assert.match(empty.speech, /The board is clear/);
});

test('buildReportPrompt carries the behaviors line and resurface note', () => {
  const p = buildReportPrompt({
    done: [], open: [], learned: [], captures: [], health: null,
    behaviors: { touched: ['move'], untouched: ['breathe', 'create', 'learn', 'connect'],
      line: 'Behaviors: move ✓ · breathe ✗ · create ✗ · learn ✗ · connect ✗' },
    resurface: { relPath: 'wiki/content/learning/x.md', title: 'Old gem', apply: 'Ship the thing.', daysAgo: 30 }
  }, NOW);
  assert.match(p, /Behaviors: move ✓ · breathe ✗ · create ✗ · learn ✗ · connect ✗/);
  assert.match(p, /never shame/);
  assert.match(p, /30 days ago she captured "Old gem"/);
  assert.match(p, /Ship the thing\./);
  // Legacy shape (no behaviors/resurface) still builds.
  const legacy = buildReportPrompt({ done: [], open: [], learned: [], captures: [], health: null }, NOW);
  assert.match(legacy, /\(not computed\)/);
  assert.match(legacy, /none to resurface tonight/);
});

test('plainReport includes the literal behaviors line and the resurface prompt', () => {
  const r = plainReport({
    done: [], dueTodayLeft: [], open: [], learned: [], captures: [],
    behaviors: { touched: [], untouched: [], line: 'Behaviors: move ✓ · breathe ✓ · create ✗ · learn ✓ · connect ✗' },
    resurface: { relPath: 'wiki/content/learning/x.md', title: 'Old gem', apply: 'Ship the thing.', daysAgo: 28 }
  }, NOW);
  assert.match(r.text, /⚖️ Behaviors: move ✓ · breathe ✓ · create ✗ · learn ✓ · connect ✗/);
  assert.match(r.text, /💡 28 days ago you captured "Old gem" — did you apply it\?/);
  assert.match(r.text, /Apply line was: Ship the thing\./);
  // Legacy shape still works, just without the new sections.
  const legacy = plainReport({ done: [], dueTodayLeft: [], open: [], learned: [], captures: [] }, NOW);
  assert.ok(!legacy.text.includes('⚖️') && !legacy.text.includes('💡'));
});

test('loadEveningConfig reads the telegram + elevenlabs keys', () => {
  const p = path.join(os.tmpdir(), `evening-env-${process.pid}`);
  fs.writeFileSync(p, 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_ALLOWED_USER_ID=42\nTICKTICK_ACCESS_TOKEN=tt\nELEVENLABS_API_KEY=k\nELEVENLABS_VOICE_ID=v\n');
  assert.deepStrictEqual(loadEveningConfig(p), { token: 'tok', chatId: '42', ticktickToken: 'tt', elevenApiKey: 'k', elevenVoiceId: 'v' });
  fs.unlinkSync(p);
});
