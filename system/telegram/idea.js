'use strict';
// Idea bank — "I have an idea …" (voice or text) banks the idea as a dated
// bullet in wiki/content/ideas/idea-bank.md, one growing page (the galaxy
// gets one Idea Bank node, not a dot per idea). Two ways in: the explicit
// trigger here, and brain dumps (dump.js distills ideas out of every dump and
// appends them via appendToBank). "idea bank" lists recent entries; the
// existing "idea brief" roundup is unchanged and still reads the dumps.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { noteErrors } = require('../lib/note-write.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

/* ------------------------------- pure ---------------------------------- */

// Same spoken-preamble tolerance as intent.js — Whisper keeps the filler.
const FILLER_RE = /^(?:(?:okay|ok|alright|all right|oh|um+|uh+|so|hey|yo|hi|well|and|like)[,.!\s]+)+/i;

// Explicit idea triggers, anchored to the start (after filler) so a passing
// "…I had an idea earlier…" inside planning talk doesn't hijack the message.
// "add to the idea bank …" is checked before the brief/bank guard below —
// it's the one capture phrasing that legitimately contains "idea bank".
const ADD_TO_BANK_RE = /^add\s+to\s+(?:the\s+|my\s+)?idea\s+bank\b/i;
const IDEA_PATTERNS = [
  /^i(?:'ve|\s+have)\s+(?:got\s+)?an\s+idea\b/i,
  /^(?:i\s+)?got\s+an\s+idea\b/i,
  /^here'?s\s+an\s+idea\b/i,
  /^new\s+idea\b/i,
  /^idea[:\s]/i
];

// "I have an idea <stuff>" → "<stuff>" ('' for a bare trigger); null when the
// message isn't an idea capture. "idea brief"/"idea bank" are never captures.
function parseIdea(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return null;
  t = t.replace(FILLER_RE, '');
  const add = ADD_TO_BANK_RE.exec(t);
  if (add) return t.slice(add[0].length).replace(/^[\s,.:;!?—–-]+/, '').trim();
  if (/\bideas?\s*(?:brief|bank)\b/i.test(t)) return null;
  for (const re of IDEA_PATTERNS) {
    const m = re.exec(t);
    if (m) return t.slice(m[0].length).replace(/^[\s,.:;!?—–-]+/, '').trim();
  }
  return null;
}

function bankPath(rootDir) {
  return path.join(rootDir || ROOT_DIR, 'wiki', 'content', 'ideas', 'idea-bank.md');
}

// entry = { date: 'YYYY-MM-DD', text: '…', src: 'voice'|'text'|'brain dump' }
function ideaBullet(entry) {
  return `- **${entry.date}** — ${entry.text} _(${entry.src})_`;
}

function buildBankNote(entries, dateStr) {
  return [
    '---',
    'title: Idea Bank',
    'department: content',
    'tags: [ideas, idea-bank]',
    'behaviors: [create]',
    'source: telegram',
    `updated: ${dateStr}`,
    '---',
    '',
    '# Idea Bank',
    '',
    ...entries.map(ideaBullet),
    ''
  ].join('\n');
}

// Later ideas append below the existing bullets; `updated:` moves with them.
function appendIdeaEntries(content, entries, dateStr) {
  let s = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  s = s.replace(/^updated:.*$/m, `updated: ${dateStr}`);
  return `${s.replace(/\s+$/, '')}\n${entries.map(ideaBullet).join('\n')}\n`;
}

// Recent bank bullets, newest first. [] when the bank doesn't exist yet.
function listBank(rootDir, limit) {
  let raw;
  try { raw = fs.readFileSync(bankPath(rootDir), 'utf8'); } catch (err) { return []; }
  const bullets = raw.split('\n').filter(l => l.startsWith('- '));
  return bullets.slice(-(limit || 15)).reverse();
}

/* ----------------------------- orchestration ---------------------------- */

function buildIdeaPrompt(body) {
  return [
    'the owner just voiced an IDEA they want saved in their idea bank. Distill the spoken rambling',
    'into the idea itself — keep names, tools, numbers, and the mechanism; drop the filler.',
    '',
    'Raw idea:',
    '"""',
    String(body == null ? '' : body),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence): {"idea": "the idea in 1-2 crisp sentences"}'
  ].join('\n');
}

function parseIdeaDistill(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('idea distill: no JSON in output');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!obj.idea || !String(obj.idea).trim()) throw new Error('idea distill: missing idea');
  return String(obj.idea).trim();
}

function distillIdea(body, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildIdeaPrompt(body), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 120000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(parseIdeaDistill(stdout)); } catch (e) { reject(e); }
      });
  });
}

// Append entries to the bank (creating it on first use). Lint-gated like every
// wiki write. Returns the bank's relative path.
function appendToBank(entries, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const dateStr = opts.date || localDate();
  const abs = bankPath(rootDir);
  const exists = fs.existsSync(abs);
  const content = exists
    ? appendIdeaEntries(fs.readFileSync(abs, 'utf8'), entries, dateStr)
    : buildBankNote(entries, dateStr);
  const errs = noteErrors(content);
  if (errs.length) throw new Error(`idea bank failed lint: ${errs.join('; ')}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return path.relative(rootDir, abs);
}

// body → distilled idea → banked. Distill failure falls back to the raw text
// (an un-cleaned idea in the bank beats a lost one).
async function recordIdea(body, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateStr = localDate(now);
  let text;
  try { text = await (opts.distill ? opts.distill(body) : distillIdea(body, opts)); }
  catch (err) { text = String(body).trim(); }
  const entry = { date: dateStr, text, src: opts.src || 'text' };
  const rel = appendToBank([entry], { rootDir, date: dateStr });
  return { path: rel, entry };
}

module.exports = {
  parseIdea,
  bankPath,
  ideaBullet,
  buildBankNote,
  appendIdeaEntries,
  listBank,
  buildIdeaPrompt,
  parseIdeaDistill,
  appendToBank,
  recordIdea
};
