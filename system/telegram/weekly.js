'use strict';
const { OWNER, ownerLine } = require('../lib/config.js');
// Weekly report — Sunday 10pm: the week in bullets (personal · health ·
// work & learn), a blind-spot read ("what am I not seeing in myself"), and ONE
// proposed focus for the coming week, asked as a commitment. Replaces the
// Sunday 11:59pm evening report (launchd fires evening.js Mon–Sat only) and
// absorbs its housekeeping: health-note refresh + TickTick truth sync run
// here first, so Sunday's check-offs fold into the week's totals.
// Sent as text + a ~2–3 min voice note (ElevenLabs via tts.js, `say`
// fallback). Runs two ways:
//   1. launchd com.secondbrain.second-brain-weekly, Sunday 22:00
//   2. by hand: node system/telegram/weekly.js [--dry-run]
// Plumbing (Telegram, voice, claude compose, question state) is imported from
// evening.js — one-way dependency, same degradation ladder. Pure gather/
// compose helpers are exported for unit tests.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { parseYmd, addDays, mondayOf, aggregateWeeks, computeFlags } = require('../balance.js');
const { FIVE_BEHAVIORS, behaviorsToday } = require('../lib/evening-insights.js');
const {
  doneToday, openTasks, todayCaptures, healthSummary, syncTickTick,
  loadEveningConfig, telegramJson, sendVoiceFile, composeWithClaude,
  questionStatePath
} = require('./evening.js');
const { speak } = require('./tts.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PULSE_MAX_AGE_DAYS = 10;

/* ------------------------------ window (pure) ------------------------------ */

// "Jul 13–19" / "Jun 29 – Jul 5" for the Monday→Sunday window.
function windowLabel(startYmd, endYmd) {
  const s = parseYmd(startYmd), e = parseYmd(endYmd);
  return s.getMonth() === e.getMonth()
    ? `${MO[s.getMonth()]} ${s.getDate()}–${e.getDate()}`
    : `${MO[s.getMonth()]} ${s.getDate()} – ${MO[e.getMonth()]} ${e.getDate()}`;
}

// The Monday→Sunday week containing `now`.
function weekWindow(now) {
  const start = mondayOf(localDate(now || new Date()));
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  return { start, end: days[6], days, label: windowLabel(start, days[6]) };
}

/* ------------------------------ gather (pure-ish) --------------------------- */

// Month archive texts for every month the window touches (may span two).
function readArchives(rootDir, days) {
  const out = {};
  for (const m of new Set(days.map(d => d.slice(0, 7)))) {
    try { out[m] = fs.readFileSync(path.join(rootDir, 'tasks', 'archive', `${m}.md`), 'utf8'); }
    catch (err) { out[m] = ''; }
  }
  return out;
}

// [{ date, title }] for every done:<day> stamp in the window.
function doneInWindow(archives, days) {
  const out = [];
  for (const d of days) {
    for (const title of doneToday(archives[d.slice(0, 7)] || '', d)) out.push({ date: d, title });
  }
  return out;
}

// Wiki notes whose frontmatter `updated:` falls in the window, classified by
// where they live: learning | remembered | person | journal | health | note.
function notesInWindow(rootDir, days) {
  const daySet = new Set(days);
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
      const u = text.match(/^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
      if (!u || !daySet.has(u[1])) continue;
      const t = text.match(/^title:\s*(.+)$/m);
      const rel = path.relative(rootDir, p);
      const kind = rel.includes(`${path.sep}journal${path.sep}`) ? 'journal'
        : rel.includes(`${path.sep}health${path.sep}`) ? 'health'
        : rel.includes(`${path.sep}people${path.sep}`) ? 'person'
        : rel.includes(`${path.sep}learning${path.sep}`) ? 'learning'
        : rel.includes(`${path.sep}remembered${path.sep}`) ? 'remembered' : 'note';
      out.push({ title: t ? t[1].trim() : e.name.replace(/\.md$/, ''), relPath: rel, kind, updated: u[1] });
    }
  };
  walk(wikiDir);
  return out;
}

// Strip frontmatter, collapse whitespace, cap length.
function noteBody(text, cap) {
  let body = String(text == null ? '' : text);
  const m = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (m) body = body.slice(m[0].length);
  body = body.trim().replace(/\n{3,}/g, '\n\n');
  const n = cap || 1200;
  return body.length > n ? body.slice(0, n) + '…' : body;
}

// Full text of the week's journal notes (brain dumps, evening reflections,
// connections) — the introspection fuel for Personal + the blind-spot read.
function journalTexts(rootDir, days) {
  const dir = path.join(rootDir, 'wiki', 'personal', 'journal');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (err) { return []; }
  const daySet = new Set(days);
  const out = [];
  for (const name of entries.sort()) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (!m || !daySet.has(m[1])) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (err) { continue; }
    out.push({ date: m[1], name: m[2], text: noteBody(text) });
  }
  return out.slice(-14); // hard cap: two entries a day is already plenty
}

// [{ date, text }] inbox captures across the window.
function capturesInWindow(inboxMd, days) {
  const out = [];
  for (const d of days) for (const text of todayCaptures(inboxMd, d)) out.push({ date: d, text });
  return out;
}

// Current-week balance row + only the flags that point at it.
function weekHealth(rootDir, todayYmd) {
  const weeks = aggregateWeeks(rootDir, { today: todayYmd, weeks: 4 });
  const cur = weeks[weeks.length - 1];
  const flags = computeFlags(weeks).filter(f => f.week === cur.week);
  return { cur, flags };
}

// Workouts day by day (from the daily health notes).
function workoutsInWindow(rootDir, days) {
  const out = [];
  for (const d of days) {
    const h = healthSummary(rootDir, d);
    if (h) for (const w of h.workouts) out.push({ date: d, workout: w });
  }
  return out;
}

// Days-touched count per behavior across the window, e.g. "move 5/7 · …".
function weeklyBehaviorCounts(rootDir, days, archives) {
  const counts = {};
  for (const b of FIVE_BEHAVIORS) counts[b] = 0;
  for (const d of days) {
    const touched = behaviorsToday(rootDir, d, archives[d.slice(0, 7)] || '');
    for (const b of touched) if (b in counts) counts[b]++;
  }
  const line = FIVE_BEHAVIORS.map(b => `${b} ${counts[b]}/${days.length}`).join(' · ');
  const low = FIVE_BEHAVIORS.filter(b => counts[b] <= 1);
  return { counts, line, low };
}

// Newest wiki/business/pulse note if it's ≤ PULSE_MAX_AGE_DAYS old.
function latestPulse(rootDir, todayYmd) {
  const dir = path.join(rootDir, 'wiki', 'business', 'pulse');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (err) { return null; }
  const dated = entries
    .map(name => { const m = name.match(/^(\d{4}-\d{2}-\d{2})/); return m && name.endsWith('.md') ? { name, date: m[1] } : null; })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!dated.length) return null;
  const newest = dated[dated.length - 1];
  const age = Math.round((parseYmd(todayYmd) - parseYmd(newest.date)) / 86400000);
  if (age > PULSE_MAX_AGE_DAYS) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(dir, newest.name), 'utf8'); } catch (err) { return null; }
  return { date: newest.date, excerpt: noteBody(text, 1000) };
}

function gatherWeek(rootDir, now) {
  const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (err) { return ''; } };
  const window = weekWindow(now);
  const archives = readArchives(rootDir, window.days);
  const notes = notesInWindow(rootDir, window.days);
  return {
    window,
    done: doneInWindow(archives, window.days),
    open: openTasks(read(path.join(rootDir, 'tasks', 'tasks.md'))),
    learned: notes.filter(n => n.kind === 'learning' || n.kind === 'remembered' || n.kind === 'note'),
    people: notes.filter(n => n.kind === 'person'),
    journals: journalTexts(rootDir, window.days),
    captures: capturesInWindow(read(path.join(rootDir, 'inbox', 'inbox.md')), window.days),
    health: weekHealth(rootDir, localDate(now || new Date())),
    workouts: workoutsInWindow(rootDir, window.days),
    behaviors: weeklyBehaviorCounts(rootDir, window.days, archives),
    pulse: latestPulse(rootDir, localDate(now || new Date()))
  };
}

/* ------------------------------ compose (pure) ------------------------------ */

function healthLine(cur) {
  const h = cur && cur.health;
  if (!h || !h.days) return '(no health data this week)';
  const parts = [`coverage ${h.coverage}`];
  if (h.avgSteps != null) parts.push(`avg steps ${Math.round(h.avgSteps)}`);
  if (h.exerciseMin != null) parts.push(`exercise ${Math.round(h.exerciseMin)} min`);
  if (h.avgHrv != null) parts.push(`avg HRV ${Math.round(h.avgHrv)}`);
  if (h.avgRestingHr != null) parts.push(`resting HR ${Math.round(h.avgRestingHr)}`);
  if (h.mindfulMin != null) parts.push(`mindful ${Math.round(h.mindfulMin)} min (${h.mindfulDays}d)`);
  return parts.join(' · ');
}

function buildWeeklyPrompt(data) {
  const list = (arr, fmt) => (arr.length ? arr.map(fmt || (x => `- ${x}`)).join('\n') : '(none)');
  const w = data.window;
  return [
    `You are writing the owner's WEEKLY report for the week of ${w.label} (Monday ${w.start} through Sunday ${w.end}).`,
    'This replaces tonight\'s daily evening report — it looks at the WHOLE week.',
    '',
    `TASKS DONE THIS WEEK (${data.done.length}):`,
    list(data.done, d => `- [${d.date.slice(5)}] ${d.title}`),
    '',
    `STILL OPEN (${data.open.length}):`, list(data.open),
    '',
    `LEARNINGS & NOTES FILED THIS WEEK (${data.learned.length}):`,
    list(data.learned, n => `- [${n.kind}] ${n.title}`),
    '',
    `PEOPLE NOTES TOUCHED (${data.people.length}):`, list(data.people, n => `- ${n.title}`),
    '',
    `INBOX CAPTURES (${data.captures.length}):`, list(data.captures, c => `- [${c.date.slice(5)}] ${c.text}`),
    '',
    'HEALTH WEEK (Apple Health, aggregated):',
    healthLine(data.health.cur),
    '',
    `WORKOUTS (${data.workouts.length}):`, list(data.workouts, x => `- [${x.date.slice(5)}] ${x.workout}`),
    '',
    'BALANCE FLAGS (rule-based warnings for this week):',
    list(data.health.flags, f => `- ${f.message}`),
    '',
    `FIVE BEHAVIORS — days touched this week: ${data.behaviors.line}`,
    data.behaviors.low.length ? `(barely touched: ${data.behaviors.low.join(', ')})` : null,
    '',
    'HER OWN WORDS THIS WEEK (journal brain dumps, evening reflections, connections — verbatim, private):',
    data.journals.length
      ? data.journals.map(j => `--- ${j.date} ${j.name} ---\n${j.text}`).join('\n\n')
      : '(no journal entries this week)',
    '',
    'BUSINESS PULSE (latest business-snapshot note, may be a few days old):',
    data.pulse ? `--- ${data.pulse.date} ---\n${data.pulse.excerpt}` : '(no recent pulse note)',
    '',
    `Write in ${OWNER.name}'s voice: ${OWNER.voice}.`,
    // Pronouns come from brain.config.json, never guessed from a name — getting
    // this wrong in a message someone reads at 10pm on a Sunday is not a small thing.
    ownerLine(),
    `Address ${OWNER.pronouns.object} as "you" or by name. Never use gendered terms of address`,
    '("brother", "bro", "man", "king", "sir", "girl") — they are wrong as often as they are right.',
    'Return ONLY a JSON object, no code fence, shaped exactly:',
    '{"text": "...", "speech": "...", "question": "..."}',
    `- "text": the Telegram message, BULLET-POINT style. Start "🗓 Weekly report — ${w.label}". Sections, in order:`,
    '  👤 Personal — 2-4 bullets: what the week actually felt like in your own words (journals/',
    '  reflections), who you connected with. Quote sparingly, never clinically.',
    '  🏃 Health — 2-4 bullets: steps, exercise, HRV, workouts; call any balance flag out plainly.',
    '  💼 Work & Learn — 2-4 bullets: what shipped (count + the highlights that mattered), what you',
    '  learned (takeaways, not raw titles), the business headline if there is one.',
    '  🪞 What you\'re not seeing — 2-4 bullets, the heart of this report: contradictions between',
    '  what you SAID this week (journals/reflections) and what you DID (tasks/health/behaviors),',
    '  behaviors you barely touched, captures you never applied, flags you may have normalized.',
    '  Honest and specific, grounded in the data above — a mirror, never a scolding.',
    '  🎯 Focus of the week — ONE proposed focus for the coming week with a one-line "because",',
    '  chosen from the strongest signal in the data (a flag, a contradiction, an open thread).',
    '  Under 3500 chars total.',
    '- "speech": a 300-450 word spoken script — a trusted teammate sitting down for the Sunday',
    '  debrief, with real energy: vary the rhythm, react to the week (proud, concerned, hyped,',
    '  straight-talk), never monotone-newsreader. Flowing sentences only: no emoji, no headers,',
    '  no bullet lists. You MAY drop in at most 3-4 ElevenLabs v3 audio tags in square brackets',
    '  where they genuinely fit, e.g. [warm] [impressed] [thoughtful] — sparingly, or none.',
    '  Walk through personal, health, work-and-learn, then the blind-spot read, then the proposed',
    '  focus — and END by asking the question below, naturally, as the closing line.',
    '- "question": ONE question asking for a COMMIT to the proposed focus or a different',
    '  one — name the proposed focus explicitly so it can be confirmed or redirected. Never yes/no',
    '  phrasing alone: invite an answer about what the week is FOR.'
  ].filter(l => l !== null).join('\n');
}

// No-LLM fallback so the report always arrives. Can't propose a focus without
// the model — it lays the week out and asks their to set one.
function plainWeekly(data) {
  const w = data.window;
  const lines = [`🗓 Weekly report — ${w.label}`];
  lines.push('', `✅ Done this week (${data.done.length}):`);
  lines.push(...(data.done.length ? data.done.slice(0, 10).map(d => ` • ${d.title}`) : [' • nothing checked off']));
  lines.push('', `📚 Filed (${data.learned.length} notes, ${data.captures.length} captures)`);
  lines.push('', `🏃 Health: ${healthLine(data.health.cur)}`);
  for (const f of data.health.flags) lines.push(` ⚠️ ${f.message}`);
  lines.push('', `⚖️ Behaviors: ${data.behaviors.line}`);
  if (data.journals.length) lines.push('', `📓 Journal entries this week: ${data.journals.length}`);
  if (data.open.length) {
    lines.push('', `🔜 Still open (${data.open.length}):`);
    lines.push(...data.open.slice(0, 6).map(t => ` • ${t}`));
  }
  const question = 'What is your ONE focus for this week — the thing next Sunday\'s report should be judged against?';
  const speech = `Weekly report for ${w.label}. You finished ${data.done.length} task${data.done.length === 1 ? '' : 's'} this week` +
    (data.learned.length ? ` and filed ${data.learned.length} new note${data.learned.length === 1 ? '' : 's'}.` : '.') +
    (data.health.flags.length ? ` Heads up: ${data.health.flags[0].message}` : '') +
    ` Before the new week starts, one question: ${question}`;
  return { text: lines.join('\n'), speech, question };
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

// Build and send the weekly report. Degrades exactly like the evening report:
// health/TickTick sync fail → report still builds; claude fails → plain
// report; ElevenLabs fails → `say`; voice fails entirely → text already went.
// `opts.dryRun`: gather + compose to stdout — no sends, no mutations.
async function runWeeklyReport(cfg, opts = {}) {
  const now = opts.now || new Date();
  const today = localDate(now);
  const rootDir = opts.rootDir || ROOT_DIR;
  const chatId = opts.chatId || cfg.chatId;
  const dryRun = !!opts.dryRun;

  if (!dryRun) {
    // Absorbed Sunday housekeeping: freshen today's health note, then pull
    // TickTick truth so app-checked tasks land in the week's numbers.
    try { await execFileP(process.execPath, [path.join(rootDir, 'system', 'ingest', 'health-ingest.js'), '--date', today], { cwd: rootDir, timeout: 60000 }); }
    catch (err) { console.error('health ingest failed (non-fatal):', err.message); }
    try { await syncTickTick(rootDir, cfg, today); }
    catch (err) { console.error('ticktick sync failed (non-fatal):', err.message); }
  }

  const data = gatherWeek(rootDir, now);
  const report = (await composeWithClaude(buildWeeklyPrompt(data), rootDir)) || plainWeekly(data);

  if (dryRun) {
    console.log('--- DRY RUN: nothing sent, nothing written ---');
    console.log(report.text);
    if (report.question) console.log(`\n💭 This week's question: ${report.question}`);
    console.log('\n--- dry-run data ---');
    console.log(`window: ${data.window.start} → ${data.window.end}`);
    console.log(`done:${data.done.length} learned:${data.learned.length} journals:${data.journals.length} captures:${data.captures.length}`);
    console.log(`behaviors: ${data.behaviors.line}`);
    console.log(`flags: ${data.health.flags.length ? data.health.flags.map(f => f.id).join(', ') : '(none)'}`);
    console.log(`pulse: ${data.pulse ? data.pulse.date : '(none fresh)'}`);
    return { textSent: false, dryRun: true, voiceOk: false, engine: null, question: report.question || null };
  }

  await telegramJson(cfg.token, 'sendMessage', { chat_id: chatId, text: report.text.slice(0, 4096) });

  let voiceOk = false, engine = null;
  try {
    const v = await speak(report.speech, { apiKey: cfg.elevenApiKey, voiceId: cfg.elevenVoiceId });
    engine = v.engine;
    try { await sendVoiceFile(cfg.token, chatId, v.path); voiceOk = true; }
    finally { try { fs.unlinkSync(v.path); } catch (e) { /* ignore */ } }
  } catch (err) {
    console.error('weekly voice failed (text already sent):', err.message);
  }

  // The commit-to-focus question rides as its own message; kind:"weekly" makes
  // bot.js file the answer as <date>-weekly-reflection.md. Same state file and
  // answer window as the nightly question.
  if (report.question) {
    try {
      const q = await telegramJson(cfg.token, 'sendMessage', {
        chat_id: chatId,
        text: `💭 This week's question: ${report.question}\n\n(Reply to this message — text or voice — and I'll file your answer in the brain.)`
      });
      const messageId = q && q.ok && q.result ? q.result.message_id : null;
      fs.mkdirSync(path.dirname(questionStatePath(rootDir)), { recursive: true });
      fs.writeFileSync(questionStatePath(rootDir),
        JSON.stringify({ date: today, chatId: String(chatId), messageId, question: report.question, sentAt: Date.now(), kind: 'weekly' }) + '\n');
    } catch (err) {
      console.error('weekly question send failed (non-fatal):', err.message);
    }
  }

  return { textSent: true, voiceOk, engine, question: report.question || null, counts: { done: data.done.length, learned: data.learned.length, journals: data.journals.length } };
}

module.exports = {
  windowLabel, weekWindow, readArchives, doneInWindow, notesInWindow, noteBody,
  journalTexts, capturesInWindow, weekHealth, workoutsInWindow,
  weeklyBehaviorCounts, latestPulse, gatherWeek, healthLine,
  buildWeeklyPrompt, plainWeekly, runWeeklyReport
};

if (require.main === module) {
  require('../lib/log.js').installTimestamps();
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadEveningConfig();
  if (!dryRun && (!cfg.token || !cfg.chatId)) {
    console.error('weekly.js: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID missing from .env');
    process.exit(1);
  }
  runWeeklyReport(cfg, { dryRun })
    .then(r => {
      if (!r.dryRun) console.log(`weekly report sent (voice: ${r.voiceOk ? r.engine : 'FAILED'}, done:${r.counts.done} learned:${r.counts.learned} journals:${r.counts.journals})`);
    })
    .catch(err => { console.error('weekly report crashed:', err.message); process.exit(1); });
}
