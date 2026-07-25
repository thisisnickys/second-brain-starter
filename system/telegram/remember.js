'use strict';
// "remember: ..." → a real, lint-checked wiki note (not just an inbox line).
// One tool-less claude -p call classifies + titles the fact; the note write
// goes through the shared lint gate. If Claude is unreachable the caller
// falls back to a plain inbox capture so nothing is ever lost.
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { writeNote } = require('../lib/note-write.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const { DEPARTMENTS, OWNER, departmentMenu, ownerLine } = require('../lib/config.js');

function buildRememberPrompt(text) {
  return [
    'the owner told her second brain to remember something. Turn it into a small knowledge-base note.',
    '',
    'She said:',
    '"""',
    String(text == null ? '' : text),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{',
    '  "title": short descriptive title for the fact,',
    `  "department": one of ${DEPARTMENTS.join(' | ')} (${departmentMenu()}),`,
    '  "tags": 2-5 lowercase kebab-case topic tags,',
    '  "note_md": the fact restated cleanly in markdown (a sentence or short bullets — keep every concrete detail she gave: names, numbers, dates, links)',
    '}'
  ].join('\n');
}

function parseRemember(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('remember: no JSON in output');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!obj.title || !obj.note_md) throw new Error('remember: missing title/note_md');
  if (!DEPARTMENTS.includes(obj.department)) obj.department = 'personal';
  if (!Array.isArray(obj.tags)) obj.tags = [];
  obj.tags = obj.tags.map(t => slugify(t)).filter(Boolean).slice(0, 5);
  return obj;
}

function buildRememberNote({ parsed, original, dateStr }) {
  const tags = parsed.tags.length ? parsed.tags.join(', ') : 'remembered';
  return [
    '---',
    `title: ${parsed.title}`,
    `department: ${parsed.department}`,
    `tags: [${tags}]`,
    'behaviors: [learn]',
    'source: telegram:remember',
    `updated: ${dateStr}`,
    '---',
    '',
    `# ${parsed.title}`,
    '',
    parsed.note_md.trim(),
    '',
    `> Told to the brain verbatim (${dateStr}): "${String(original).trim()}"`,
    ''
  ].join('\n');
}

function classifyRemember(text, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildRememberPrompt(text), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 120000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(parseRemember(stdout)); } catch (e) { reject(e); }
      });
  });
}

// text → written wiki note. Returns { path, title, department }.
async function rememberFact(text) {
  const dateStr = localDate();
  const parsed = await classifyRemember(text);
  const abs = writeNote(
    path.join(ROOT_DIR, 'wiki', parsed.department, 'remembered', `${dateStr}-${slugify(parsed.title)}.md`),
    buildRememberNote({ parsed, original: text, dateStr })
  );
  return { path: path.relative(ROOT_DIR, abs), title: parsed.title, department: parsed.department };
}

module.exports = { buildRememberPrompt, parseRemember, buildRememberNote, classifyRemember, rememberFact };
