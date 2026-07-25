'use strict';
// Nightly snapshot of the agent fleet's research output (Notion "Research &
// Scouting Reports" DB) into ONE rolling weekly wiki note under
// wiki/content/research/<YYYY>-W<ww>.md. Deterministic, zero-dep, fail-soft:
// any Notion problem warns and exits 0 so the ingest pipeline never breaks.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { noteErrors } = require('../lib/note-write.js');

const ROOT = path.join(__dirname, '..', '..');
// Your own Notion database of research/scouting rows. Set NOTION_RESEARCH_DB
// in .env (32-char id from the database URL). Unset = this step is skipped.
let RESEARCH_DB_ID = process.env.NOTION_RESEARCH_DB || '';
const NOTION_VERSION = '2022-06-28';

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

// --- ISO week (local time, never toISOString) --------------------------------
// Returns { year, week } using ISO-8601 week numbering (weeks start Monday,
// week 1 contains the first Thursday). year is the ISO week-year, which can
// differ from the calendar year around Jan 1 / Dec 31.
function isoWeek(d) {
  d = d || new Date();
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setDate(date.getDate() - day + 3); // Thursday of this ISO week
  const week1 = new Date(date.getFullYear(), 0, 4); // Jan 4 is always in week 1
  const week1Day = (week1.getDay() + 6) % 7;
  const week = 1 + Math.round(((date - week1) / 86400000 - 3 + week1Day) / 7);
  return { year: date.getFullYear(), week };
}

function weekSlug(d) {
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// --- Notion row extraction ----------------------------------------------------
function plainText(arr) {
  return (arr || []).map(t => t.plain_text || '').join('');
}

// Pull { title, pillar, score, url, created } out of a raw Notion page object.
function extractRow(page) {
  const props = (page && page.properties) || {};
  let title = '', pillar = '', score = null, url = '';
  for (const [name, p] of Object.entries(props)) {
    if (!p || !p.type) continue;
    if (p.type === 'title') {
      title = plainText(p.title);
    } else if (/pillar|category/i.test(name) && !pillar) {
      if (p.type === 'select' && p.select) pillar = p.select.name || '';
      else if (p.type === 'multi_select' && p.multi_select && p.multi_select.length)
        pillar = p.multi_select.map(s => s.name).join(', ');
      else if (p.type === 'rich_text') pillar = plainText(p.rich_text);
    } else if (/score/i.test(name) && score === null) {
      if (p.type === 'number' && typeof p.number === 'number') score = p.number;
      else if (p.type === 'select' && p.select) score = p.select.name || null;
    } else if (p.type === 'url' && p.url && !url) {
      url = p.url;
    }
  }
  const created = String((page && page.created_time) || '').slice(0, 10);
  return {
    id: (page && page.id) || '',
    title: title.replace(/\s+/g, ' ').trim() || '(untitled)',
    pillar: pillar.trim(),
    score,
    url,
    created,
    excerpt: '',
  };
}

// --- Note building --------------------------------------------------------------
// rows -> full markdown note (frontmatter + grouped body). Returns null when
// there are no rows (no empty notes).
function buildNote(rows, opts) {
  if (!rows || !rows.length) return null;
  const slug = opts.slug;
  const today = opts.today;
  const groups = new Map();
  for (const r of rows) {
    const key = r.pillar || 'Uncategorized';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const lines = [
    '---',
    `title: Research Intel ${slug}`,
    'department: content',
    'tags: [research, intel]',
    'behaviors: [learn]',
    'source: capture:research-snapshot',
    `updated: ${today}`,
    '---',
    '',
    `Rolling snapshot of agent-fleet research (Research & Scouting Reports) for ISO week ${slug}. Regenerated nightly by system/ingest/research-snapshot.js.`,
    '',
  ];
  const keys = [...groups.keys()].sort((a, b) =>
    a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));
  for (const key of keys) {
    lines.push(`## ${key}`, '');
    for (const r of groups.get(key)) {
      const score = r.score !== null && r.score !== undefined && r.score !== ''
        ? ` (score ${r.score})` : '';
      const url = r.url ? ` ${r.url}` : '';
      lines.push(`- ${r.created} — ${r.title}${score}${url}`);
      if (r.excerpt) lines.push(`  ${r.excerpt}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- Notion fetch ----------------------------------------------------------------
async function notionFetch(url, token, init) {
  const res = await fetch(url, Object.assign({}, init, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  }));
  if (!res.ok) throw new Error(`notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function queryRecentRows(token, days) {
  const since = localDate(new Date(Date.now() - days * 86400000));
  let rows = [], cursor;
  do {
    const body = {
      page_size: 100,
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    };
    if (cursor) body.start_cursor = cursor;
    const json = await notionFetch(
      `https://api.notion.com/v1/databases/${RESEARCH_DB_ID}/query`, token,
      { method: 'POST', body: JSON.stringify(body) });
    rows = rows.concat((json.results || []).map(extractRow));
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return rows;
}

// First ~10 blocks -> one short excerpt line. Fail-soft: any error => ''.
async function fetchExcerpt(pageId, token) {
  try {
    const json = await notionFetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=10`, token, {});
    const parts = [];
    for (const b of json.results || []) {
      const inner = b[b.type];
      if (inner && Array.isArray(inner.rich_text)) {
        const t = plainText(inner.rich_text).replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      if (parts.join(' ').length > 300) break;
    }
    let excerpt = parts.join(' ').trim();
    if (excerpt.length > 300) excerpt = excerpt.slice(0, 297).trimEnd() + '...';
    return excerpt;
  } catch (err) {
    return '';
  }
}

// --- Main ------------------------------------------------------------------------
async function main() {
  let days = 7;
  const di = process.argv.indexOf('--days');
  if (di !== -1) {
    const n = parseInt(process.argv[di + 1], 10);
    if (Number.isFinite(n) && n > 0) days = n;
  }

  const fileEnv = loadEnv();
  RESEARCH_DB_ID = RESEARCH_DB_ID || fileEnv.NOTION_RESEARCH_DB || '';
  if (!RESEARCH_DB_ID) {
    console.log('research-snapshot: skipped (no NOTION_RESEARCH_DB in .env)');
    process.exit(0);
  }
  const token = fileEnv.NOTION_TOKEN || process.env.NOTION_TOKEN;
  if (!token) {
    console.error('research-snapshot: WARN no NOTION_TOKEN — skipping');
    process.exit(0);
  }

  let rows;
  try {
    rows = await queryRecentRows(token, days);
  } catch (err) {
    console.error(`research-snapshot: WARN notion query failed — ${err.message}`);
    process.exit(0);
  }

  if (!rows.length) {
    console.log(`research-snapshot: no rows edited in last ${days} day(s) — nothing to write`);
    process.exit(0);
  }

  for (const r of rows) r.excerpt = await fetchExcerpt(r.id, token);

  const now = new Date();
  const slug = weekSlug(now);
  const note = buildNote(rows, { slug, today: localDate(now) });
  const errs = noteErrors(note);
  if (errs.length) {
    console.error(`research-snapshot: WARN built note failed lint — ${errs.join('; ')}`);
    process.exit(0);
  }
  const dir = path.join(ROOT, 'wiki', 'content', 'research');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(outPath, note); // rolling weekly surface — overwrite is intended
  console.log(`research-snapshot: ${rows.length} row(s) -> ${path.relative(ROOT, outPath)}`);
  process.exit(0);
}

module.exports = { isoWeek, weekSlug, extractRow, buildNote };
if (require.main === module) main();
