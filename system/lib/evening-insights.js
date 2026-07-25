'use strict';
// Evening-report insight helpers — pure logic, filesystem in, data out.
//   1. Five Behaviors rollup: which of move/breathe/create/learn/connect got
//      touched today, derived from wiki notes updated today (frontmatter
//      `behaviors:`), tasks completed today (archive `behaviors:` field),
//      today's health note, and any people note touched today (= connect).
//   2. Apply-line resurface: pick ONE learning note captured ~30 days ago and
//      hand back its title + Apply line so the report can ask "did you apply
//      it?". State in system/logs/resurface-state.json prevents repeats.
// Zero npm deps, node built-ins only. Dates are local YYYY-MM-DD strings.

const fs = require('fs');
const path = require('path');

const FIVE_BEHAVIORS = ['move', 'breathe', 'create', 'learn', 'connect'];
const RESURFACE_STATE = ['system', 'logs', 'resurface-state.json'];

/* ------------------------------ five behaviors ------------------------------ */

// `behaviors: [move, breathe]` (or unbracketed csv) from a note's frontmatter.
function behaviorsFromFrontmatter(text) {
  const m = String(text == null ? '' : text).match(/^behaviors:\s*(.+)$/m);
  if (!m) return [];
  return m[1].replace(/[[\]]/g, '').split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => FIVE_BEHAVIORS.includes(s));
}

// `... | behaviors:move,breathe | ...` from a tasks.md/archive line ("none" → []).
function behaviorsFromTaskLine(line) {
  const m = String(line == null ? '' : line).match(/\|\s*behaviors:([^|]*)/);
  if (!m) return [];
  return m[1].split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => FIVE_BEHAVIORS.includes(s));
}

// Which behaviors got touched today. Signals:
//   - archive `- [x] ... done:<today>` lines → their behaviors: field
//   - wiki notes with `updated: <today>` → their frontmatter behaviors
//   - a people note (wiki/personal/people/) updated today → connect
//   - today's health note existing → its behaviors (move/breathe)
// Returns a Set (subset of FIVE_BEHAVIORS).
function behaviorsToday(rootDir, today, archiveMd) {
  const touched = new Set();

  for (const line of String(archiveMd == null ? '' : archiveMd).split('\n')) {
    const m = line.match(/^-\s*\[x\]\s*(.*)$/i);
    if (!m || !m[1].includes(`done:${today}`)) continue;
    for (const b of behaviorsFromTaskLine(m[1])) touched.add(b);
  }

  const peopleDir = path.join('wiki', 'personal', 'people') + path.sep;
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
      for (const b of behaviorsFromFrontmatter(text)) touched.add(b);
      if (path.relative(rootDir, p).startsWith(peopleDir)) touched.add('connect');
    }
  };
  walk(path.join(rootDir, 'wiki'));

  // Health note counted explicitly (normally also caught by the wiki walk).
  try {
    const h = fs.readFileSync(path.join(rootDir, 'wiki', 'personal', 'health', `${today}.md`), 'utf8');
    for (const b of behaviorsFromFrontmatter(h)) touched.add(b);
  } catch (err) { /* no health note today */ }

  return touched;
}

// `Behaviors: move ✓ · breathe ✓ · create ✗ · learn ✓ · connect ✗`
function behaviorsLine(touched) {
  const t = touched instanceof Set ? touched : new Set(touched || []);
  return 'Behaviors: ' + FIVE_BEHAVIORS.map(b => `${b} ${t.has(b) ? '✓' : '✗'}`).join(' · ');
}

// The full rollup the report consumes: { touched, untouched, line }.
function behaviorsRollup(rootDir, today, archiveMd) {
  const t = behaviorsToday(rootDir, today, archiveMd);
  return {
    touched: FIVE_BEHAVIORS.filter(b => t.has(b)),
    untouched: FIVE_BEHAVIORS.filter(b => !t.has(b)),
    line: behaviorsLine(t)
  };
}

/* ---------------------------- apply-line resurface --------------------------- */

// Whole days between two local YYYY-MM-DD strings (a - b).
function daysBetween(a, b) {
  const parse = s => {
    const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
  };
  const ta = parse(a), tb = parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? null : Math.round((ta - tb) / 86400000);
}

// The Apply line/section of a learning note: `**Apply:** …` line, or the first
// paragraph under `## Apply`. Collapsed to one line, capped for report use.
function extractApply(text, maxLen = 300) {
  const s = String(text == null ? '' : text);
  let apply = null;
  const line = s.match(/^\*\*Apply:?\*\*:?\s*(.+)$/m);
  if (line) apply = line[1];
  else {
    const sec = s.split(/^##\s+Apply\s*$/m)[1];
    if (sec) apply = sec.split(/^##\s/m)[0].trim().split(/\n\s*\n/)[0];
  }
  if (!apply) return null;
  apply = apply.replace(/\s+/g, ' ').trim();
  if (!apply) return null;
  if (apply.length > maxLen) apply = apply.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  return apply;
}

// Every wiki/*/learning/*.md note with a title, updated date, and Apply line.
function listLearningNotes(rootDir) {
  const wikiDir = path.join(rootDir, 'wiki');
  const out = [];
  let depts = [];
  try { depts = fs.readdirSync(wikiDir, { withFileTypes: true }); } catch (err) { return out; }
  for (const d of depts) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(wikiDir, d.name, 'learning');
    let files = [];
    try { files = fs.readdirSync(dir); } catch (err) { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const abs = path.join(dir, f);
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch (err) { continue; }
      const title = text.match(/^title:\s*(.+)$/m);
      const updated = text.match(/^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
      if (!updated) continue;
      out.push({
        relPath: path.relative(rootDir, abs),
        title: title ? title[1].trim() : f.replace(/\.md$/, ''),
        updated: updated[1],
        apply: extractApply(text)
      });
    }
  }
  return out;
}

// Pick ONE learning note to resurface: updated 25-35 days ago (widen to 20-45
// if empty), must have an Apply line, never one already resurfaced, closest to
// 30 days wins. Null → skip silently.
function pickResurface(rootDir, today, resurfacedPaths) {
  const done = new Set(resurfacedPaths || []);
  const notes = listLearningNotes(rootDir)
    .map(n => ({ ...n, age: daysBetween(today, n.updated) }))
    .filter(n => n.apply && n.age != null && !done.has(n.relPath));
  const inWindow = (lo, hi) => notes.filter(n => n.age >= lo && n.age <= hi);
  let cands = inWindow(25, 35);
  if (!cands.length) cands = inWindow(20, 45);
  if (!cands.length) return null;
  cands.sort((a, b) => Math.abs(a.age - 30) - Math.abs(b.age - 30) || a.relPath.localeCompare(b.relPath));
  const n = cands[0];
  return { relPath: n.relPath, title: n.title, apply: n.apply, daysAgo: n.age };
}

/* ------------------------------ resurface state ------------------------------ */

function resurfaceStatePath(rootDir) {
  return path.join(rootDir, ...RESURFACE_STATE);
}

// Note paths already resurfaced (string array; [] when absent/corrupt).
function loadResurfaceState(rootDir) {
  try {
    const st = JSON.parse(fs.readFileSync(resurfaceStatePath(rootDir), 'utf8'));
    return Array.isArray(st.resurfaced) ? st.resurfaced.filter(p => typeof p === 'string') : [];
  } catch (err) { return []; }
}

function markResurfaced(rootDir, relPath) {
  const p = resurfaceStatePath(rootDir);
  const seen = loadResurfaceState(rootDir);
  if (!seen.includes(relPath)) seen.push(relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ resurfaced: seen }, null, 2) + '\n');
}

module.exports = {
  FIVE_BEHAVIORS,
  behaviorsFromFrontmatter, behaviorsFromTaskLine, behaviorsToday, behaviorsLine, behaviorsRollup,
  daysBetween, extractApply, listLearningNotes, pickResurface,
  loadResurfaceState, markResurfaced
};
