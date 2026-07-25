'use strict';
// Evening report — "how did the day go": tasks done, what got learned, what's
// still open, one overall read. Sent to Telegram as text + a voice note
// (ElevenLabs, `say` fallback — see tts.js). Runs two ways:
//   1. launchd com.secondbrain.second-brain-evening, Mon–Sat 23:59 (Sunday belongs
//      to the weekly report — see weekly.js, which imports plumbing from here)
//   2. on demand from bot.js ("/evening" or "evening report")
// Deliberately requires nothing from bot.js (one-way dependency: bot → here),
// so it carries its own tiny .env/telegram helpers. Pure gather/compose
// helpers are exported for unit tests.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { behaviorsRollup, pickResurface, loadResurfaceState, markResurfaced } = require('../lib/evening-insights.js');
const { writeNote } = require('../lib/note-write.js');
const { speak } = require('./tts.js');
const { getTask } = require('./ticktick.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');
// Pending nightly-question state — written when the report sends, read by
// bot.js to recognize the owner's reply, deleted once the answer is filed.
const QUESTION_STATE = ['system', 'logs', 'evening-question.json'];

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------- gather (pure) ------------------------------ */

// Strip a task line's metadata: "Walk | due:none | src:telegram ..." → "Walk".
function taskTitle(line) {
  return String(line || '').split(' | ')[0].trim();
}

// `- [x] title | ... | done:<today>` lines from an archive month file.
function doneToday(archiveMd, today) {
  const out = [];
  for (const line of String(archiveMd == null ? '' : archiveMd).split('\n')) {
    const m = line.match(/^-\s*\[x\]\s*(.*)$/i);
    if (m && m[1].includes(`done:${today}`)) out.push(taskTitle(m[1]));
  }
  return out;
}

// Unchecked `- [ ]` lines in the ## Active section of tasks.md (titles only).
function openTasks(tasksMd) {
  const out = [];
  let inActive = false;
  for (const line of String(tasksMd == null ? '' : tasksMd).split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { inActive = /^Active\b/i.test(heading[1].trim()); continue; }
    if (!inActive) continue;
    const m = line.match(/^-\s*\[ \]\s*(.*)$/);
    if (m) out.push(taskTitle(m[1]));
  }
  return out;
}

// Unchecked Active lines whose metadata says due today — the "planned for
// today but not done" half of the plan score.
function dueTodayOpen(tasksMd, today) {
  const out = [];
  let inActive = false;
  for (const line of String(tasksMd == null ? '' : tasksMd).split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { inActive = /^Active\b/i.test(heading[1].trim()); continue; }
    if (!inActive) continue;
    const m = line.match(/^-\s*\[ \]\s*(.*)$/);
    if (m && m[1].includes(`due:${today}`)) out.push(taskTitle(m[1]));
  }
  return out;
}

// `- [<today>] text` lines from inbox.md.
function todayCaptures(inboxMd, today) {
  const out = [];
  const re = new RegExp(`^-\\s*\\[${today}\\]\\s*(.*)$`);
  for (const line of String(inboxMd == null ? '' : inboxMd).split('\n')) {
    const m = line.match(re);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

// Wiki notes touched today: walk wiki/, keep files whose frontmatter says
// `updated: <today>`, return { title, kind } (kind: learning|remembered|note).
function learnedToday(rootDir, today) {
  const wikiDir = path.join(rootDir, 'wiki');
  const out = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
      if (!new RegExp(`^updated:\\s*${today}\\s*$`, 'm').test(text)) continue;
      const t = text.match(/^title:\s*(.+)$/m);
      const kind = p.includes(`${path.sep}learning${path.sep}`) ? 'learning'
        : p.includes(`${path.sep}remembered${path.sep}`) ? 'remembered' : 'note';
      out.push({ title: t ? t[1].trim() : e.name.replace(/\.md$/, ''), kind });
    }
  };
  walk(wikiDir);
  return out;
}

// Health digest for today: the `**Summary:** …` line + workout bullets from
// wiki/personal/health/<today>.md (written by health-ingest). Null when absent.
function healthSummary(rootDir, today) {
  let text = '';
  try { text = fs.readFileSync(path.join(rootDir, 'wiki', 'personal', 'health', `${today}.md`), 'utf8'); } catch (err) { return null; }
  const sum = text.match(/^\*\*Summary:\*\*\s*(.+)$/m);
  const workouts = [];
  const w = text.split(/^## Workouts\s*$/m)[1];
  if (w) for (const line of w.split('\n')) {
    const m = line.match(/^-\s+(.*)$/);
    if (m && m[1].trim() && m[1].trim() !== '(none)') workouts.push(m[1].trim());
  }
  if (!sum && !workouts.length) return null;
  return { summary: sum ? sum[1].trim() : null, workouts };
}

/* --------------------------- TickTick read-back ---------------------------- */
// The bot logs every TickTick task it creates to tasks/ticktick-ledger.jsonl
// ({id, projectId, title, date} per line). The report polls those ids so tasks
// the owner checks off IN THE TICKTICK APP count as done — tasks.md alone lies.

function readLedger(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch (err) { continue; }
    if (e && e.id && e.projectId && typeof e.title === 'string') out.push(e);
  }
  return out;
}

// completedTime like "2026-07-08T02:17:54.636+0000" → local YYYY-MM-DD.
function completedLocalDate(iso) {
  const d = new Date(String(iso || ''));
  return Number.isNaN(d.getTime()) ? null : localDate(d);
}

// Poll every ledger entry. Returns { doneToday, doneEarlier, stillOpen, keep }
// — `keep` is the pruned ledger (drop tasks completed before today,
// unfetchable/deleted tasks, and anything older than 14 days). `doneEarlier`
// is completions first OBSERVED late — checked off after that day's 10pm
// report, or while the phone hadn't synced to TickTick yet. They still need
// marking in tasks.md (with their real completed date) or they zombie as
// "still open" forever — the Jul 10 2026 socials bug.
async function pollTickTick(ledger, cfg, today, opts = {}) {
  const getTaskFn = opts.getTaskFn || getTask;
  const doneToday = [], doneEarlier = [], stillOpen = [], keep = [];
  // 14-day retention measured from `today`, not wall-clock now — the param
  // exists so this stays deterministic (and testable with a frozen date).
  const cutoffDate = new Date(`${today}T12:00:00`);
  cutoffDate.setDate(cutoffDate.getDate() - 14);
  const cutoff = localDate(cutoffDate);
  for (const e of ledger) {
    if (e.date && e.date < cutoff) continue;
    const r = await getTaskFn(e.projectId, e.id, { token: cfg.ticktickToken });
    if (!r.ok) { console.error(`ticktick poll failed for "${e.title}":`, r.error); continue; } // likely deleted → drop
    if (r.task && r.task.status === 2) {
      const when = completedLocalDate(r.task.completedTime);
      if (when === today) { doneToday.push(e.title); keep.push(e); }
      else doneEarlier.push({ title: e.title, when: when || today }); // prune, but mark done first
    } else {
      stillOpen.push(e.title);
      keep.push(e);
    }
  }
  return { doneToday, doneEarlier, stillOpen, keep };
}

// Mark TickTick-completed titles done in tasks.md (## Active, unchecked, exact
// title before " | "). Returns { md, archived } — archived lines carry the
// done:<today> stamp for the month archive, same shape the workbench writes.
function markDoneInTasks(tasksMd, titles, today) {
  const wanted = new Map(titles.map(t => [t.toLowerCase(), t]));
  const lines = String(tasksMd == null ? '' : tasksMd).split('\n');
  const archived = [];
  let inActive = false;
  const out = lines.map(line => {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { inActive = /^Active\b/i.test(heading[1].trim()); return line; }
    if (!inActive) return line;
    const m = line.match(/^-\s*\[ \]\s*(.*)$/);
    if (!m) return line;
    const title = taskTitle(m[1]).toLowerCase();
    if (!wanted.has(title)) return line;
    wanted.delete(title);
    archived.push(line.replace('- [ ]', '- [x]') + ` | done:${today}`);
    return null; // drop from tasks.md
  }).filter(l => l !== null);
  return { md: out.join('\n'), archived };
}

function gather(rootDir, today) {
  const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (err) { return ''; } };
  const archiveMd = read(path.join(rootDir, 'tasks', 'archive', `${today.slice(0, 7)}.md`));
  const tasksMd = read(path.join(rootDir, 'tasks', 'tasks.md'));
  return {
    done: doneToday(archiveMd, today),
    open: openTasks(tasksMd),
    dueTodayLeft: dueTodayOpen(tasksMd, today),
    learned: learnedToday(rootDir, today),
    captures: todayCaptures(read(path.join(rootDir, 'inbox', 'inbox.md')), today),
    health: healthSummary(rootDir, today),
    // Five Behaviors rollup: { touched, untouched, line } — see evening-insights.js.
    behaviors: behaviorsRollup(rootDir, today, archiveMd),
    // ONE learning note from ~30 days ago worth asking "did you apply it?"
    // (null when none in window or all already resurfaced).
    resurface: pickResurface(rootDir, today, loadResurfaceState(rootDir)),
    // Did she journal today? the owner journals in Notion (3 Pages) — the pull
    // above files it here when an entry exists. No file = no journal = nudge.
    journaled: fs.existsSync(path.join(rootDir, 'wiki', 'personal', 'journal', `${today}-three-pages.md`))
  };
}

// Plan score: what got done today vs what was on the books for today.
// Null when nothing was planned (no score beats a fake 0/0).
function planScore(data) {
  const done = data.done.length;
  const planned = done + (data.dueTodayLeft ? data.dueTodayLeft.length : 0);
  if (!planned) return null;
  return { done, planned, pct: Math.round((done / planned) * 100) };
}

/* ------------------------------ compose (pure) ------------------------------ */

function dayLabel(d) {
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

function buildReportPrompt(data, now) {
  const list = (arr, fmt) => (arr.length ? arr.map(fmt || (x => `- ${x}`)).join('\n') : '(none)');
  const score = planScore(data);
  return [
    `You are writing the owner's evening report for ${dayLabel(now)}.`,
    '',
    `DONE TODAY (${data.done.length}):`, list(data.done),
    '',
    `STILL OPEN (${data.open.length}):`, list(data.open),
    '',
    'PLAN SCORE:',
    score ? `completed ${score.done} of ${score.planned} planned for today (${score.pct}%)` : '(nothing was formally planned for today)',
    '',
    `LEARNED TODAY (${data.learned.length} notes filed in the second brain):`,
    list(data.learned, l => `- [${l.kind}] ${l.title}`),
    '',
    `CAPTURED TODAY (${data.captures.length} inbox items):`, list(data.captures),
    '',
    'MOVEMENT TODAY (Apple Health):',
    data.health
      ? [data.health.summary || '(no summary)', ...data.health.workouts.map(w => `- ${w}`)].join('\n')
      : '(no health sync today)',
    '',
    'FIVE BEHAVIORS TOUCHED TODAY (from tasks, notes, and health):',
    data.behaviors && data.behaviors.line ? data.behaviors.line : '(not computed)',
    '',
    'RESURFACE (a learning captured ~30 days ago, worth checking in on):',
    data.resurface
      ? `${data.resurface.daysAgo} days ago she captured "${data.resurface.title}". Its Apply line was: ${data.resurface.apply}`
      : '(none to resurface tonight)',
    '',
    'JOURNAL (her 3 Pages journal in Notion):',
    data.journaled ? 'She journaled today.' : 'NO journal entry today.',
    ...(data.systemAsks && data.systemAsks.length
      ? ['', `SYSTEM ASKS mined from today's journal (already queued for the next Claude session):`,
         ...data.systemAsks.map(a => `- ${a}`)]
      : []),
    '',
    "Write in the owner's voice: direct, warm, no-BS, coach-like — talking TO the owner.",
    'the owner is a woman (she/her). NEVER address her with masculine terms — no "brother",',
    '"bro", "man", "king", "sir", or the like. "the owner" or plain "you" is always right.',
    'Return ONLY a JSON object, no code fence, shaped exactly:',
    '{"text": "...", "speech": "...", "question": "..."}',
    `- "text": the Telegram message. Start "🌙 Evening report — ${dayLabel(now)}".`,
    '  Sections: ✅ done, 📊 plan score (the X/Y with a ONE-line honest read — praise a strong day,',
    '  name the slip on a weak one, skip the section if nothing was planned),',
    '  📚 learned (SUMMARIZE the learnings into takeaways, not raw titles),',
    '  🏃 movement (steps/exercise/workouts — celebrate real movement, call out a flat day),',
    data.behaviors && data.behaviors.line
      ? `  ⚖️ behaviors: include this line verbatim: "${data.behaviors.line}", then weave ONE sentence` +
        '\n  about balance into the report — gently name the untouched behaviors as an invitation for' +
        '\n  tomorrow, never shame (e.g. "create and connect didn\'t get a look today — maybe tomorrow\'s' +
        '\n  opening move"),'
      : null,
    data.resurface
      ? '  💡 resurface: a short prompt like "' + `${data.resurface.daysAgo} days ago you captured` +
        ` “${data.resurface.title}” — did you apply it?" plus its Apply line in one sentence,`
      : null,
    !data.journaled
      ? '  📓 journal: include this reminder, warm but direct: "Hey — I noticed you didn\'t journal' +
        '\n  today. Go do that right." (her 3 Pages page in Notion). Have the speech mention it too,' +
        '\n  near the close. If she DID journal, skip this section entirely.'
      : null,
    data.systemAsks && data.systemAsks.length
      ? '  🛠 system asks: one line confirming her journal asks were caught and queued, e.g.' +
        '\n  "Caught it: <short paraphrase> — queued for the next Claude session."'
      : null,
    '  🔜 still open (top handful only), then a 1-2 sentence honest read on the day. Under 2500 chars.',
    '- "speech": a 120-220 word spoken script — a trusted teammate recapping the day out loud,',
    '  with real energy: vary the rhythm, react to the day (proud, hyped, straight-talk), never',
    '  monotone-newsreader. Flowing sentences only: no emoji, no headers, no bullet lists.',
    '  You MAY drop in at most 2-3 ElevenLabs v3 audio tags in square brackets where they',
    '  genuinely fit, e.g. [impressed] [warm] [laughs softly] — sparingly, or none at all.',
    '  Cover what got done, the plan score, the movement, the one or two learnings that matter,',
    '  and END by asking her the question below, naturally, as the closing line.',
    '- "question": ONE pointed reflection question about TODAY specifically — grounded in the',
    "  data above (a task she pushed, a learning she filed, the plan-score gap, the movement),",
    '  the kind a sharp coach asks. Never generic ("how was your day"), never yes/no.',
    data.behaviors && data.behaviors.untouched && data.behaviors.untouched.includes('connect')
      ? '  Connect went untracked today — calls and texts are invisible to the brain, so this is' +
        '\n  self-reported. The question MUST include the ask "Who did you connect with today?"' +
        '\n  (that exact phrase, optionally woven with ONE day-specific angle). Her answer is how' +
        '\n  connect gets credited, and names in it are person-note candidates.'
      : null
  ].join('\n');
}

// Extract {text, speech, question} from the model reply. Null if unusable
// (question is optional — a missing one falls back to the plain default).
function parseReport(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  let o; try { o = JSON.parse(s.slice(a, b + 1)); } catch (err) { return null; }
  if (!o || typeof o.text !== 'string' || !o.text.trim() ||
      typeof o.speech !== 'string' || !o.speech.trim()) return null;
  const question = typeof o.question === 'string' && o.question.trim() ? o.question.trim() : null;
  return { text: o.text.trim(), speech: o.speech.trim(), question };
}

// No-LLM fallback so the report always arrives even if claude -p fails.
function plainReport(data, now) {
  const score = planScore(data);
  const lines = [`🌙 Evening report — ${dayLabel(now)}`];
  lines.push('', `✅ Done (${data.done.length}):`);
  lines.push(...(data.done.length ? data.done.map(t => ` • ${t}`) : [' • nothing checked off today']));
  if (score) lines.push('', `📊 Plan: ${score.done}/${score.planned} (${score.pct}%)`);
  if (data.learned.length) {
    lines.push('', `📚 Filed in the brain (${data.learned.length}):`);
    lines.push(...data.learned.map(l => ` • ${l.title}`));
  }
  if (data.health && data.health.summary) {
    lines.push('', `🏃 Movement: ${data.health.summary}`);
    lines.push(...data.health.workouts.map(w => ` • ${w}`));
  }
  if (data.behaviors && data.behaviors.line) {
    lines.push('', `⚖️ ${data.behaviors.line}`);
  }
  if (data.resurface) {
    lines.push('', `💡 ${data.resurface.daysAgo} days ago you captured "${data.resurface.title}" — did you apply it?`);
    lines.push(`   Apply line was: ${data.resurface.apply}`);
  }
  if (!data.journaled) {
    lines.push('', "📓 Hey — I noticed you didn't journal today. Go do that right.");
  }
  if (data.systemAsks && data.systemAsks.length) {
    lines.push('', `🛠 Caught from your journal (queued for the next Claude session):`);
    lines.push(...data.systemAsks.map(a => ` • ${a}`));
  }
  if (data.open.length) {
    lines.push('', `🔜 Still open (${data.open.length}):`);
    lines.push(...data.open.slice(0, 6).map(t => ` • ${t}`));
  }
  const question = data.behaviors && data.behaviors.untouched && data.behaviors.untouched.includes('connect')
    ? 'Who did you connect with today?'
    : 'What is the one thing from today you want tomorrow to build on?';
  const speech = `Evening report for ${dayLabel(now)}. You finished ${data.done.length} task${data.done.length === 1 ? '' : 's'} today` +
    (data.learned.length ? ` and filed ${data.learned.length} new thing${data.learned.length === 1 ? '' : 's'} you learned.` : '.') +
    (data.open.length ? ` ${data.open.length} item${data.open.length === 1 ? ' is' : 's are'} still open for tomorrow.` : ' The board is clear.') +
    ` One question before you close the day: ${question}`;
  return { text: lines.join('\n'), speech, question };
}

/* --------------------------- nightly question state ------------------------- */

function questionStatePath(rootDir) {
  return path.join(rootDir || ROOT_DIR, ...QUESTION_STATE);
}

// Pending question if one exists and is fresh (sent today, or yesterday for
// past-midnight answers). Anything staler is expired and cleared.
function loadPendingQuestion(rootDir) {
  const p = questionStatePath(rootDir);
  let st; try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { return null; }
  if (!st || !st.question || !st.date) return null;
  const today = localDate();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (st.date !== today && st.date !== localDate(y)) {
    try { fs.unlinkSync(p); } catch (err) { /* ignore */ }
    return null;
  }
  return st;
}

function clearPendingQuestion(rootDir) {
  try { fs.unlinkSync(questionStatePath(rootDir)); } catch (err) { /* ignore */ }
}

// Connect is self-reported: calls and texts are invisible to the auto-trackers,
// so the nightly "Who did you connect with today?" answer IS the signal. A real
// answer (not "no one" / "nobody" / "didn't …") credits connect on the
// reflection note's behaviors, which balance.js and the weekly report count.
const NO_CONNECT_RE = /^\s*(?:no(?:pe|t really| one)?|no[\s-]?one|nobody|didn'?t|did not|none)\b/i;
function reflectionBehaviors(question, answer) {
  const behaviors = ['learn', 'breathe'];
  const q = String(question == null ? '' : question);
  const a = String(answer == null ? '' : answer).trim();
  if (/\bconnect(?:ed)?\s+with\b/i.test(q) && a && !NO_CONNECT_RE.test(a)) behaviors.push('connect');
  return behaviors;
}

// File the owner's answer as a lint-gated journal note. Returns the relative path.
// opts.kind: 'weekly' files the Sunday commit-to-focus answer as
// <date>-weekly-reflection.md; anything else is the nightly reflection.
function captureReflection(question, answer, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const dateStr = opts.date || localDate();
  const weekly = opts.kind === 'weekly';
  const abs = writeNote(
    path.join(rootDir, 'wiki', 'personal', 'journal', `${dateStr}-${weekly ? 'weekly' : 'evening'}-reflection.md`),
    [
      '---',
      `title: ${weekly ? 'Weekly' : 'Evening'} reflection ${dateStr}`,
      'department: personal',
      `tags: [reflection, ${weekly ? 'weekly' : 'evening'}-report]`,
      `behaviors: [${reflectionBehaviors(question, answer).join(', ')}]`,
      `source: telegram:${weekly ? 'weekly' : 'evening'}`,
      `updated: ${dateStr}`,
      '---',
      '',
      `**Question:** ${String(question || '').trim()}`,
      '',
      `**Answer:** ${String(answer || '').trim()}`,
      ''
    ].join('\n')
  );
  return path.relative(rootDir, abs);
}

/* --------------------------- env + telegram (thin) -------------------------- */

function parseEnvFile(envPath) {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch (err) { text = ''; }
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function loadEveningConfig(envPath = ENV_PATH) {
  const env = parseEnvFile(envPath);
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_ALLOWED_USER_ID || '',
    ticktickToken: env.TICKTICK_ACCESS_TOKEN || '',
    elevenApiKey: env.ELEVENLABS_API_KEY || '',
    elevenVoiceId: env.ELEVENLABS_VOICE_ID || ''
  };
}

function telegramJson(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 40000
      },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('bad telegram response')); } });
      }
    );
    req.on('timeout', () => req.destroy(new Error('telegram request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Multipart upload for sendVoice — Telegram renders OGG/Opus as a voice bubble.
function sendVoiceFile(token, chatId, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = `----secondbrain${Date.now()}`;
    const field = (name, value) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="evening-report.ogg"\r\n` +
      'Content-Type: audio/ogg\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([field('chat_id', String(chatId)), head, fs.readFileSync(filePath), tail]);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendVoice`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        timeout: 60000
      },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const r = JSON.parse(data);
            if (r.ok) resolve(r); else reject(new Error(`sendVoice: ${data.slice(0, 200)}`));
          } catch (err) { reject(new Error('bad telegram response')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('telegram request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* --------------------------------- compose --------------------------------- */

function composeWithClaude(prompt, cwd) {
  return new Promise(resolve => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    execFile('claude', ['-p', prompt, '--max-turns', '4', '--allowedTools', ''],
      { cwd, env, timeout: 180000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) { console.error('evening compose failed:', err.message); resolve(null); return; }
        resolve(parseReport(stdout));
      });
  });
}

/* ----------------------------------- run ----------------------------------- */

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`));
      else resolve(stdout);
    });
  });
}

// Pull TickTick truth in before gathering: poll the ledger, mark anything
// checked off in the app as done in tasks.md (+ month archive), prune the
// ledger. Returns titles done in TickTick that tasks.md didn't know about.
async function syncTickTick(rootDir, cfg, today) {
  if (!cfg.ticktickToken) return [];
  const ledgerPath = path.join(rootDir, 'tasks', 'ticktick-ledger.jsonl');
  let ledgerText = '';
  try { ledgerText = fs.readFileSync(ledgerPath, 'utf8'); } catch (err) { return []; }
  const ledger = readLedger(ledgerText);
  if (!ledger.length) return [];
  const { doneToday: ttDone, doneEarlier, keep } = await pollTickTick(ledger, cfg, today);
  try { fs.writeFileSync(ledgerPath, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : '')); }
  catch (err) { console.error('ledger rewrite failed (non-fatal):', err.message); }
  if (!ttDone.length && !doneEarlier.length) return [];

  const tasksPath = path.join(rootDir, 'tasks', 'tasks.md');
  let md = '';
  try { md = fs.readFileSync(tasksPath, 'utf8'); } catch (err) { md = ''; }
  // Late-observed completions first, stamped with their REAL completed date —
  // they belong to a previous day's tally, not today's.
  const archived = [];
  const byWhen = new Map();
  for (const d of doneEarlier) {
    if (!byWhen.has(d.when)) byWhen.set(d.when, []);
    byWhen.get(d.when).push(d.title);
  }
  for (const [when, titles] of byWhen) {
    const r = markDoneInTasks(md, titles, when);
    md = r.md; archived.push(...r.archived);
  }
  const { md: newMd, archived: archivedToday } = markDoneInTasks(md, ttDone, today);
  archived.push(...archivedToday);
  if (archived.length) {
    const archDir = path.join(rootDir, 'tasks', 'archive');
    const archPath = path.join(archDir, `${today.slice(0, 7)}.md`);
    fs.mkdirSync(archDir, { recursive: true });
    let arch = '';
    try { arch = fs.readFileSync(archPath, 'utf8'); } catch (err) { arch = `# Archive ${today.slice(0, 7)}\n`; }
    fs.writeFileSync(archPath, arch.replace(/\s+$/, '') + '\n' + archived.join('\n') + '\n');
    fs.writeFileSync(tasksPath, newMd);
  }
  // Titles TickTick says are done but tasks.md never had (title drift etc.) —
  // the archive scan won't see them, so hand them back for a direct merge.
  const archivedTitles = new Set(archived.map(l => taskTitle(l.replace(/^-\s*\[x\]\s*/i, '')).toLowerCase()));
  return ttDone.filter(t => !archivedTitles.has(t.toLowerCase()));
}

// Build and send the report. `cfg` needs { token, chatId|elevenApiKey... }.
// Degrades at every step: TickTick/health sync fail → report still builds;
// claude fails → plain report; ElevenLabs fails → `say`; voice fails entirely
// → text alone already went out.
// `opts.dryRun`: gather + compose only — print to stdout, send NOTHING (no
// Telegram, no ElevenLabs), mutate NOTHING (health/TickTick sync and the
// resurface state file are skipped too).
async function runEveningReport(cfg, opts = {}) {
  const now = opts.now || new Date();
  const today = localDate(now);
  const rootDir = opts.rootDir || ROOT_DIR;
  const chatId = opts.chatId || cfg.chatId;
  const dryRun = !!opts.dryRun;

  if (!dryRun) {
    // Freshen today's health note from the latest phone sync (best-effort).
    try { await execFileP(process.execPath, [path.join(rootDir, 'system', 'ingest', 'health-ingest.js'), '--date', today], { cwd: rootDir, timeout: 60000 }); }
    catch (err) { console.error('health ingest failed (non-fatal):', err.message); }
    // Pull today's 3 Pages journal entry from Notion (best-effort) — she
    // journals there, never in Telegram; no note afterwards = didn't journal.
    try { await execFileP(process.execPath, [path.join(rootDir, 'system', 'ingest', 'notion-journal.js'), '--date', today], { cwd: rootDir, timeout: 45000 }); }
    catch (err) { console.error('notion journal pull failed (non-fatal):', err.message); }
  }

  // System-ask mining (audit Jul 22 2026): her journal keeps filing feature
  // requests against the second brain that nothing acted on. When today's
  // entry exists, mine it and queue fresh asks into skill-requests/.
  let journalAsks = [];
  if (!dryRun) {
    try {
      const jPath = path.join(rootDir, 'wiki', 'personal', 'journal', `${today}-three-pages.md`);
      if (fs.existsSync(jPath)) {
        const { extractFromJournal } = require('./reflection-extract.js');
        const { queueSkillRequest, hasSimilarRequest } = require('./skill-request.js');
        const body = fs.readFileSync(jPath, 'utf8').replace(/^---\n[\s\S]*?\n---\n*/, '');
        const mined = await extractFromJournal(body, { cwd: rootDir });
        for (const ask of mined.system_asks) {
          if (hasSimilarRequest(ask)) continue;
          queueSkillRequest(ask, null, { kind: 'system-ask', source: '3 Pages journal' });
          journalAsks.push(ask);
        }
      }
    } catch (err) { console.error('journal system-ask mining failed (non-fatal):', err.message); }
  }

  // TickTick truth: mark app-checked tasks done locally before gathering.
  let extraDone = [];
  if (!dryRun) {
    try { extraDone = await syncTickTick(rootDir, cfg, today); }
    catch (err) { console.error('ticktick sync failed (non-fatal):', err.message); }
  }

  const data = gather(rootDir, today);
  data.systemAsks = journalAsks;
  for (const t of extraDone) if (!data.done.some(d => d.toLowerCase() === t.toLowerCase())) data.done.push(t);
  const report = (await composeWithClaude(buildReportPrompt(data, now), rootDir)) || plainReport(data, now);

  if (dryRun) {
    console.log('--- DRY RUN: nothing sent, nothing written ---');
    console.log(report.text);
    if (report.question) console.log(`\n💭 Tonight's question: ${report.question}`);
    console.log('\n--- dry-run data ---');
    console.log(data.behaviors.line);
    console.log(data.resurface
      ? `Resurface pick: ${data.resurface.relPath} (${data.resurface.daysAgo} days old)`
      : 'Resurface pick: (none in window)');
    return { textSent: false, dryRun: true, voiceOk: false, engine: null, question: report.question || null, counts: { done: data.done.length, learned: data.learned.length, open: data.open.length } };
  }

  await telegramJson(cfg.token, 'sendMessage', { chat_id: chatId, text: report.text.slice(0, 4096) });

  // The resurfaced note is now out the door — record it so it never repeats.
  if (data.resurface) {
    try { markResurfaced(rootDir, data.resurface.relPath); }
    catch (err) { console.error('resurface state write failed (non-fatal):', err.message); }
  }

  let voiceOk = false, engine = null;
  try {
    const v = await speak(report.speech, { apiKey: cfg.elevenApiKey, voiceId: cfg.elevenVoiceId });
    engine = v.engine;
    try { await sendVoiceFile(cfg.token, chatId, v.path); voiceOk = true; }
    finally { try { fs.unlinkSync(v.path); } catch (e) { /* ignore */ } }
  } catch (err) {
    console.error('evening voice failed (text already sent):', err.message);
  }

  // The nightly question rides as its own message so a Telegram swipe-reply
  // targets it unambiguously; bot.js files the reply into the brain.
  if (report.question) {
    try {
      const q = await telegramJson(cfg.token, 'sendMessage', {
        chat_id: chatId,
        text: `💭 Tonight's question: ${report.question}\n\n(Reply to this message — text or voice — and I'll file your answer in the brain.)`
      });
      const messageId = q && q.ok && q.result ? q.result.message_id : null;
      fs.mkdirSync(path.dirname(questionStatePath(rootDir)), { recursive: true });
      // sentAt lets the bot treat ANY message in the first stretch after the
      // question as the answer — the owner answers by just recording, not by
      // swipe-replying.
      fs.writeFileSync(questionStatePath(rootDir),
        JSON.stringify({ date: today, chatId: String(chatId), messageId, question: report.question, sentAt: Date.now() }) + '\n');
    } catch (err) {
      console.error('nightly question send failed (non-fatal):', err.message);
    }
  }

  return { textSent: true, voiceOk, engine, question: report.question || null, counts: { done: data.done.length, learned: data.learned.length, open: data.open.length } };
}

module.exports = {
  taskTitle, doneToday, openTasks, dueTodayOpen, todayCaptures, learnedToday, healthSummary,
  readLedger, completedLocalDate, pollTickTick, markDoneInTasks, syncTickTick, gather, planScore,
  buildReportPrompt, parseReport, plainReport, loadEveningConfig, runEveningReport,
  loadPendingQuestion, clearPendingQuestion, captureReflection, reflectionBehaviors,
  // shared plumbing for weekly.js (the Sunday sibling report)
  telegramJson, sendVoiceFile, composeWithClaude, questionStatePath
};

if (require.main === module) {
  require('../lib/log.js').installTimestamps();
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadEveningConfig();
  if (!dryRun && (!cfg.token || !cfg.chatId)) {
    console.error('evening.js: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID missing from .env');
    process.exit(1);
  }
  runEveningReport(cfg, { dryRun })
    .then(r => {
      if (!r.dryRun) console.log(`evening report sent (voice: ${r.voiceOk ? r.engine : 'FAILED'}, done:${r.counts.done} learned:${r.counts.learned} open:${r.counts.open})`);
    })
    .catch(err => { console.error('evening report crashed:', err.message); process.exit(1); });
}
