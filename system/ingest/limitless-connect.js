'use strict';
// Limitless connect pass (Path A — docs/specs/2026-07-08-limitless-connect.md).
// Detects who the owner actually talked to on a given day from her Limitless
// pendant lifelogs and writes a lint-clean connections note tagged
// behaviors: [connect], so CONNECT gets credited in the evening rollup
// without manual capture. No people detected => no note (that IS the signal).
//
// GATED to known people (Jul 22 2026 audit): ungated, this logged consumed
// media as relationships — a sermon, Marques Brownlee from a video — because
// any named lifelog speaker counted. Now a speaker only counts if they match
// a person page in wiki/personal/people/ (created via the bot's `person:`
// route or the nightly connect-question answer). Zero person pages = pass
// skipped entirely; the evening "Who did you connect with?" question is the
// primary connect signal.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { OWNER } = require('../lib/config.js');
const OWNER_NAME = String(OWNER.name || '').trim().toLowerCase();
const { noteErrors } = require('../lib/note-write.js');

const ROOT = path.join(__dirname, '..', '..');
const API_BASE = 'https://api.limitless.ai/v1/lifelogs';
const TIMEZONE = 'America/New_York';
const CONTEXT_MAX = 100;
const MIN_CONTEXT_LEN = 3; // segments shorter than this are "trivial" (e.g. "Ok")

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// Is this speaker the owner herself, or an unnamed/unidentified speaker?
function isExcludedSpeaker(name, identifier) {
  if (identifier === 'user') return true;
  const n = String(name == null ? '' : name).trim();
  if (!n) return true;
  const lower = n.toLowerCase();
  // The owner's own name never counts as "someone I connected with".
  if (lower === OWNER_NAME || lower === 'you' || lower === 'unknown') return true;
  if (/^speaker \d+$/i.test(n)) return true;
  return false;
}

// Collapse a segment's text onto one clean line (strip newlines/pipes), truncated.
function cleanContext(text) {
  const oneLine = String(text == null ? '' : text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= CONTEXT_MAX) return oneLine;
  return oneLine.slice(0, CONTEXT_MAX).trimEnd() + '…';
}

// Walk a lifelog's contents[] tree yielding every node (children included).
function* walkNodes(nodes) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    yield node;
    if (Array.isArray(node.children)) yield* walkNodes(node.children);
  }
}

// Names of the owner's actual people, from wiki/personal/people/ page titles.
// Returns a lowercase Set holding each full title AND its first token, so a
// A "Jordan Reyes" page matches lifelog speaker "Jordan". Empty set = no pages.
function loadKnownPeople(rootDir) {
  const dir = path.join(rootDir || ROOT, 'wiki', 'personal', 'people');
  const known = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (err) { return known; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { continue; }
    const m = text.match(/^title:\s*(.+)$/m);
    if (!m) continue;
    const full = m[1].trim().toLowerCase();
    if (!full) continue;
    known.add(full);
    known.add(full.split(/\s+/)[0]);
  }
  return known;
}

// Extract conversation partners from an array of lifelogs.
// Returns [{ name, context }] — deduped case-insensitively (first-seen casing
// wins), the owner/"You"/unnamed speakers excluded, context = first non-trivial
// thing that person said (single line, ~100 chars). When `known` (a lowercase
// Set) is given, speakers not in it are dropped — media voices don't count.
function extractPeople(lifelogs, known) {
  const byKey = new Map(); // lowercased name -> { name, context }
  for (const log of Array.isArray(lifelogs) ? lifelogs : []) {
    if (!log || typeof log !== 'object') continue;
    for (const node of walkNodes(log.contents)) {
      if (node.type !== 'blockquote') continue;
      const name = node.speakerName;
      if (isExcludedSpeaker(name, node.speakerIdentifier)) continue;
      if (known instanceof Set && !known.has(String(name).trim().toLowerCase())) continue;
      const trimmed = String(name).trim();
      const key = trimmed.toLowerCase();
      let entry = byKey.get(key);
      if (!entry) {
        entry = { name: trimmed, context: '' };
        byKey.set(key, entry);
      }
      if (!entry.context) {
        const ctx = cleanContext(node.content);
        if (ctx.length >= MIN_CONTEXT_LEN) entry.context = ctx;
      }
    }
  }
  return [...byKey.values()];
}

// Build the connections note markdown for a date + people list.
function buildNote(date, people) {
  const lines = [
    '---',
    `title: Connections ${date}`,
    'department: personal',
    'tags: [connections, people]',
    'behaviors: [connect]',
    'source: capture:limitless-auto',
    `updated: ${date}`,
    '---',
    '',
    `# Connections ${date}`,
    '',
  ];
  for (const p of people) {
    lines.push(p.context ? `- ${p.name} — ${p.context}` : `- ${p.name}`);
  }
  return lines.join('\n') + '\n';
}

// Fetch all lifelogs for a date, paginating via cursor. Never logs the key.
async function fetchLifelogs(date, apiKey) {
  const all = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({
      date,
      timezone: TIMEZONE,
      includeMarkdown: 'false',
      includeHeadings: 'false',
      limit: '10',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${API_BASE}?${params}`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!res.ok) throw new Error(`limitless API ${res.status} ${res.statusText}`);
    const json = await res.json();
    const batch =
      (json && json.data && Array.isArray(json.data.lifelogs) && json.data.lifelogs) ||
      (json && Array.isArray(json.lifelogs) && json.lifelogs) ||
      [];
    all.push(...batch);
    cursor =
      (json && json.meta && json.meta.lifelogs && json.meta.lifelogs.nextCursor) || null;
    if (!batch.length) cursor = null; // safety: never loop on an empty page
  } while (cursor);
  return all;
}

function parseArgs(argv) {
  const idx = argv.indexOf('--date');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

async function main() {
  const date = parseArgs(process.argv.slice(2)) || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`limitless-connect: invalid --date "${date}" (want YYYY-MM-DD)`);
    process.exit(1);
  }

  const apiKey = loadEnv().LIMITLESS_API_KEY || process.env.LIMITLESS_API_KEY;
  if (!apiKey) {
    console.log('limitless-connect: skipped (no LIMITLESS_API_KEY in .env)');
    process.exit(0);
  }

  const known = loadKnownPeople(ROOT);
  if (!known.size) {
    console.log('limitless-connect: gated — no person pages in wiki/personal/people yet, so no auto-connections (the evening connect question is the signal; add people via the bot "person:" route)');
    process.exit(0);
  }

  let lifelogs;
  try {
    lifelogs = await fetchLifelogs(date, apiKey);
  } catch (err) {
    // Fail-soft: API down / network trouble must never break the ingest.
    console.warn(`limitless-connect: warn — fetch failed for ${date}: ${err.message}`);
    process.exit(0);
  }

  const people = extractPeople(lifelogs, known);
  if (!people.length) {
    console.log(
      `limitless-connect: no conversation partners detected for ${date} (${lifelogs.length} lifelogs) — no note written`
    );
    process.exit(0);
  }

  const note = buildNote(date, people);
  const errs = noteErrors(note);
  if (errs.length) {
    // Should never happen (builder is lint-clean by construction) — but never
    // land an invalid page in wiki/.
    console.error(`limitless-connect: note failed lint, not writing: ${errs.join('; ')}`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'wiki', 'personal', 'journal');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}-connections.md`);
  fs.writeFileSync(outPath, note); // overwrite: latest detection wins for the date
  console.log(
    `limitless-connect: ok ${date} — ${people.length} ${people.length === 1 ? 'person' : 'people'} (${people.map(p => p.name).join(', ')}) → ${path.relative(ROOT, outPath)}`
  );
}

module.exports = { extractPeople, buildNote, cleanContext, isExcludedSpeaker, loadKnownPeople };
if (require.main === module) {
  main().catch(err => {
    console.error(`limitless-connect: error — ${err.message}`);
    process.exit(1);
  });
}
