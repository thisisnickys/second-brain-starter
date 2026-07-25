'use strict';
// "brain dump" → a distilled journal entry, NOT a plan. the owner says or types
// "brain dump" followed by whatever happened / what she learned; it's cleaned
// into bullets and filed as one note per day at
// wiki/personal/journal/<date>-brain-dump.md (sections append through the
// day). The evening report picks it up automatically — learnedToday() scans
// for `updated: <today>` — so dumps land in the recap with zero extra wiring.
// Explicitly NO task extraction: that's the plan engine's job, and the whole
// point of the keyword is to bypass it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { noteErrors } = require('../lib/note-write.js');
const { appendToBank } = require('./idea.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

/* ------------------------------- pure ---------------------------------- */

const TRIGGER_RE = /\bbrain[\s-]?dump\b/i;
// Words allowed BEFORE the trigger — spoken filler only. Anything substantive
// ("what did my brain dump say") means the message is ABOUT a dump, not one.
const FILLER = new Set([
  'ok', 'okay', 'so', 'hey', 'yo', 'um', 'uh', 'umm', 'uhh', 'alright', 'all',
  'right', 'this', 'is', 'a', 'an', 'my', 'the', 'quick', 'new', 'another',
  'heres', 'here', 'its', 'it', 'time', 'for', 'just', 'little'
]);

// "brain dump <stuff>" → "<stuff>". Returns '' for a bare trigger and null
// when the message isn't a dump at all.
function parseDump(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const m = TRIGGER_RE.exec(t);
  if (!m) return null;
  const pre = t.slice(0, m.index).toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  if (pre) {
    for (const w of pre.split(/\s+/)) {
      if (!FILLER.has(w)) return null;
    }
  }
  return t.slice(m.index + m[0].length).replace(/^[\s,.:;!?—–-]+/, '').trim();
}

function fmtTime(d) {
  const dt = d instanceof Date ? d : new Date();
  let h = dt.getHours();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return `${h}:${String(dt.getMinutes()).padStart(2, '0')}${ap}`;
}

function buildDumpPrompt(body) {
  return [
    "the owner just sent a BRAIN DUMP — a spoken or typed journal entry about what happened today and what she learned.",
    'This is NOT a to-do list. Do NOT extract tasks, reminders, or scheduling — capture knowledge and events only.',
    '',
    'Brain dump:',
    '"""',
    String(body == null ? '' : body),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{',
    '  "title": 3-8 word title for this entry (what it was about),',
    '  "bullets_md": markdown bullets ("- ") of what happened / what she learned / ideas worth keeping — keep names, numbers, tools, and specifics; clean up the spoken rambling but keep her meaning; 2-10 bullets,',
    '  "apply": ONE sentence — the most useful way to use this — or "" when nothing is actionable,',
    '  "ideas": array of 0-3 short strings — ONLY genuine ideas she voiced (something she could build, make, try, or say — especially anything she flags with "I have an idea"); [] when the dump has none. Each 1 crisp sentence.',
    '}'
  ].join('\n');
}

function parseDumpDistill(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('dump distill: no JSON in output');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!obj.title || !obj.bullets_md) throw new Error('dump distill: missing title/bullets_md');
  return {
    title: String(obj.title).trim(),
    bullets_md: String(obj.bullets_md).trim(),
    apply: String(obj.apply || '').trim(),
    ideas: Array.isArray(obj.ideas)
      ? obj.ideas.map(v => String(v).trim()).filter(Boolean).slice(0, 3)
      : []
  };
}

function dumpPath(dateStr, rootDir) {
  return path.join(rootDir || ROOT_DIR, 'wiki', 'personal', 'journal', `${dateStr}-brain-dump.md`);
}

// One timed section per dump. Empty apply is omitted entirely.
function dumpSection({ distill, timeStr }) {
  const lines = [`## ${timeStr} — ${distill.title}`, '', distill.bullets_md.trim()];
  if (distill.apply) lines.push('', `**Apply:** ${distill.apply}`);
  return lines.join('\n');
}

function buildDumpNote({ distill, dateStr, timeStr }) {
  return [
    '---',
    `title: Brain dump — ${dateStr}`,
    'department: personal',
    'tags: [brain-dump, journal]',
    'behaviors: [learn]',
    'source: telegram',
    `updated: ${dateStr}`,
    '---',
    '',
    `# Brain dump — ${dateStr}`,
    '',
    dumpSection({ distill, timeStr }),
    ''
  ].join('\n');
}

// Later dumps the same day append below the existing sections.
function appendDumpSection(content, section, dateStr) {
  let s = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  s = s.replace(/^updated:.*$/m, `updated: ${dateStr}`);
  return `${s.replace(/\s+$/, '')}\n\n${section}\n`;
}

/* ------------------------------ ideas brief ------------------------------ */

// "idea brief" / "what ideas did I have …" → { days } or null. Owns only the
// explicit brief phrasings; "I have an idea about X" stays a normal message.
function parseIdeasBrief(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const hit = /\bideas?\s*brief\b/i.test(t)
    || /^brief\s+(?:me\s+)?(?:on\s+|of\s+|about\s+)?(?:my\s+)?(?:recent\s+)?ideas?\b/i.test(t)
    || /^what\s+ideas\b/i.test(t);
  if (!hit) return null;
  let days = 7;
  const n = t.match(/last\s+(\d{1,3})\s+days?/i);
  if (n) days = Math.max(1, Number(n[1]));
  else if (/\btoday\b/i.test(t)) days = 1;
  else if (/\b(this|last)\s+month\b/i.test(t) || /last\s+30/i.test(t)) days = 30;
  return { days };
}

// Brain-dump note bodies (frontmatter stripped) with filename date >= since,
// newest first. Sync scan — the journal dir is small.
function listDumpSections(rootDir, sinceDateStr) {
  const dir = path.join(rootDir || ROOT_DIR, 'wiki', 'personal', 'journal');
  let files;
  try { files = fs.readdirSync(dir); } catch (err) { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-brain-dump\.md$/);
    if (!m || m[1] < sinceDateStr) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    out.push({ date: m[1], body });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function buildIdeasBriefPrompt(sections, days) {
  const dumps = sections.map(s => `### ${s.date}\n${s.body}`).join('\n\n');
  return [
    `You are briefing the owner on the IDEAS she captured in her brain-dump journal over the last ${days} day${days === 1 ? '' : 's'}.`,
    '',
    'Her brain dumps (newest first):',
    '"""',
    dumps,
    '"""',
    '',
    'Write a short Telegram-friendly brief of her IDEAS only:',
    '- An idea = something she could build, make, try, or say — skip status updates, events, tasks, and plain facts she learned.',
    '- Group duplicates/related ideas together.',
    '- Format: numbered list, each entry "**<short idea name>** (<date>) — one line on what it is / why it matters." Bold with **, no headings.',
    '- End with one line: which 1-2 ideas look most worth acting on and why.',
    '- If there are genuinely no ideas in the dumps, say so plainly in one sentence.',
    'Output the brief text only — no preamble, no code fences.'
  ].join('\n');
}

// The full brief: gather → tool-less claude -p → text for Telegram.
async function ideasBrief(days, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const since = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
  const sections = listDumpSections(rootDir, since);
  if (!sections.length) return { empty: true, days, text: null };
  const text = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildIdeasBriefPrompt(sections, days), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 120000, maxBuffer: 4 << 20 },
      (err, stdout) => err ? reject(err) : resolve(String(stdout || '').trim()));
  });
  if (!text) throw new Error('ideas brief came back empty');
  return { empty: false, days, dumps: sections.length, text };
}

/* ----------------------------- orchestration ---------------------------- */

// Distill via a tool-less claude -p call (same pattern as the other captures).
function distillDump(body, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildDumpPrompt(body), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 120000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(parseDumpDistill(stdout)); } catch (e) { reject(e); }
      });
  });
}

// body → distilled section in today's brain-dump note. Lint-gated like every
// wiki write: the full document is validated before anything lands.
async function recordDump(body, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateStr = localDate(now);
  const timeStr = fmtTime(now);
  const distill = await (opts.distill ? opts.distill(body) : distillDump(body, opts));
  const abs = dumpPath(dateStr, rootDir);
  const exists = fs.existsSync(abs);
  const content = exists
    ? appendDumpSection(fs.readFileSync(abs, 'utf8'), dumpSection({ distill, timeStr }), dateStr)
    : buildDumpNote({ distill, dateStr, timeStr });
  const errs = noteErrors(content);
  if (errs.length) throw new Error(`brain dump failed lint: ${errs.join('; ')}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  // Ideas voiced inside the dump also land in the idea bank — best-effort, a
  // bank hiccup must never lose the journal entry itself.
  let banked = 0;
  if (distill.ideas && distill.ideas.length) {
    try {
      appendToBank(
        distill.ideas.map(text => ({ date: dateStr, text, src: 'brain dump' })),
        { rootDir, date: dateStr }
      );
      banked = distill.ideas.length;
    } catch (err) { console.error('idea bank append failed:', err.message); }
  }
  return { path: path.relative(rootDir, abs), created: !exists, distill, banked };
}

module.exports = {
  parseDump,
  parseIdeasBrief,
  listDumpSections,
  buildIdeasBriefPrompt,
  ideasBrief,
  fmtTime,
  buildDumpPrompt,
  parseDumpDistill,
  dumpPath,
  dumpSection,
  buildDumpNote,
  appendDumpSection,
  recordDump
};
