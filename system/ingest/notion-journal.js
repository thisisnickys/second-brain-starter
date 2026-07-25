'use strict';
// Journal pull — if you journal in NOTION rather than in Telegram, the brain
// has no idea you did it unless something goes and looks. That exact gap is
// why this file exists: journaling that goes uncredited stops feeling worth it.
// This pulls a day's entry into wiki/personal/journal/<date>-journal.md; the
// evening report runs it for TODAY and nudges when no entry exists, the
// nightly ingest runs it for YESTERDAY to catch late-night entries.
// Fail-soft: no token / Notion down / no entry => exit 0, never breaks a run.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { noteErrors } = require('../lib/note-write.js');

const ROOT = path.join(__dirname, '..', '..');
// Your Notion journal database. Set NOTION_JOURNAL_DB in .env (32-char id
// from the database URL). Expected schema: a Date property + a title property
// holding the entry. Unset = this step is skipped, not an error.
let JOURNAL_DB = process.env.NOTION_JOURNAL_DB || '';
const NOTION_VERSION = '2022-06-28'; // matches system/telegram/notion.js

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

function notionApi(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request(
      {
        hostname: 'api.notion.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 30000
      },
      res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(out); } catch (err) { return reject(new Error('bad notion response')); }
          if (res.statusCode >= 400) {
            return reject(new Error(`notion ${res.statusCode}: ${parsed.message || out.slice(0, 200)}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('notion request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ------------------------------- pure ---------------------------------- */

function plain(richText) {
  return (Array.isArray(richText) ? richText : []).map(t => t.plain_text || '').join('');
}

// Notion blocks → markdown-ish plain text. Only the block types that show up
// in a journal page; anything else is skipped.
function extractText(blocks) {
  const lines = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object' || !b.type) continue;
    const v = b[b.type] || {};
    // Audio journal entries: a `transcription` block carries its heading in
    // `title` (content lives in child blocks the recursive fetch pulls in).
    if (b.type === 'transcription') {
      const t = plain(v.title).trim();
      if (t) lines.push(`## ${t}`);
      continue;
    }
    const text = plain(v.rich_text).trim();
    if (!text) continue;
    if (/^heading_[123]$/.test(b.type)) lines.push(`## ${text}`);
    else if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') lines.push(`- ${text}`);
    else if (b.type === 'to_do') lines.push(`- ${text}`);
    else if (b.type === 'quote') lines.push(`> ${text}`);
    else lines.push(text); // paragraph, callout, toggle, …
  }
  return lines.join('\n\n').trim();
}

function buildNote(date, text) {
  return [
    '---',
    `title: Journal ${date}`,
    'department: personal',
    'tags: [journal, three-pages]',
    'behaviors: [breathe, learn]',
    'source: capture:notion-3pages',
    `updated: ${date}`,
    '---',
    '',
    `# Journal — ${date}`,
    '',
    text,
    ''
  ].join('\n');
}

function notePath(date, rootDir) {
  return path.join(rootDir || ROOT, 'wiki', 'personal', 'journal', `${date}-three-pages.md`);
}

/* ----------------------------- orchestration ---------------------------- */

// Find the day's row: primary = Date property equals the date; fallback =
// title (Journal Entries) matching the date string among recent rows.
async function findEntry(token, date) {
  const byDate = await notionApi(token, 'POST', `/v1/databases/${JOURNAL_DB}/query`, {
    filter: { property: 'Date', date: { equals: date } },
    page_size: 1
  });
  if (byDate.results && byDate.results[0]) return byDate.results[0];
  const recent = await notionApi(token, 'POST', `/v1/databases/${JOURNAL_DB}/query`, {
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 10
  });
  for (const r of recent.results || []) {
    const titleProp = Object.values(r.properties || {}).find(p => p && p.type === 'title');
    if (titleProp && plain(titleProp.title).trim() === date) return r;
  }
  return null;
}

// Recursive: audio-journal (transcription) entries nest their real content
// 2-3 levels deep (transcription → summary/notes/transcript wrappers →
// headings/bullets). Depth- and count-capped so a pathological page can't
// spin the pull forever.
async function fetchAllBlocks(token, blockId, depth = 0, budget = { left: 800 }) {
  if (depth > 4 || budget.left <= 0) return [];
  const all = [];
  let cursor = null;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const res = await notionApi(token, 'GET', `/v1/blocks/${blockId}/children${qs}`);
    for (const b of res.results || []) {
      if (budget.left-- <= 0) return all;
      all.push(b);
      if (b.has_children) all.push(...await fetchAllBlocks(token, b.id, depth + 1, budget));
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return all;
}

function parseArgs(argv) {
  const idx = argv.indexOf('--date');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

async function main() {
  // Default = YESTERDAY (same convention as health-ingest: the nightly ingest
  // covers the finished day). The evening report passes --date <today>.
  const y = new Date(); y.setDate(y.getDate() - 1);
  const date = parseArgs(process.argv.slice(2)) || localDate(y);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`notion-journal: invalid --date "${date}" (want YYYY-MM-DD)`);
    process.exit(1);
  }
  const fileEnv = loadEnv();
  JOURNAL_DB = JOURNAL_DB || fileEnv.NOTION_JOURNAL_DB || '';
  if (!JOURNAL_DB) { console.log('notion-journal: skipped (no NOTION_JOURNAL_DB in .env)'); process.exit(0); }
  const token = fileEnv.NOTION_TOKEN || process.env.NOTION_TOKEN;
  if (!token) { console.log('notion-journal: skipped (no NOTION_TOKEN in .env)'); process.exit(0); }

  let entry, text = '';
  try {
    entry = await findEntry(token, date);
    if (entry) text = extractText(await fetchAllBlocks(token, entry.id));
  } catch (err) {
    console.warn(`notion-journal: warn — fetch failed for ${date}: ${err.message}`);
    process.exit(0); // fail-soft
  }

  if (!entry || text.length < 3) {
    // A row with an empty body doesn't count as journaling.
    console.log(`notion-journal: none ${date} — no entry`);
    process.exit(0);
  }

  const note = buildNote(date, text);
  const errs = noteErrors(note);
  if (errs.length) {
    console.error(`notion-journal: note failed lint, not writing: ${errs.join('; ')}`);
    process.exit(1);
  }
  const out = notePath(date);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, note); // overwrite: latest pull wins for the date
  console.log(`notion-journal: ok ${date} — filed ${text.length} chars → ${path.relative(ROOT, out)}`);
}

module.exports = { extractText, buildNote, notePath, plain };
if (require.main === module) {
  main().catch(err => {
    console.error(`notion-journal: error — ${err.message}`);
    process.exit(1);
  });
}
