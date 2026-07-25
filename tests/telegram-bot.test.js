const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseEnv,
  isAllowed,
  classify,
  activeTasks,
  appendTodo,
  captureEntry,
  truncateForTelegram,
  loadConfig
} = require('../system/telegram/bot.js');

/* ---------------------------- parseEnv / loadConfig ---------------------------- */

test('parseEnv reads KEY=VALUE lines, ignoring blanks and comments', () => {
  const text = [
    '# a comment',
    '',
    'TELEGRAM_BOT_TOKEN=abc123',
    'TELEGRAM_ALLOWED_USER_ID=999',
    '  # indented comment',
    'NOTION_TOKEN=xyz=with=equals'
  ].join('\n');
  const env = parseEnv(text);
  assert.strictEqual(env.TELEGRAM_BOT_TOKEN, 'abc123');
  assert.strictEqual(env.TELEGRAM_ALLOWED_USER_ID, '999');
  assert.strictEqual(env.NOTION_TOKEN, 'xyz=with=equals');
  assert.strictEqual(Object.keys(env).length, 3);
});

test('parseEnv handles empty/undefined input without throwing', () => {
  assert.deepStrictEqual(parseEnv(''), {});
  assert.deepStrictEqual(parseEnv(undefined), {});
});

test('loadConfig reports missing keys when the .env file lacks them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-env-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'NOTION_TOKEN=whatever\n');
  const cfg = loadConfig(envPath);
  assert.deepStrictEqual(cfg.missing.sort(), ['TELEGRAM_ALLOWED_USER_ID', 'TELEGRAM_BOT_TOKEN']);
  assert.strictEqual(cfg.token, undefined);
  assert.strictEqual(cfg.allowedId, undefined);
});

test('loadConfig returns no missing keys when both are present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-env-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_ALLOWED_USER_ID=42\n');
  const cfg = loadConfig(envPath);
  assert.deepStrictEqual(cfg.missing, []);
  assert.strictEqual(cfg.token, 'tok');
  assert.strictEqual(cfg.allowedId, '42');
});

test('loadConfig treats a missing .env file as all-keys-missing (no throw)', () => {
  const cfg = loadConfig('/nonexistent/path/.env');
  assert.deepStrictEqual(cfg.missing.sort(), ['TELEGRAM_ALLOWED_USER_ID', 'TELEGRAM_BOT_TOKEN']);
});

/* ---------------------------- isAllowed ---------------------------- */

test('isAllowed accepts the allowlisted sender id', () => {
  const update = { message: { from: { id: 12345 } } };
  assert.strictEqual(isAllowed(update, '12345'), true);
  assert.strictEqual(isAllowed(update, 12345), true);
});

test('isAllowed rejects the wrong sender id', () => {
  const update = { message: { from: { id: 12345 } } };
  assert.strictEqual(isAllowed(update, '99999'), false);
});

test('isAllowed rejects when `from` is missing', () => {
  assert.strictEqual(isAllowed({ message: {} }, '12345'), false);
  assert.strictEqual(isAllowed({}, '12345'), false);
});

test('isAllowed rejects when allowedId is not configured', () => {
  const update = { message: { from: { id: 12345 } } };
  assert.strictEqual(isAllowed(update, undefined), false);
  assert.strictEqual(isAllowed(update, ''), false);
});

/* ---------------------------- classify ---------------------------- */

test('classify: /start and /help -> help', () => {
  assert.strictEqual(classify('/start').kind, 'help');
  assert.strictEqual(classify('/help').kind, 'help');
  assert.strictEqual(classify('').kind, 'help');
});

test('classify: /tasks -> tasks', () => {
  assert.strictEqual(classify('/tasks').kind, 'tasks');
});

test('classify: "todo:" prefix -> todo, case-insensitive', () => {
  const a = classify('todo: buy milk');
  assert.strictEqual(a.kind, 'todo');
  assert.strictEqual(a.payload, 'buy milk');

  const b = classify('TODO:call the vet');
  assert.strictEqual(b.kind, 'todo');
  assert.strictEqual(b.payload, 'call the vet');
});

test('classify: "remind me to " prefix -> todo, case-insensitive', () => {
  const a = classify('remind me to email Jordan');
  assert.strictEqual(a.kind, 'todo');
  assert.strictEqual(a.payload, 'email Jordan');

  const b = classify('Remind Me To pack the camera');
  assert.strictEqual(b.kind, 'todo');
  assert.strictEqual(b.payload, 'pack the camera');
});

test('classify: a YouTube link -> youtube, even with surrounding text', () => {
  const a = classify('https://youtu.be/VoKiKvgpk78?si=xyz');
  assert.strictEqual(a.kind, 'youtube');
  const b = classify('watch this https://www.youtube.com/watch?v=VoKiKvgpk78 later');
  assert.strictEqual(b.kind, 'youtube');
  assert.ok(b.payload.includes('VoKiKvgpk78'));
});

test('classify: "remember:" and "remember that" -> remember; "remember to" stays a todo', () => {
  assert.strictEqual(classify('remember: the wifi code is 4412').kind, 'remember');
  const a = classify('remember that the launch rule is swap by hour 6');
  assert.strictEqual(a.kind, 'remember');
  assert.strictEqual(a.payload, 'the launch rule is swap by hour 6');
  const b = classify('remember to buy batteries');
  assert.strictEqual(b.kind, 'todo');
  assert.strictEqual(b.payload, 'buy batteries');
});

test('classify: "capture:" prefix -> capture', () => {
  const a = classify('capture: great quote from the podcast');
  assert.strictEqual(a.kind, 'capture');
  assert.strictEqual(a.payload, 'great quote from the podcast');
});

test('classify: a bare URL -> web capture', () => {
  const a = classify('https://example.com/some-article');
  assert.strictEqual(a.kind, 'web');
  assert.strictEqual(a.payload, 'https://example.com/some-article');
});

test('classify: URL embedded in a sentence -> web capture (the "Read this today:" case)', () => {
  const a = classify('Read this today: https://x.com/openai/status/2074704958419792299?s=46&t=H_MJ1ZXAMeW');
  assert.strictEqual(a.kind, 'web');
  assert.strictEqual(a.payload, 'https://x.com/openai/status/2074704958419792299?s=46&t=H_MJ1ZXAMeW');
  const b = classify('check this out https://example.com please');
  assert.strictEqual(b.kind, 'web');
});

test('classify: YouTube still wins over generic web capture', () => {
  const a = classify('Read this today: https://www.youtube.com/watch?v=VoKiKvgpk78');
  assert.strictEqual(a.kind, 'youtube');
});

test('classify: anything else -> ask', () => {
  const a = classify('what did I decide about the Austin Lock-In pricing?');
  assert.strictEqual(a.kind, 'ask');
  assert.strictEqual(a.payload, 'what did I decide about the Austin Lock-In pricing?');
});

test('classify: skill requests -> skillreq, not todo or ask', () => {
  assert.strictEqual(classify('skill this').kind, 'skillreq');
  assert.strictEqual(classify('can you make that a skill').kind, 'skillreq');
  const a = classify('Is that a skill that you can create and install it into Claude for me?');
  assert.strictEqual(a.kind, 'skillreq');
  // plain mentions of skills stay whatever they were
  assert.strictEqual(classify('remind me to update the clipper skill').kind, 'todo');
});

/* ---------------------------- activeTasks ---------------------------- */

test('activeTasks extracts unchecked lines from the ## Active section only', () => {
  const md = [
    '# Tasks',
    '',
    '## Active',
    '',
    '- [ ] first active task | due:none | src:manual | behaviors:none | link:none',
    '- [x] a done task that should not appear',
    '- [ ] second active task | due:2026-07-10 | src:telegram | behaviors:none | link:none',
    '',
    '## Proposed (confirm or kill)',
    '',
    '- [ ] a proposed task that should not appear'
  ].join('\n');
  const tasks = activeTasks(md);
  assert.strictEqual(tasks.length, 2);
  assert.match(tasks[0], /^first active task/);
  assert.match(tasks[1], /^second active task/);
});

test('activeTasks returns empty array when there are no active tasks', () => {
  const md = '# Tasks\n\n## Active\n\n## Proposed (confirm or kill)\n';
  assert.deepStrictEqual(activeTasks(md), []);
});

test('activeTasks handles missing/empty input', () => {
  assert.deepStrictEqual(activeTasks(''), []);
  assert.deepStrictEqual(activeTasks(undefined), []);
});

/* ---------------------------- appendTodo ---------------------------- */

test('appendTodo inserts a new line at the end of the ## Active section', () => {
  const md = [
    '# Tasks',
    '',
    '## Active',
    '',
    '- [ ] existing task | due:none | src:manual | behaviors:none | link:none',
    '',
    '## Proposed (confirm or kill)',
    ''
  ].join('\n');
  const updated = appendTodo(md, 'call the vet');
  const tasks = activeTasks(updated);
  assert.strictEqual(tasks.length, 2);
  assert.match(tasks[1], /^call the vet \| due:none \| src:telegram \| behaviors:none \| link:none$/);
  // Proposed section untouched
  assert.match(updated, /## Proposed \(confirm or kill\)/);
});

test('appendTodo creates an ## Active section if none exists', () => {
  const md = '# Tasks\n';
  const updated = appendTodo(md, 'new task');
  assert.match(updated, /## Active/);
  const tasks = activeTasks(updated);
  assert.strictEqual(tasks.length, 1);
  assert.match(tasks[0], /^new task/);
});

/* ---------------------------- captureEntry ---------------------------- */

test('captureEntry stamps the line with the given local date', () => {
  const line = captureEntry('interesting article about retention', '2026-07-07');
  assert.strictEqual(line, '- [2026-07-07] interesting article about retention');
});

test('captureEntry trims whitespace and defaults to today when no date given', () => {
  const line = captureEntry('  a note  ');
  assert.match(line, /^- \[\d{4}-\d{2}-\d{2}\] a note$/);
});

/* ---------------------------- truncateForTelegram ---------------------------- */

test('truncateForTelegram leaves short text untouched', () => {
  assert.strictEqual(truncateForTelegram('hello'), 'hello');
});

test('truncateForTelegram truncates text over the 4096-char limit', () => {
  const long = 'x'.repeat(5000);
  const out = truncateForTelegram(long);
  assert.ok(out.length <= 4096);
  assert.match(out, /…\(truncated\)$/);
});

/* ---------------------------- captureSummary ---------------------------- */

const { captureSummary } = require('../system/telegram/bot.js');

test('captureSummary: title + up to 3 core-idea bullets + apply line', () => {
  const msg = captureSummary({
    title: 'GPT-Live launch',
    takeaway: 'Voice AI got real.',
    notes_md: '## Core ideas\n- **First** idea with detail\n- Second idea\n- Third idea\n- Fourth idea\n\n## Quotes\n> "quoted"',
    apply: 'Test it on camera this week.'
  });
  assert.ok(msg.includes('GPT-Live launch'));
  assert.ok(msg.includes('• First idea with detail'), 'bold markers should be stripped');
  assert.ok(msg.includes('• Second idea'));
  assert.ok(msg.includes('• Third idea'));
  assert.ok(!msg.includes('Fourth idea'), 'bullets capped at 3');
  assert.ok(!msg.includes('quoted'), 'quotes section is not bullets');
  assert.ok(msg.includes('Apply: Test it on camera this week.'));
});

test('captureSummary: falls back to takeaway when notes have no bullets', () => {
  const msg = captureSummary({ title: 'T', takeaway: 'The one thing.', notes_md: 'plain text', apply: '' });
  assert.ok(msg.includes('• The one thing.'));
});

test('classify: "brain dump" -> dump (never a todo/plan), questions about dumps -> not dump', () => {
  const a = classify('brain dump: today I learned the fxtwitter trick');
  assert.strictEqual(a.kind, 'dump');
  assert.strictEqual(a.payload, 'today I learned the fxtwitter trick');
  assert.strictEqual(classify('Okay so brain dump. Big day.').kind, 'dump');
  assert.strictEqual(classify('what did my brain dump say yesterday?').kind, 'ask');
  assert.strictEqual(classify('remind me to brain dump tonight').kind, 'todo');
});

test('classify: "idea brief" / "what ideas" -> ideabrief; idea capture and bank routes', () => {
  assert.strictEqual(classify('idea brief').kind, 'ideabrief');
  assert.strictEqual(classify('what ideas did I have this week?').kind, 'ideabrief');
  // Since the idea bank (Jul 22 2026), an explicit idea capture is banked…
  const idea = classify('I have an idea about thumbnails');
  assert.strictEqual(idea.kind, 'idea');
  assert.strictEqual(idea.payload, 'about thumbnails');
  assert.strictEqual(classify('idea bank').kind, 'ideabank');
  assert.strictEqual(classify('show me my idea bank').kind, 'ideabank');
  // …but plain talk that merely mentions an idea still asks the brain.
  assert.strictEqual(classify('was that idea from Tuesday any good?').kind, 'ask');
  assert.strictEqual(classify('remind me to write down my idea').kind, 'todo');
});

test('ticktickTrack creates the task and appends a ledger entry', async () => {
  const { ticktickTrack } = require('../system/telegram/bot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-track-'));
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const calls = [];
  const ok = await ticktickTrack({ title: 'ET post (evening)' }, '2026-07-11',
    { ticktickToken: 'tok' },
    { createTaskFn: async (item, o) => { calls.push([item, o]); return { ok: true, id: 'id1', projectId: 'p1' }; },
      ledgerPath });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 1);
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines, [{ id: 'id1', projectId: 'p1', title: 'ET post (evening)', date: '2026-07-11' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ticktickTrack: no token -> no-op false; create failure -> false, no ledger line', async () => {
  const { ticktickTrack } = require('../system/telegram/bot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-track2-'));
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  assert.strictEqual(await ticktickTrack({ title: 'x' }, '2026-07-11', {}, { ledgerPath }), false);
  const failed = await ticktickTrack({ title: 'x' }, '2026-07-11', { ticktickToken: 'tok' },
    { createTaskFn: async () => ({ ok: false, error: 'TickTick 401' }), ledgerPath });
  assert.strictEqual(failed, false);
  assert.ok(!fs.existsSync(ledgerPath), 'no ledger line on failure');
  fs.rmSync(dir, { recursive: true, force: true });
});
