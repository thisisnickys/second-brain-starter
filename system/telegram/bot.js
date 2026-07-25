'use strict';
// MVP Telegram bot for the second brain (Phase 4 slice).
// Zero npm deps — Node built-ins only. Long-polling via Telegram's getUpdates
// (no webhook, no server to expose). See docs/specs/2026-07-06-visual-second-brain-design.md §10.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { planTurn, busyLines } = require('./extract.js');
const { createTask, listProjectTasks, INBOX_PROJECT_ID } = require('./ticktick.js');
const { formatProposal, confirmIntent } = require('./morning.js');
const { findYouTubeUrl, runYouTubeCapture } = require('./youtube.js');
const { findSocialUrl, runSocialCapture } = require('./social.js');
const { findWebUrl, runWebCapture } = require('./web.js');
const { parseDump, recordDump, parseIdeasBrief, ideasBrief } = require('./dump.js');
const { parseIdea, recordIdea, listBank } = require('./idea.js');
const { rememberFact } = require('./remember.js');
const { parsePerson, upsertPerson } = require('./person.js');
const { runEveningReport, loadPendingQuestion, clearPendingQuestion, captureReflection } = require('./evening.js');
const { matchVerdict, parseCardBrand, findOpportunityNote, findSoleActiveToday, fileVerdict } = require('./deal.js');
const { parseSkillRequest, parseListAdd, routeVoice } = require('./intent.js');
const { saveSession, clearSession, loadSessions } = require('./session-store.js');
const { recordLastCapture, loadLastCapture, queueSkillRequest, hasSimilarRequest } = require('./skill-request.js');
const { extractFromReflection } = require('./reflection-extract.js');
const { recordReaction, promoteSpark } = require('../nightshift/ledger.js');
const { linkRelated } = require('../lib/related-notes.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const TASKS_PATH = path.join(ROOT_DIR, 'tasks', 'tasks.md');
const TICKTICK_LEDGER_PATH = path.join(ROOT_DIR, 'tasks', 'ticktick-ledger.jsonl');
const CAPTURE_DIR = path.join(ROOT_DIR, 'inbox');
const CAPTURE_PATH = path.join(CAPTURE_DIR, 'inbox.md');
const BUILD_GRAPH_SCRIPT = path.join(ROOT_DIR, 'system', 'build-graph.js');

// Morning-meeting voice pipeline config (local transcription).
const TMP_DIR = path.join(os.tmpdir(), 'second-brain-voice');
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';

// Live morning-plan conversations, keyed by chat id: { plan }. Each message
// edits the running plan until "yes"/"no" ends the session. Mirrored to disk
// (session-store.js) so a bot restart mid-conversation no longer eats the
// plan — same-day sessions are rehydrated here at startup.
const sessions = loadSessions();

const TELEGRAM_LIMIT = 4096;
const TRUNCATE_SUFFIX = '\n…(truncated)';

const HELP_TEXT = [
  'Second Brain bot — commands:',
  '/start, /help — this message',
  '/tasks — list active to-dos',
  '/evening or "evening report" — how the day went (text + voice note)',
  '🎙️ send a voice note — planning talk becomes your day plan (reply yes to save); a short question gets answered by the brain instead',
  '"brain dump" + what happened / what you learned / ideas (voice or text) — filed as a journal note, NO to-dos, shows up in the evening recap',
  '"idea brief" or "what ideas did I have this week" — a roundup of the ideas from your recent brain dumps (default 7 days; say "today" / "this month" / "last N days")',
  '"I have an idea …" or "idea: <text>" (voice or text) — banked in the Idea Bank (ideas inside brain dumps get banked automatically too)',
  '"idea bank" — show the latest banked ideas',
  'todo: <text>  or  "remind me to <text>" — add a to-do',
  'paste a YouTube link — I transcribe it, take notes, file it in the brain + your Read/Watch List',
  'paste an Instagram reel or TikTok link — I transcribe the video and file it the same way',
  'paste any other link (tweet, Threads, article) — I read it, take notes, file it the same way',
  'remember: <fact>  — save it as a real note in the knowledge base',
  'person: <Name> — <note>  or  "note about <Name>: <note>" — log it on their person page',
  'capture: <text> — save raw text to the capture inbox',
  '"skill this" or "can you make that a skill" — queue a Claude-skill build from your last capture (built + tested in your next Claude session)',
  'anything else — ask the brain a real question'
].join('\n');

/* ------------------------------------------------------------------------ *
 * Pure helpers — no network, no fs side effects. Unit-testable in isolation.
 * ------------------------------------------------------------------------ */

// Parse a simple KEY=VALUE .env file. Ignores blank lines and lines starting
// with '#'. Does not do quoting/escaping — matches the rest of this repo's
// existing .env usage.
function parseEnv(text) {
  const env = {};
  for (const rawLine of String(text == null ? '' : text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    env[key] = line.slice(idx + 1).trim();
  }
  return env;
}

// Only process messages from the allowlisted Telegram user id. Everything
// else (wrong id, missing `from`, malformed update) is rejected silently.
function isAllowed(update, allowedId) {
  // message updates carry `from`; message_reaction updates carry `user`.
  const from = (update && update.message && update.message.from) ||
               (update && update.message_reaction && update.message_reaction.user);
  const id = from && from.id;
  if (id === undefined || id === null) return false;
  if (allowedId === undefined || allowedId === null || allowedId === '') return false;
  return String(id) === String(allowedId);
}

// Route free-text into intents. Kept dumb and deterministic on purpose — no
// LLM call happens until the 'ask' path.
function classify(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { kind: 'help', payload: '' };
  if (/^\/(start|help)(\s|$)/i.test(t)) return { kind: 'help', payload: '' };
  if (/^\/tasks(\s|$)/i.test(t)) return { kind: 'tasks', payload: '' };
  if (/^\/evening(\s|$)/i.test(t) || /^evening report[.!]*$/i.test(t)) return { kind: 'evening', payload: '' };

  // "brain dump …" — a journal entry, NEVER a plan/todo. Checked before the
  // todo prefixes so the keyword reliably bypasses task extraction.
  const dump = parseDump(t);
  if (dump !== null) return { kind: 'dump', payload: dump };

  // "idea brief" / "what ideas did I have …" — a roundup of the ideas in
  // recent brain dumps.
  const brief = parseIdeasBrief(t);
  if (brief) return { kind: 'ideabrief', payload: brief };

  // "idea bank" — show recent banked ideas; "I have an idea …" / "idea: …"
  // — bank a new one (never a to-do, never a plain ask).
  if (/^\/?(?:show (?:me )?(?:my )?)?ideas?[\s-]?bank[.!?]*$/i.test(t)) return { kind: 'ideabank', payload: '' };
  const idea = parseIdea(t);
  if (idea !== null) return { kind: 'idea', payload: idea };

  let m = t.match(/^todo:\s*(.*)$/i);
  if (m && m[1].trim()) return { kind: 'todo', payload: m[1].trim() };

  m = t.match(/^remind me to\s+(.*)$/i);
  if (m && m[1].trim()) return { kind: 'todo', payload: m[1].trim() };

  // "remember to X" reads as a task, so it stays a todo; every other
  // "remember ..." becomes a knowledge-base note.
  m = t.match(/^remember to\s+(.*)$/i);
  if (m && m[1].trim()) return { kind: 'todo', payload: m[1].trim() };

  // "Can you put X on my (task) list" — polite phrasing reads as a question,
  // but it's a todo (the Jul 17 sunscreen loss).
  const listAdd = parseListAdd(t);
  if (listAdd) return { kind: 'todo', payload: listAdd };

  m = t.match(/^remember\s*:?\s+(?:that\s+|this\s+)?(.*)$/i);
  if (m && m[1].trim()) return { kind: 'remember', payload: m[1].trim() };

  // People capture — before the YouTube/capture/ask fallbacks so a note that
  // happens to contain a URL still lands on the person's page.
  const person = parsePerson(t);
  if (person) return { kind: 'person', payload: person };

  // A YouTube link anywhere in the message wins over generic capture/ask —
  // pasting from the share sheet sometimes includes extra text.
  const yt = findYouTubeUrl(t);
  if (yt) return { kind: 'youtube', payload: yt.url };

  // Instagram reels/posts and TikToks get the video pipeline (yt-dlp +
  // Whisper) — the generic web fetch only gets a login wall from them.
  const social = findSocialUrl(t);
  if (social) return { kind: 'social', payload: social };

  m = t.match(/^capture:\s*(.*)$/i);
  if (m && m[1].trim()) return { kind: 'capture', payload: m[1].trim() };

  // Any other link (tweet, Threads post, article) anywhere in the message —
  // with or without surrounding text ("Read this today: <url>") — is a learn
  // capture, never an ask (the brain has no web access; asking about a URL
  // just burns turns and errors out).
  const web = findWebUrl(t);
  if (web) return { kind: 'web', payload: web.url };

  // Deal-card verdicts (agree / counter $X / decline / skip / draft topics)
  // route to the deal desk, never to the generic ask-the-brain fallback.
  const verdict = matchVerdict(t);
  if (verdict) return { kind: 'deal', payload: verdict };

  // "skill this" / "can you make that a skill" → queue a skill-build request
  // against the last capture; never a to-do, never a plain ask.
  const skill = parseSkillRequest(t);
  if (skill) return { kind: 'skillreq', payload: skill };

  return { kind: 'ask', payload: t };
}

// Extract unchecked `- [ ] ...` lines from the ## Active section of tasks.md.
function activeTasks(tasksMd) {
  const lines = String(tasksMd == null ? '' : tasksMd).split('\n');
  let inActive = false;
  const out = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      inActive = /^Active\b/i.test(heading[1].trim());
      continue;
    }
    if (inActive) {
      const m = line.match(/^-\s*\[ \]\s*(.*)$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

// The Telegram confirmation for a capture: title + up to 3 "core ideas"
// bullets pulled from the distilled notes (markdown bold stripped) + the
// Apply line, so the owner sees what got logged without opening the note.
function captureSummary(distill) {
  const d = distill || {};
  const bullets = [];
  for (const line of String(d.notes_md || '').split('\n')) {
    if (/^##\s*quotes/i.test(line.trim())) break;
    const m = line.trim().match(/^[-*]\s+(.*)$/);
    if (m) bullets.push(m[1].replace(/\*\*/g, '').trim());
    if (bullets.length === 3) break;
  }
  if (!bullets.length && d.takeaway) bullets.push(String(d.takeaway).trim());
  const out = [`🧠 Second brain: received and logged ✅`, `"${d.title || 'Untitled'}"`];
  if (bullets.length) out.push('', ...bullets.map(b => `• ${b}`));
  if (d.apply) out.push('', `Apply: ${String(d.apply).trim()}`);
  return out.join('\n');
}

// Insert a new `- [ ] <text> | ...` line at the end of the ## Active section,
// matching the format documented at the top of tasks.md. If there's no
// ## Active heading at all, one is created. `due` is a YYYY-MM-DD string
// (defaults to none for quick dateless todos).
function appendTodo(tasksMd, text, due, behaviors) {
  const md = String(tasksMd == null ? '' : tasksMd);
  const clean = String(text == null ? '' : text).trim();
  const dueStr = /^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? due : 'none';
  const bcsv = Array.isArray(behaviors) && behaviors.length ? behaviors.join(',') : 'none';
  const line = `- [ ] ${clean} | due:${dueStr} | src:telegram | behaviors:${bcsv} | link:none`;

  const headingRe = /^##\s+Active\s*$/m;
  const match = headingRe.exec(md);
  if (!match) {
    const sep = md && !md.endsWith('\n') ? '\n' : '';
    return `${md}${sep}\n## Active\n\n${line}\n`;
  }

  const afterHeading = match.index + match[0].length;
  const rest = md.slice(afterHeading);
  const nextHeading = rest.match(/\n##\s+/);
  const insertAt = nextHeading ? afterHeading + nextHeading.index : md.length;

  const before = md.slice(0, insertAt).replace(/\s+$/, '');
  const after = md.slice(insertAt);
  return `${before}\n${line}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

// One stamped capture line, LOCAL date (never UTC).
function captureEntry(text, dateStr) {
  const clean = String(text == null ? '' : text).trim();
  const d = dateStr || localDate();
  return `- [${d}] ${clean}`;
}

function truncateForTelegram(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= TELEGRAM_LIMIT) return s;
  return s.slice(0, TELEGRAM_LIMIT - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

/* ------------------------------------------------------------------------ *
 * Config loading — thin fs wrapper, not a network call, safe-ish to test
 * with a temp file path.
 * ------------------------------------------------------------------------ */

function loadConfig(envPath = ENV_PATH) {
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    text = '';
  }
  const env = parseEnv(text);
  const missing = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!env.TELEGRAM_ALLOWED_USER_ID) missing.push('TELEGRAM_ALLOWED_USER_ID');
  // TickTick and Notion are optional — everything still lands in the brain
  // without them; Notion just adds the Read/Watch List row.
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    allowedId: env.TELEGRAM_ALLOWED_USER_ID,
    ticktickToken: env.TICKTICK_ACCESS_TOKEN || '',
    ticktickListId: env.TICKTICK_LIST_ID || '',
    notionToken: env.NOTION_TOKEN || '',
    readwatchDb: env.NOTION_READWATCH_DB || '',
    elevenApiKey: env.ELEVENLABS_API_KEY || '',
    elevenVoiceId: env.ELEVENLABS_VOICE_ID || '',
    missing
  };
}

/* ------------------------------------------------------------------------ *
 * Network — thin, deliberately not unit tested (no network calls in tests).
 * ------------------------------------------------------------------------ */

function callTelegram(token, method, params) {
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
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('bad telegram response'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('telegram request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(token, chatId, text) {
  return callTelegram(token, 'sendMessage', { chat_id: chatId, text: truncateForTelegram(text) }).catch(err => {
    console.error('sendMessage failed:', err.message);
  });
}

function getUpdates(token, offset) {
  // message_reaction is opt-in (Night Shift Phase 4): a 🔥 on a spark message
  // is the owner's vote, matched back to the ledger by messageId.
  return callTelegram(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'message_reaction'] });
}

/* ------------------------------------------------------------------------ *
 * Ask-the-brain — scoped execFile. The narrow --allowedTools list IS the
 * MVP's damage-limiter: read + brain.js + brain skill only, nothing that
 * writes, deletes, or hits any other MCP/tool. Do not broaden this without
 * building the full confirm-gate from the design spec (§10).
 * ------------------------------------------------------------------------ */

// "Talk to your captures": her questions often reference the thing she just
// captured without naming it ("can you break down how HE does intros?").
// The last-capture pointer resolves that — the prompt tells claude what
// "he/that video/this" means and where the note + transcript live.
function askPromptWithCapture(text) {
  let cap = null;
  try { cap = loadLastCapture(); } catch (err) { /* no pointer → plain ask */ }
  if (!cap || !cap.title) return text;
  return [
    `Context: the owner's most recent capture is "${cap.title}"` +
      ` (note: ${cap.wikiPath || 'unknown'}${cap.transcriptPath ? `, full transcript: ${cap.transcriptPath}` : ''}).`,
    'If her question refers to "he", "she", "they", "that video", "this", or a subject it',
    'never names, it means THIS capture — Read the note and the transcript and answer',
    'from them directly. Otherwise answer from the brain as usual.',
    '',
    `Question: ${text}`
  ].join('\n');
}

function askBrain(text) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env);
    delete env.CLAUDECODE; // unset to avoid nested-session error

    const child = execFile(
      'claude',
      [
        '-p', askPromptWithCapture(text),
        '--max-turns', '8',
        '--allowedTools', `Bash(node ${ROOT_DIR}/system/brain.js:*) Read`
      ],
      { cwd: ROOT_DIR, env, timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('askBrain error:', err.message, stderr ? `| stderr: ${String(stderr).slice(0, 300)}` : '');
          resolve('Sorry — I hit an error trying to answer that (brain answer failed — if this was about a deal card, reply directly to the card). Try again in a bit.');
          return;
        }
        const answer = String(stdout || '').trim();
        resolve(answer || "Sorry — I didn't get an answer back. Try rephrasing?");
      }
    );
    // claude -p waits ~3s on an open empty stdin ("no stdin data received")
    // before proceeding — close it immediately (equivalent of `< /dev/null`).
    if (child.stdin) child.stdin.end();
  });
}

function refreshGraph() {
  execFile(process.execPath, [BUILD_GRAPH_SCRIPT], { cwd: ROOT_DIR, timeout: 30000 }, err => {
    if (err) console.error('build-graph refresh failed (non-fatal):', err.message);
  });
}

// After a wiki write we need the full derived chain (index → graph → viz)
// so the new note is retrievable AND visible in the galaxy. Best-effort.
async function refreshDerived() {
  for (const script of ['build-index.js', 'build-graph.js', 'build-viz.js']) {
    try {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(ROOT_DIR, 'system', script)],
          { cwd: ROOT_DIR, timeout: 60000 }, err => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      console.error(`${script} refresh failed (non-fatal):`, err.message);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Morning meeting — voice note → transcript → to-dos → scheduled plan.
 * Transcription is fully local (ffmpeg + openai-whisper). Network/shell heavy;
 * the pure pieces (schedule, extract-parse, ticktick payload, proposal text)
 * live in their own modules and are unit-tested.
 * ------------------------------------------------------------------------ */

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`));
      else resolve(stdout);
    });
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); reject(new Error(`download ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// Download a Telegram voice note and transcribe it locally. Returns the text.
async function transcribeVoice(token, fileId) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const res = await callTelegram(token, 'getFile', { file_id: fileId });
  if (!res || !res.ok || !res.result || !res.result.file_path) throw new Error('getFile failed');
  const base = path.join(TMP_DIR, String(fileId).replace(/[^A-Za-z0-9]/g, '') || 'voice');
  const oga = `${base}.oga`, wav = `${base}.wav`, txt = `${base}.txt`;
  try {
    await download(`https://api.telegram.org/file/bot${token}/${res.result.file_path}`, oga);
    await execFileP('ffmpeg', ['-y', '-i', oga, '-ar', '16000', '-ac', '1', wav], { timeout: 60000 });
    await execFileP(WHISPER_BIN, [wav, '--model', WHISPER_MODEL, '--language', 'en',
      '--output_format', 'txt', '--output_dir', TMP_DIR, '--fp16', 'False'],
      { timeout: 300000, maxBuffer: 8 << 20 });
    return fs.readFileSync(txt, 'utf8').trim();
  } finally {
    for (const p of [oga, wav, txt]) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
  }
}

// "13:30" → a Date at that local time on `dateStr` (YYYY-MM-DD), or today when
// dateStr is null/malformed. Null on malformed time.
function hhmmToDate(hhmm, dateStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const d = dm ? new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])) : new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

// Create one TickTick task and record it in the ledger — the evening report
// polls those ids to learn what actually got checked off in the TickTick app.
// A task that lands in tasks.md WITHOUT going through this can never sync an
// app check-off back (that's how todo:-added tasks used to zombie as open).
// Returns true when the task was created.
async function ticktickTrack(item, date, cfg, opts = {}) {
  if (!cfg.ticktickToken) return false;
  const createTaskFn = opts.createTaskFn || createTask;
  const ledgerPath = opts.ledgerPath || TICKTICK_LEDGER_PATH;
  const r = await createTaskFn(item, { token: cfg.ticktickToken, listId: cfg.ticktickListId || null });
  if (!r.ok) { console.error('TickTick create failed:', r.error); return false; }
  if (r.id && r.projectId) {
    const entry = JSON.stringify({ id: r.id, projectId: r.projectId, title: item.title, date });
    try { fs.appendFileSync(ledgerPath, entry + '\n'); }
    catch (err) { console.error('ledger append failed (non-fatal):', err.message); }
  }
  return true;
}

// Write an approved plan: every item to tasks.md, and (if TickTick is set up)
// each as a task — timed blocks carry start/end so TickTick puts them on the
// calendar. Item dates (null = today) ride through both. Returns counts for
// the confirmation message.
async function commitPlan(plan, cfg) {
  let md = '';
  try { md = fs.readFileSync(TASKS_PATH, 'utf8'); } catch (err) { md = ''; }
  let created = 0, failed = 0, timed = 0;
  for (const t of plan) {
    md = appendTodo(md, t.title, t.date || localDate(), t.behaviors);
    if (cfg.ticktickToken) {
      const item = { title: t.title };
      const isTimed = t.calendar && t.start;
      if (isTimed) { item.start = hhmmToDate(t.start, t.date); item.end = hhmmToDate(t.end, t.date) || item.start; }
      if (await ticktickTrack(item, t.date || localDate(), cfg)) {
        created += 1; if (isTimed) timed += 1;
      } else failed += 1;
    }
  }
  fs.writeFileSync(TASKS_PATH, md);
  return { created, failed, timed, total: plan.length };
}

// Best-effort "what's already on the calendar" for the morning planner:
// today's + tomorrow's timed tasks from the target TickTick project, as
// prompt-ready busy lines. ANY failure (no token, TickTick down, bad
// response) → [] and planning proceeds exactly as before — never blocks.
// Project: TICKTICK_LIST_ID if set, else the Inbox (the Open API accepts the
// literal id "inbox" — same target commitPlan writes to when no list is set).
async function fetchBusyBlocks(cfg, now = new Date()) {
  if (!cfg.ticktickToken) return [];
  try {
    const projectId = cfg.ticktickListId || INBOX_PROJECT_ID;
    const tasks = await listProjectTasks(cfg.ticktickToken, projectId);
    return busyLines(tasks, now);
  } catch (err) {
    console.error('busy fetch failed (planning without it):', err.message);
    return [];
  }
}

// One conversational turn: hand Claude the running plan + the new message, get
// the edited plan back, store it, and re-propose. Works for the opening voice
// note and every follow-up (voice or text) alike. Busy blocks are fetched once
// per plan session (first turn) and cached so edit turns don't re-hit TickTick.
async function runTurn(chatId, message, cfg, send) {
  const key = String(chatId);
  const prev = sessions.get(key);
  const busy = prev && Array.isArray(prev.busy) ? prev.busy : await fetchBusyBlocks(cfg);
  let plan;
  try {
    plan = await planTurn(prev ? prev.plan : [], message, { cwd: ROOT_DIR, busy });
  } catch (err) {
    console.error('planTurn error:', err.message);
    await send(cfg.token, chatId, '😕 Hit a snag building the plan. Try again?');
    return;
  }
  sessions.set(key, { plan, busy });
  try { saveSession(key, { plan, busy }); } catch (err) { console.error('session persist failed (non-fatal):', err.message); }
  await send(cfg.token, chatId, formatProposal(plan));
}

// Quick standalone todo (text "todo:", "remind me to", "can you put X on my
// list" — text or voice). Writes tasks.md AND TickTick+ledger so app
// check-offs sync back tonight instead of zombie-ing as "still open".
async function handleQuickTodo(chatId, title, cfg, send) {
  let md = '';
  try { md = fs.readFileSync(TASKS_PATH, 'utf8'); } catch (err) { md = ''; }
  fs.writeFileSync(TASKS_PATH, appendTodo(md, title));
  let inTickTick = false;
  try { inTickTick = await ticktickTrack({ title }, localDate(), cfg); }
  catch (err) { console.error('todo TickTick create failed (non-fatal):', err.message); }
  await send(cfg.token, chatId, `✅ added: ${title}${inTickTick ? ' (+ TickTick)' : ''}`);
  refresh(); // best-effort, ignore failure
}

// Reflection mining (Jul 22 2026 audit): her answers contain two things that
// used to rot in the archive — people she connected with (→ person pages,
// which also arm the Limitless gate) and asks aimed at the second brain
// itself (→ skill-requests/ for the next Claude session). People are only
// mined from connect-question answers; system asks from any answer.
async function mineReflection(chatId, question, answer, cfg, send) {
  const out = await extractFromReflection(question, answer);
  const notes = [];
  if (/\bconnect(?:ed)?\s+with\b/i.test(String(question || ''))) {
    const filed = [];
    for (const p of out.people) {
      try {
        const r = upsertPerson(p.name, p.context ? `connected — ${p.context}` : 'connected (evening reflection)');
        filed.push(r.name);
      } catch (err) { console.error(`person upsert failed for "${p.name}":`, err.message); }
    }
    if (filed.length) notes.push(`👥 Noted on their pages: ${filed.join(', ')}.`);
  }
  const queued = [];
  for (const ask of out.system_asks) {
    if (hasSimilarRequest(ask)) continue;
    try { queueSkillRequest(ask, null, { kind: 'system-ask', source: 'evening reflection' }); queued.push(ask); }
    catch (err) { console.error('system-ask queue failed:', err.message); }
  }
  if (queued.length) notes.push(`🛠 Caught ${queued.length === 1 ? 'a system ask' : queued.length + ' system asks'} — queued for the next Claude session: ${queued.map(q => `"${q}"`).join(' · ')}`);
  if (notes.length) {
    refreshDerived().catch(() => {});
    await send(cfg.token, chatId, notes.join('\n'));
  }
}

// Night Shift Phase 4: a reaction on a delivered spark message → recorded in
// the ledger; a positive one (🔥❤️👍💯⚡) promotes the spark to a real wiki
// note in wiki/<dept>/sparks/ so the graph and brain can build on it.
const NIGHTSHIFT_LEDGER_PATH = path.join(ROOT_DIR, 'system', 'nightshift', 'ledger.jsonl');
async function handleReaction(mr, cfg) {
  const emoji = (Array.isArray(mr.new_reaction) ? mr.new_reaction : [])
    .map(r => (r && (r.emoji || (r.custom_emoji_id ? '🔥' : ''))) || '').filter(Boolean).join('');
  if (!emoji) return; // reaction removed — nothing to record
  const entry = recordReaction(NIGHTSHIFT_LEDGER_PATH, mr.message_id, emoji);
  if (!entry) return; // not a spark message
  console.log(`spark reaction: ${emoji} on ${entry.id} ("${entry.title}")`);
  if (/[🔥❤👍💯⚡]/u.test(emoji)) {
    try {
      const rel = promoteSpark(entry, ROOT_DIR);
      refreshDerived().catch(() => {});
      await send(cfg.token, mr.chat.id, `🔥 Got it — that spark is now in the brain (${rel}). Night Shift will build on it.`);
    } catch (err) { console.error('spark promotion failed (non-fatal):', err.message); }
  }
}

// "brain dump" → distilled journal note (dump.js), never the plan engine.
// The note carries today's `updated:` so learnedToday() pulls it into the
// evening recap automatically. Failure falls back to the inbox — never lost.
async function handleDump(chatId, body, cfg, send) {
  if (!body) {
    await send(cfg.token, chatId, '🧠 Ready — say or type "brain dump" plus everything on your mind, and I\'ll file it as a journal note (no to-dos created).');
    return;
  }
  await send(cfg.token, chatId, '🧠 Brain dump — got it. Filing it as a journal note (no to-dos)…');
  try {
    const r = await recordDump(body);
    refreshDerived().catch(() => {});
    await send(cfg.token, chatId,
      captureSummary({ title: r.distill.title, notes_md: r.distill.bullets_md, apply: r.distill.apply }) +
      (r.banked ? `\n\n💡 ${r.banked === 1 ? '1 idea' : r.banked + ' ideas'} from this dump added to the idea bank.` : '') +
      "\n\nIt'll be in tonight's evening recap.");
  } catch (err) {
    console.error('brain dump failed:', err.message);
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(CAPTURE_PATH, captureEntry(`Brain dump — ${body}`, localDate()) + '\n');
    await send(cfg.token, chatId, '📥 Saved your dump to the inbox (note-filing hit a snag, but it is not lost).');
  }
}

// "I have an idea …" → distilled entry in the idea bank (idea.js). Never a
// to-do, never a plan item. Failure falls back to the inbox — never lost.
async function handleIdea(chatId, body, cfg, send, src) {
  if (!body) {
    await send(cfg.token, chatId, '💡 Ready — say "I have an idea" plus the idea itself, and I\'ll add it to the bank.');
    return;
  }
  await send(cfg.token, chatId, '💡 Got the idea — adding it to the bank…');
  try {
    const r = await recordIdea(body, { src: src || 'text' });
    refreshDerived().catch(() => {});
    await send(cfg.token, chatId, `💡 Banked: ${r.entry.text}\n\nSay "idea bank" to see recent ideas, or "idea brief" for a roundup.`);
  } catch (err) {
    console.error('idea capture failed:', err.message);
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(CAPTURE_PATH, captureEntry(`Idea — ${body}`, localDate()) + '\n');
    await send(cfg.token, chatId, '📥 Saved the idea to the inbox (bank write hit a snag, but it is not lost).');
  }
}

// "idea brief" — roundup of ideas in recent brain dumps. Shared by the text
// and voice routes.
async function handleIdeasBrief(chatId, payload, cfg, send) {
  await send(cfg.token, chatId, '💡 Pulling the ideas out of your recent brain dumps…');
  try {
    const r = await ideasBrief(payload.days);
    if (r.empty) {
      await send(cfg.token, chatId, `No brain dumps in the last ${r.days === 1 ? 'day' : r.days + ' days'} — send one with "brain dump …" and ask me again.`);
      return;
    }
    await send(cfg.token, chatId, `💡 Ideas from your last ${r.days === 1 ? 'day' : r.days + ' days'} of brain dumps (${r.dumps} day${r.dumps === 1 ? '' : 's'} of entries):\n\n${r.text}`);
  } catch (err) {
    console.error('ideas brief failed:', err.message);
    await send(cfg.token, chatId, '😕 Couldn\'t build the ideas brief just now — try again in a bit.');
  }
}

// "Skill this" / "can you make that a skill" — queue a skill-build request
// against the last capture. The bot never authors the skill itself (its
// claude is read-scoped); a real Claude session builds and tests it.
async function handleSkillRequest(chatId, requestText, cfg, send, deps = {}) {
  const capture = (deps.loadLastCapture || loadLastCapture)();
  try {
    const r = (deps.queueSkillRequest || queueSkillRequest)(requestText, capture);
    const from = capture && capture.title ? ` from "${capture.title}"` : '';
    await send(cfg.token, chatId,
      `🛠️ Skill request queued${from} — nothing added to your to-do list.\n` +
      `Saved to ${path.relative(ROOT_DIR, r.path)}. Next time you're in Claude, say ` +
      `"build my skill requests" and it'll get built and tested there.`);
  } catch (err) {
    console.error('skill request failed:', err.message);
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(CAPTURE_PATH, captureEntry(`Skill request — ${requestText}`, localDate()) + '\n');
    await send(cfg.token, chatId, '📥 Saved your skill request to the inbox (queue write hit a snag, but it is not lost).');
  }
}

// The voice-note flow: transcribe locally, then ROUTE — brain dump → journal,
// skill request → queue, short question (no live plan session) → the brain,
// everything else → the morning-plan engine. Voice used to be hardwired to
// the planner, which is how "is that a skill you can create?" became a to-do.
async function handleVoice(update, cfg, send) {
  const chatId = update.message.chat.id;
  await send(cfg.token, chatId, '🎙️ Got it — transcribing (a moment)…');
  let transcript;
  try {
    transcript = await transcribeVoice(cfg.token, update.message.voice.file_id);
  } catch (err) {
    console.error('transcribe error:', err.message);
    await send(cfg.token, chatId, "😕 I couldn't transcribe that. Mind re-recording?");
    return;
  }
  if (!transcript) { await send(cfg.token, chatId, 'That came back empty — nothing to plan.'); return; }
  console.log('[voice] transcript:', transcript.replace(/\s+/g, ' ').slice(0, 400));
  const route = routeVoice(transcript, { hasSession: sessions.has(String(chatId)) });
  if (route.kind === 'dump') { await handleDump(chatId, route.payload, cfg, send); return; }
  if (route.kind === 'ideabrief') { await handleIdeasBrief(chatId, route.payload, cfg, send); return; }
  if (route.kind === 'idea') { await handleIdea(chatId, route.payload, cfg, send, 'voice'); return; }
  if (route.kind === 'todo') { await handleQuickTodo(chatId, route.payload, cfg, send); return; }
  if (route.kind === 'skill') { await handleSkillRequest(chatId, route.payload, cfg, send); return; }
  if (route.kind === 'ask') {
    await send(cfg.token, chatId, '🧠 thinking…');
    await send(cfg.token, chatId, await askBrain(route.payload));
    return;
  }
  await runTurn(chatId, transcript, cfg, send);
}

/* ------------------------------------------------------------------------ *
 * Deal desk — a reply to a 💼 deal card (or a bare verdict) files the owner's
 * verdict onto the matching wiki/business/opportunities/ note. The bot never
 * drafts emails or topics (its claude is read-scoped) — sessions do that.
 * ------------------------------------------------------------------------ */

async function handleDealVerdict({ chatId, text, brand }, cfg, deps = {}) {
  const send = deps.sendMessage || sendMessage;
  const refreshDeep = deps.refreshDerived || refreshDerived;
  const capturePath = deps.capturePath || CAPTURE_PATH;
  const oppDir = deps.oppDir; // undefined -> real wiki/business/opportunities/

  // A direct card reply counts even when the text isn't a canonical verdict
  // ("Draft topics for both" etc.) — it's still logged verbatim; only
  // agree/counter/decline move the Status.
  const verdict = matchVerdict(text) || { kind: 'note', verbatim: String(text).trim() };

  let note = null;
  if (brand) {
    note = findOpportunityNote(brand, oppDir);
    if (!note) {
      await send(cfg.token, chatId, `Which deal? I couldn't match "${brand}" to an opportunity note — reply to the card or name the brand.`);
      return;
    }
  } else {
    const r = findSoleActiveToday(oppDir);
    if (!r.note) {
      await send(cfg.token, chatId, 'Which deal? Reply to the card or name the brand.');
      return;
    }
    note = r.note;
  }

  const brandLabel = brand || (note.title.split(/\s*[—–]\s*/)[0] || note.title).trim();
  try {
    fileVerdict(note.path, verdict);
    refreshDeep().catch(() => {});
    if (verdict.kind === 'draft') {
      await send(cfg.token, chatId, 'Filed ✅ — topic drafts queued for the next session.');
    } else {
      await send(cfg.token, chatId, `Filed ✅ ${brandLabel} — "${verdict.verbatim}". Drafting happens in the next Claude session — say "oppty" there or it'll be picked up automatically.`);
    }
  } catch (err) {
    console.error('deal verdict failed:', err.message);
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.appendFileSync(capturePath, captureEntry(`Deal verdict — ${brandLabel}: "${verdict.verbatim}"`, localDate()) + '\n');
    await send(cfg.token, chatId, '📥 Saved your verdict to the inbox (deal-note update hit a snag, but it is not lost).');
  }
}

/* ------------------------------------------------------------------------ *
 * Message handling — glue between the pure logic above and fs/network.
 * ------------------------------------------------------------------------ */

async function handleMessage(update, cfg, deps = {}) {
  const send = deps.sendMessage || sendMessage;
  const ask = deps.askBrain || askBrain;
  const refresh = deps.refreshGraph || refreshGraph;

  const chatId = update.message.chat.id;
  const text = update.message.text || '';

  // A text reply to a 💼 deal card is ALWAYS a deal verdict — checked before
  // everything else (incl. the nightly-question block) so it can't be
  // swallowed by the reflection capture or the generic ask fallback.
  const dealReply = update.message.reply_to_message;
  const cardBrand = dealReply && typeof dealReply.text === 'string' ? parseCardBrand(dealReply.text) : null;
  if (text && cardBrand) {
    await handleDealVerdict({ chatId, text, brand: cardBrand }, cfg, deps);
    return;
  }

  // Nightly-question answer. Two ways in, checked before the voice branch so
  // an answer voice note doesn't start a plan session:
  //  1. a swipe-reply to the question message — works any time while pending;
  //  2. ANY voice note, or free text that isn't a command/todo/URL, inside the
  //     first 90 minutes after the question went out — the owner just records an
  //     answer, he doesn't swipe-reply.
  const pendingQ = loadPendingQuestion();
  const replyTo = update.message.reply_to_message;
  const ANSWER_WINDOW_MS = 90 * 60 * 1000;
  const qIsReply = pendingQ && replyTo && (!pendingQ.messageId || replyTo.message_id === pendingQ.messageId);
  const qFresh = pendingQ && pendingQ.sentAt && (Date.now() - pendingQ.sentAt) < ANSWER_WINDOW_MS;
  const qFreshAnswer = qFresh && (update.message.voice || (text && classify(text).kind === 'ask'));
  if (pendingQ && String(chatId) === String(pendingQ.chatId) && (qIsReply || qFreshAnswer)) {
    let answer = text;
    if (update.message.voice) {
      await send(cfg.token, chatId, '🎙️ Got it — transcribing your answer…');
      try { answer = await transcribeVoice(cfg.token, update.message.voice.file_id); }
      catch (err) { console.error('reflection transcribe error:', err.message); answer = ''; }
      if (!answer) { await send(cfg.token, chatId, "😕 Couldn't transcribe that. Mind re-recording or typing it?"); return; }
    }
    if (!answer.trim()) { await send(cfg.token, chatId, 'That came back empty — send your answer again?'); return; }
    // An explicit "brain dump" inside the answer window is a dump, not the
    // reflection answer — the keyword always wins. Same for an explicit
    // "I have an idea …" — that's an idea-bank capture, not the answer.
    const qDump = parseDump(answer);
    if (qDump !== null) { await handleDump(chatId, qDump, cfg, send); return; }
    const qIdea = parseIdea(answer);
    if (qIdea !== null) { await handleIdea(chatId, qIdea, cfg, send, update.message.voice ? 'voice' : 'text'); return; }
    try {
      const rel = captureReflection(pendingQ.question, answer, { date: pendingQ.date, kind: pendingQ.kind });
      clearPendingQuestion();
      refreshDerived().catch(() => {});
      await send(cfg.token, chatId, `🧠 Filed. Your reflection is in the brain (${rel}). Sleep good.`);
      // Mine the answer for people she connected with + system asks — async,
      // never blocks or breaks the goodnight reply.
      mineReflection(chatId, pendingQ.question, answer, cfg, send)
        .catch(err => console.error('reflection mining failed (non-fatal):', err.message));
    } catch (err) {
      console.error('reflection capture failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(`${pendingQ.kind === 'weekly' ? 'Weekly' : 'Evening'} reflection — Q: ${pendingQ.question} A: ${answer}`, localDate()) + '\n');
      clearPendingQuestion();
      await send(cfg.token, chatId, '📥 Saved your answer to the inbox (note-filing hit a snag, but it is not lost).');
    }
    return;
  }

  // Morning meeting: a voice note starts or edits the running plan.
  if (update.message.voice) {
    await handleVoice(update, cfg, send);
    return;
  }

  // While a plan conversation is live, text is either a yes/no or an edit —
  // except an explicit "brain dump", which files a journal note and leaves
  // the plan session untouched.
  const sess = sessions.get(String(chatId));
  if (sess && text) {
    const sessDump = parseDump(text);
    if (sessDump !== null) { await handleDump(chatId, sessDump, cfg, send); return; }
    // An explicit "I have an idea …" mid-plan-session is a bank capture too.
    const sessIdea = parseIdea(text);
    if (sessIdea !== null) { await handleIdea(chatId, sessIdea, cfg, send, 'text'); return; }
    // A skill request mid-plan-session is still a skill request, not an edit.
    const sessSkill = parseSkillRequest(text);
    if (sessSkill) { await handleSkillRequest(chatId, sessSkill, cfg, send, deps); return; }
    const intent = confirmIntent(text);
    if (intent === 'yes') {
      sessions.delete(String(chatId));
      try { clearSession(String(chatId)); } catch (err) { /* non-fatal */ }
      await send(cfg.token, chatId, '📌 Saving…');
      const r = await commitPlan(sess.plan, cfg);
      refresh();
      let msg;
      if (cfg.ticktickToken) {
        msg = `✅ In TickTick — ${r.created} task${r.created === 1 ? '' : 's'} in your Inbox`;
        if (r.timed) msg += ` (${r.timed} timed → on your calendar)`;
        msg += '.';
        if (r.failed) msg += ` ⚠️ ${r.failed} didn't save — check the logs.`;
        msg += '\n📝 Also logged to your brain. (Give the TickTick app a few seconds to sync.)';
      } else {
        msg = `✅ Saved ${r.total} item${r.total === 1 ? '' : 's'} to your brain. (TickTick not configured, so nothing synced there.)`;
      }
      msg += '\n\nSend a new voice note whenever you want to plan again.';
      await send(cfg.token, chatId, msg);
      return;
    }
    if (intent === 'no') {
      sessions.delete(String(chatId));
      try { clearSession(String(chatId)); } catch (err) { /* non-fatal */ }
      await send(cfg.token, chatId, '🗑️ Scrapped it. Send a new voice note to start fresh.');
      return;
    }
    // Anything else is an edit to the current draft — refine and re-propose.
    await runTurn(chatId, text, cfg, send);
    return;
  }

  // A bare yes/no with NO live session used to fall through to ask-the-brain
  // (a wasted claude call answering "Yes"). Say what's true instead.
  if (text && confirmIntent(text)) {
    await send(cfg.token, chatId, '🤷 Nothing pending to confirm — there\'s no live plan session right now. Send the plan again, or "todo: …" for a quick task.');
    return;
  }

  const c = classify(text);

  if (c.kind === 'help') {
    await send(cfg.token, chatId, HELP_TEXT);
    return;
  }

  if (c.kind === 'tasks') {
    let md = '';
    try {
      md = fs.readFileSync(TASKS_PATH, 'utf8');
    } catch (err) {
      md = '';
    }
    const tasks = activeTasks(md);
    if (!tasks.length) {
      await send(cfg.token, chatId, 'No active tasks. 🎉');
    } else {
      await send(cfg.token, chatId, tasks.map((t, i) => `${i + 1}. ${t}`).join('\n'));
    }
    return;
  }

  if (c.kind === 'evening') {
    await send(cfg.token, chatId, '🌙 Pulling your day together (text first, voice note right behind it)…');
    try {
      const r = await runEveningReport(cfg, { chatId });
      if (!r.voiceOk) await send(cfg.token, chatId, '⚠️ The voice note failed this time — the text above is the full report.');
    } catch (err) {
      console.error('evening report failed:', err.message);
      await send(cfg.token, chatId, '😕 Could not build the evening report. Try again in a bit.');
    }
    return;
  }

  if (c.kind === 'todo') {
    await handleQuickTodo(chatId, c.payload, cfg, send);
    return;
  }

  if (c.kind === 'dump') {
    await handleDump(chatId, c.payload, cfg, send);
    return;
  }

  if (c.kind === 'ideabrief') {
    await handleIdeasBrief(chatId, c.payload, cfg, send);
    return;
  }

  if (c.kind === 'idea') {
    await handleIdea(chatId, c.payload, cfg, send, 'text');
    return;
  }

  if (c.kind === 'ideabank') {
    const recent = listBank(undefined, 15);
    await send(cfg.token, chatId, recent.length
      ? `💡 Idea bank — latest ${recent.length}:\n\n${recent.join('\n')}`
      : '💡 The idea bank is empty — say "I have an idea …" (voice or text) and I\'ll start it.');
    return;
  }

  if (c.kind === 'youtube') {
    await send(cfg.token, chatId, '📺 Got the link — pulling the transcript and taking notes. Give me a couple minutes…');
    try {
      const r = await runYouTubeCapture(c.payload, cfg, text => send(cfg.token, chatId, text));
      if (r.duplicate) {
        await send(cfg.token, chatId, `🧠 Already logged ✅ ("${r.meta.title}" is in your ${r.where}.)`);
        return;
      }
      try { recordLastCapture({ kind: 'youtube', title: r.distill.title, wikiPath: r.wikiPath, transcriptPath: r.transcriptPath, url: c.payload }); } catch (e) { /* non-fatal */ }
      const related = linkRelated(ROOT_DIR, r.wikiPath, r.distill.title);
      if (related) await send(cfg.token, chatId, `🔗 Related to an earlier capture: ${related.title}`);
      await refreshDerived(); // notify only once it's loaded everywhere
      let msg = captureSummary(r.distill);
      if (r.notionError) msg += `\n⚠️ Notion didn't save (${r.notionError}) — the note is still safe in the brain.`;
      await send(cfg.token, chatId, msg);
    } catch (err) {
      console.error('youtube capture failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(c.payload, localDate()) + '\n');
      await send(cfg.token, chatId, `😕 Couldn't process that video (${err.message}). I saved the link to your inbox so it isn't lost.`);
    }
    return;
  }

  if (c.kind === 'social') {
    const label = c.payload.platform === 'tiktok' ? 'TikTok' : 'reel';
    await send(cfg.token, chatId, `🎬 Got the ${label} — pulling the video and transcribing it. Give me a couple minutes…`);
    try {
      const r = await runSocialCapture(c.payload, cfg, text => send(cfg.token, chatId, text));
      if (r.duplicate) {
        await send(cfg.token, chatId, `🧠 Already logged ✅ ("${r.meta.title}" is in your ${r.where}.)`);
        return;
      }
      try { recordLastCapture({ kind: 'social', title: r.distill.title, wikiPath: r.wikiPath, transcriptPath: r.transcriptPath, url: c.payload.url }); } catch (e) { /* non-fatal */ }
      const related = linkRelated(ROOT_DIR, r.wikiPath, r.distill.title);
      if (related) await send(cfg.token, chatId, `🔗 Related to an earlier capture: ${related.title}`);
      await refreshDerived(); // notify only once it's loaded everywhere
      let msg = captureSummary(r.distill);
      if (r.notionError) msg += `\n⚠️ Notion didn't save (${r.notionError}) — the note is still safe in the brain.`;
      await send(cfg.token, chatId, msg);
    } catch (err) {
      console.error('social capture failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(c.payload.url, localDate()) + '\n');
      await send(cfg.token, chatId, `😕 Couldn't process that video (${err.message}). I saved the link to your inbox so it isn't lost.`);
    }
    return;
  }

  if (c.kind === 'web') {
    await send(cfg.token, chatId, '🔗 Got the link — reading it and taking notes. One minute…');
    try {
      const r = await runWebCapture(c.payload, cfg);
      if (r.duplicate) {
        await send(cfg.token, chatId, `🧠 Already logged ✅ (that link is in your ${r.where}.)`);
        return;
      }
      try { recordLastCapture({ kind: 'web', title: r.distill.title, wikiPath: r.wikiPath, transcriptPath: r.transcriptPath || '', url: c.payload }); } catch (e) { /* non-fatal */ }
      const related = linkRelated(ROOT_DIR, r.wikiPath, r.distill.title);
      if (related) await send(cfg.token, chatId, `🔗 Related to an earlier capture: ${related.title}`);
      await refreshDerived(); // notify only once it's loaded everywhere
      let msg = captureSummary(r.distill);
      if (r.notionError) msg += `\n⚠️ Notion didn't save (${r.notionError}) — the note is still safe in the brain.`;
      await send(cfg.token, chatId, msg);
    } catch (err) {
      console.error('web capture failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(c.payload, localDate()) + '\n');
      await send(cfg.token, chatId, `😕 Couldn't read that link (${err.message}). I saved it to your inbox so it isn't lost.`);
    }
    return;
  }

  if (c.kind === 'remember') {
    await send(cfg.token, chatId, '🧠 Filing that away…');
    try {
      const r = await rememberFact(c.payload);
      refreshDerived().catch(() => {});
      await send(cfg.token, chatId, `✅ Remembered: "${r.title}" → ${r.path}`);
    } catch (err) {
      console.error('remember failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(c.payload, localDate()) + '\n');
      await send(cfg.token, chatId, '📥 Saved to your inbox (note-filing hit a snag, but it is not lost).');
    }
    return;
  }

  if (c.kind === 'person') {
    const { name, note } = c.payload;
    try {
      const r = upsertPerson(name, note);
      refreshDerived().catch(() => {});
      await send(cfg.token, chatId, `Noted for ${r.name} 🧠 (person file ${r.created ? 'created' : 'updated'})`);
    } catch (err) {
      console.error('person note failed:', err.message);
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.appendFileSync(CAPTURE_PATH, captureEntry(`Person note — ${name}: ${note}`, localDate()) + '\n');
      await send(cfg.token, chatId, '📥 Saved to your inbox (person-file update hit a snag, but it is not lost).');
    }
    return;
  }

  if (c.kind === 'deal') {
    // Bare verdict with no reply-to context — resolve against the one active
    // (new/reviewed, updated today) deal, else ask which one.
    await handleDealVerdict({ chatId, text, brand: null }, cfg, deps);
    return;
  }

  if (c.kind === 'skillreq') {
    await handleSkillRequest(chatId, c.payload, cfg, send, deps);
    return;
  }

  if (c.kind === 'capture') {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(CAPTURE_PATH, captureEntry(c.payload, localDate()) + '\n');
    await send(cfg.token, chatId, '📥 captured');
    return;
  }

  // 'ask' — real question/request. Ack first so the user isn't left hanging.
  await send(cfg.token, chatId, '🧠 thinking…');
  const answer = await ask(c.payload);
  await send(cfg.token, chatId, answer);
}

/* ------------------------------------------------------------------------ *
 * Long-poll loop
 * ------------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function pollLoop(cfg) {
  let offset = 0;
  console.log('Second Brain Telegram bot: polling started.');
  for (;;) {
    let updates = [];
    try {
      const res = await getUpdates(cfg.token, offset);
      if (!res || !res.ok) {
        await sleep(2000);
        continue;
      }
      updates = res.result || [];
    } catch (err) {
      console.error('getUpdates failed:', err.message);
      await sleep(3000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      if (!isAllowed(update, cfg.allowedId)) continue; // unknown sender: ignore silently
      if (update.message_reaction) {
        handleReaction(update.message_reaction, cfg).catch(err => console.error('handleReaction error:', err.message));
        continue;
      }
      if (!update.message || (typeof update.message.text !== 'string' && !update.message.voice)) continue;
      handleMessage(update, cfg).catch(err => console.error('handleMessage error:', err.message));
    }
  }
}

module.exports = {
  parseEnv,
  isAllowed,
  classify,
  activeTasks,
  appendTodo,
  ticktickTrack,
  captureEntry,
  captureSummary,
  truncateForTelegram,
  loadConfig,
  handleMessage,
  handleDealVerdict,
  HELP_TEXT
};

if (require.main === module) {
  require('../lib/log.js').installTimestamps();
  const cfg = loadConfig();
  if (cfg.missing.length) {
    console.error(
      `Missing required .env keys: ${cfg.missing.join(', ')}.\n` +
        `Add them to ${ENV_PATH} (TELEGRAM_BOT_TOKEN from @BotFather, TELEGRAM_ALLOWED_USER_ID from e.g. @userinfobot) and try again.`
    );
    process.exit(1);
  }
  // .env integrity guard — the fused-line bug (token line merged with the
  // next KEY=…) once caused a day of silent TickTick 401s. Warn loudly at
  // startup, in the log AND on the owner's phone, but keep running: the bot
  // itself only needs the two keys checked above.
  {
    const { checkEnvText } = require('../lib/env-check.js');
    let envText = '';
    try { envText = fs.readFileSync(ENV_PATH, 'utf8'); } catch (err) { envText = ''; }
    const problems = checkEnvText(envText, ['NOTION_TOKEN', 'TICKTICK_ACCESS_TOKEN']);
    if (problems.length) {
      console.error('.env check FAILED:', problems.join(' | '));
      sendMessage(cfg.token, cfg.allowedId,
        `⚠️ Second brain .env problem(s):\n${problems.map(p => `• ${p}`).join('\n')}\n\nFix ${ENV_PATH} then restart the bot (it caches .env).`);
    }
  }
  pollLoop(cfg).catch(err => {
    console.error('Bot crashed:', err.message);
    process.exit(1);
  });
}
