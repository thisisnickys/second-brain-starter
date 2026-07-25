'use strict';
// Last-capture pointer + the skill-request queue.
//
// The pointer lets a follow-up message resolve "that" ("turn THAT into a
// skill") to the note the bot just filed. The queue turns those requests into
// files under skill-requests/ that the next real Claude session builds and
// tests — the bot itself never authors skills (its claude is read-scoped).

const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const LAST_CAPTURE_PATH = path.join(ROOT_DIR, 'system', 'logs', 'last-capture.json');
const REQUEST_DIR = path.join(ROOT_DIR, 'skill-requests');

// Persisted (not in-memory) because launchd restarts the bot freely — the
// capture→"skill this" pair must survive a restart in between.
function recordLastCapture(info, opts = {}) {
  const filePath = opts.filePath || LAST_CAPTURE_PATH;
  const entry = {
    kind: info.kind || 'capture',
    title: info.title || '',
    wikiPath: info.wikiPath || '',
    transcriptPath: info.transcriptPath || '',
    url: info.url || '',
    at: opts.dateStr || localDate()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n');
  return entry;
}

function loadLastCapture(opts = {}) {
  const filePath = opts.filePath || LAST_CAPTURE_PATH;
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    return null;
  }
}

// Write one pending request file. `capture` may be null (verbatim-only ask).
// Never overwrites: same-day requests get -2, -3… suffixes.
function queueSkillRequest(requestText, capture, opts = {}) {
  const dir = opts.dir || REQUEST_DIR;
  const dateStr = opts.dateStr || localDate();
  const systemAsk = opts.kind === 'system-ask';
  const ask = String(requestText == null ? '' : requestText).trim();
  const base = slugify((capture && capture.title) || ask).split('-').slice(0, 8).join('-') || 'skill-request';

  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${dateStr}-${base}.md`);
  for (let n = 2; fs.existsSync(file); n += 1) {
    file = path.join(dir, `${dateStr}-${base}-${n}.md`);
  }

  const lines = [
    '---',
    'status: pending',
    `requested: ${dateStr}`,
    `kind: ${systemAsk ? 'system-ask' : 'skill'}`,
    `capture: ${(capture && capture.wikiPath) || 'none'}`,
    '---',
    '',
    `# ${systemAsk ? 'System ask' : 'Skill request'} — ${(capture && capture.title) || ask.slice(0, 80)}`,
    '',
    `**Ask (verbatim):** ${ask}`,
    `**Source:** ${opts.source || 'telegram'}`,
    ''
  ];
  if (capture) {
    lines.push(
      '**Source capture:**',
      `- Title: ${capture.title || 'unknown'}`,
      `- Note: ${capture.wikiPath || 'unknown'}`,
      `- Transcript: ${capture.transcriptPath || 'none'}`,
      `- URL: ${capture.url || 'none'}`,
      ''
    );
  }
  lines.push(
    ...(systemAsk
      ? ['This is a feature/fix request for the SECOND BRAIN ITSELF, mined from a',
         'journal or reflection. Implement it with the /second-brain skill loaded,',
         'test it, then flip `status:` above to `done` and note what shipped.']
      : ['Build this as a real Claude skill (skill-creator flow), test it, then flip',
         '`status:` above to `done` and note where the skill was installed.']),
    ''
  );
  fs.writeFileSync(file, lines.join('\n'));
  return { path: file };
}

// Duplicate guard for mined asks: the same journal complaint can show up in a
// reflection AND the next day's journal. Compares meaningful slug tokens of
// the ask against every existing request filename (any status) — ≥3 shared
// tokens (or every token of a short ask) = already queued.
function hasSimilarRequest(ask, opts = {}) {
  const dir = opts.dir || REQUEST_DIR;
  const tokens = slugify(String(ask == null ? '' : ask)).split('-').filter(t => t.length >= 4);
  if (!tokens.length) return false;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (err) { return false; }
  const need = Math.min(3, tokens.length);
  for (const f of files) {
    const have = new Set(f.replace(/\.md$/, '').split('-').filter(t => t.length >= 4));
    const shared = tokens.filter(t => have.has(t)).length;
    if (shared >= need) return true;
  }
  return false;
}

// Pending requests, oldest first — for sessions ("build my skill requests").
function listPendingRequests(opts = {}) {
  const dir = opts.dir || REQUEST_DIR;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch (err) { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (/^status:\s*pending\s*$/m.test(fs.readFileSync(p, 'utf8'))) out.push(p);
    } catch (err) { /* unreadable: skip */ }
  }
  return out;
}

module.exports = { recordLastCapture, loadLastCapture, queueSkillRequest, hasSimilarRequest, listPendingRequests, REQUEST_DIR };
