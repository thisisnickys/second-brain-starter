'use strict';
// "person: <Name> — <note>" / "note about <Name>: <note>" → a lint-gated
// person page at wiki/personal/people/<slug>.md. First mention creates the
// file; later mentions append a dated bullet under ## Notes and bump the
// `updated:` frontmatter. All writes are validated BEFORE they land (same
// lint the workbench save and lint-frontmatter.js enforce), so an invalid
// note never touches wiki/ — the bot falls back to an inbox capture instead.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { noteErrors } = require('../lib/note-write.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

// Pure routing/parse. Accepts:
//   person: <Name> — <note>     (also '–', ' - ', or ':' as the separator)
//   note about <Name>: <note>
// Returns { name, note } or null when the message isn't a person capture.
function parsePerson(text) {
  const t = String(text == null ? '' : text).trim();
  let rest = null;
  let m = t.match(/^person\s*:\s*(.+)$/is);
  if (m) rest = m[1].trim();
  else {
    m = t.match(/^note about\s+(.+)$/is);
    if (m) rest = m[1].trim();
  }
  if (!rest) return null;

  // Earliest separator wins so a note containing ':' later on still splits
  // at the real name boundary ("John - note: call him" → name "John").
  const seps = ['—', '–', ' - ', ':'];
  let at = -1;
  let sep = null;
  for (const s of seps) {
    const i = rest.indexOf(s);
    if (i > 0 && (at === -1 || i < at)) { at = i; sep = s; }
  }
  if (at === -1) return null;
  const name = rest.slice(0, at).trim();
  const note = rest.slice(at + sep.length).trim();
  if (!name || !note) return null;
  return { name, note };
}

function personPath(name, rootDir) {
  return path.join(rootDir || ROOT_DIR, 'wiki', 'personal', 'people', `${slugify(name)}.md`);
}

// New person page. Body starts with ## Notes; the triggering note is its
// first dated bullet.
function buildPersonNote(name, note, dateStr) {
  return [
    '---',
    `title: ${String(name).trim()}`,
    'department: personal',
    'type: person',
    'behaviors: [connect]',
    'tags: [people]',
    'source: telegram',
    `updated: ${dateStr}`,
    '---',
    '',
    `# ${String(name).trim()}`,
    '',
    '## Notes',
    '',
    `- ${dateStr} — ${String(note).trim()}`,
    ''
  ].join('\n');
}

// Pure append: bump `updated:` and add a dated bullet at the end of the
// ## Notes section (creating the section if a hand-edited page lost it).
function appendPersonNote(content, note, dateStr) {
  let s = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  s = s.replace(/^updated:.*$/m, `updated: ${dateStr}`);
  const bullet = `- ${dateStr} — ${String(note).trim()}`;

  const heading = s.match(/^##\s+Notes\s*$/m);
  if (!heading) {
    return `${s.replace(/\s+$/, '')}\n\n## Notes\n\n${bullet}\n`;
  }
  const afterHeading = heading.index + heading[0].length;
  const rest = s.slice(afterHeading);
  const nextHeading = rest.match(/\n##\s+/);
  const insertAt = nextHeading ? afterHeading + nextHeading.index : s.length;
  const before = s.slice(0, insertAt).replace(/\s+$/, '');
  const after = s.slice(insertAt);
  return `${before}\n${bullet}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

// name + note → created or appended person page. Lint-gated: the full new
// document is validated before anything is written, so failure never leaves
// a broken page behind. Returns { path (relative), created, name }.
function upsertPerson(name, note, opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const dateStr = opts.date || localDate();
  const abs = personPath(name, rootDir);
  const exists = fs.existsSync(abs);
  const content = exists
    ? appendPersonNote(fs.readFileSync(abs, 'utf8'), note, dateStr)
    : buildPersonNote(name, note, dateStr);
  const errs = noteErrors(content);
  if (errs.length) throw new Error(`person note failed lint: ${errs.join('; ')}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: path.relative(rootDir, abs), created: !exists, name: String(name).trim() };
}

module.exports = { parsePerson, personPath, buildPersonNote, appendPersonNote, upsertPerson };
