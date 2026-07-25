'use strict';
const { DEPARTMENTS } = require('../lib/config.js');
// Spark ledger — the Night Shift's memory of what it said (and, from Phase 4,
// what hit). JSONL, append-only, one line per spark.
const fs = require('fs');
const path = require('path');

function countForDate(ledgerPath, date) {
  let text = '';
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch (err) { return 0; }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line).date === date) n += 1; } catch (err) { /* skip */ }
  }
  return n;
}

function appendSparks(ledgerPath, date, sparks) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const offset = countForDate(ledgerPath, date);
  const entries = (sparks || []).map((s, i) => ({
    date, id: `${date}-${offset + i + 1}`,
    department: s.department, title: s.title, text: s.text, sources: s.sources,
    reaction: null, followthrough: null
  }));
  if (entries.length) fs.appendFileSync(ledgerPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return entries;
}

// Stamp Telegram messageIds onto today's entries after delivery (Phase 3) —
// the id→messageId link is what lets Phase 4 match reactions back to sparks.
// Rewrites matching lines in place; every other line passes through untouched.
function markSent(ledgerPath, date, idToMessageId) {
  let text = '';
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch (err) { return 0; }
  let n = 0;
  const lines = text.split('\n').map(line => {
    if (!line.trim()) return line;
    let e = null;
    try { e = JSON.parse(line); } catch (err) { return line; }
    if (e && e.date === date && idToMessageId && idToMessageId[e.id] != null) {
      e.messageId = idToMessageId[e.id];
      n += 1;
      return JSON.stringify(e);
    }
    return line;
  });
  if (n) fs.writeFileSync(ledgerPath, lines.join('\n'));
  return n;
}

// Phase 4: a Telegram reaction on a delivered spark → stamped onto its
// ledger row. Matches by messageId; returns the updated entry or null when
// the reacted message isn't a spark. Same rewrite-in-place style as markSent.
function recordReaction(ledgerPath, messageId, emoji) {
  let text = '';
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch (err) { return null; }
  let hit = null;
  const lines = text.split('\n').map(line => {
    if (!line.trim()) return line;
    let e = null;
    try { e = JSON.parse(line); } catch (err) { return line; }
    if (e && e.messageId === messageId) {
      e.reaction = String(emoji == null ? '' : emoji);
      hit = e;
      return JSON.stringify(e);
    }
    return line;
  });
  if (hit) fs.writeFileSync(ledgerPath, lines.join('\n'));
  return hit;
}

// Phase 4: a spark the owner reacted 🔥 to graduates from the ledger into the
// wiki — a real note in wiki/<dept>/sparks/ the graph and brain can see.
// Lint-gated; returns the relative path (or the existing one on re-react).
function promoteSpark(entry, rootDir) {
  const { noteErrors } = require('../lib/note-write.js');
  const dept = DEPARTMENTS.includes(entry.department)
    ? entry.department : 'content';
  const slug = String(entry.title || 'spark').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 8).join('-') || 'spark';
  const rel = path.join('wiki', dept, 'sparks', `${entry.date}-${slug}.md`);
  const abs = path.join(rootDir, rel);
  if (fs.existsSync(abs)) return rel;
  const note = [
    '---',
    `title: Spark — ${String(entry.title || 'untitled').replace(/[\r\n]+/g, ' ')}`,
    `department: ${dept}`,
    'tags: [spark, nightshift]',
    'behaviors: [create]',
    'source: nightshift-spark',
    `updated: ${entry.date}`,
    '---',
    '',
    `# ${entry.title || 'Spark'}`,
    '',
    String(entry.text || '').trim(),
    '',
    ...(Array.isArray(entry.sources) && entry.sources.length
      ? ['## Sources', '', ...entry.sources.map(s => `- ${s}`), '']
      : [])
  ].join('\n');
  const errs = noteErrors(note);
  if (errs.length) throw new Error(`spark promotion failed lint: ${errs.join('; ')}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, note);
  return rel;
}

function daysAgo(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '0000-00-00';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readRecent(ledgerPath, days, today) {
  let text = '';
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch (err) { return []; }
  const cutoff = daysAgo(today, days);
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e = null;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e && typeof e.date === 'string' && e.date >= cutoff) out.push(e);
  }
  return out;
}

module.exports = { appendSparks, markSent, readRecent, recordReaction, promoteSpark };
