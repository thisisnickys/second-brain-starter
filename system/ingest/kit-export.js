'use strict';
// Kit (ConvertKit) broadcast export → raw/corpus/kit/.
// Pulls every completed broadcast via the Kit v4 API and writes one markdown
// file per send, with a structured header the content catalog can parse.
// Resumable: broadcasts whose id already exists in the corpus are skipped,
// so routine runs only fetch what's new.
// Needs KIT_API_KEY in ~/second-brain/.env — exits 0 with a notice when
// missing so run-ingest.sh stays green on machines without the key.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'kit');
const API = 'https://api.kit.com/v4';

function readEnv() {
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// --- classification -------------------------------------------------------
// The account mixes weekly newsletters with live-stream announcements,
// podcast episode drops, and community/promo sends. Keep everything (it is
// all footprint) but label it so the catalog can slice by type.
function classify(b) {
  const s = (b.subject || '');
  if (/🔉|🎧/.test(s)) return 'podcast-announcement';
  if (/^\s*(🔴|📺)/.test(s) || /\bLive Now\b/i.test(s) || /Is Live Right Now/i.test(s)) {
    return 'live-announcement';
  }
  if (b.public) return 'newsletter';
  return 'update';
}

function slugify(s) {
  return (s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'untitled';
}

// --- html → markdown-ish text ---------------------------------------------
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name] !== undefined ? named[name] : m);
}

function htmlToMd(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, '');
  // links and images before generic tag stripping
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/^(#|mailto:)/.test(href) || !href) return t;
    return `[${t}](${href})`;
  });
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![$1]($2)');
  s = s.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');
  // block structure → newlines
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Math.min(Number(n) + 1, 6))} `);
  s = s.replace(/<\/h[1-6]>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|table|ul|ol|li|blockquote|section|figure)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // tidy whitespace
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function wordCount(s) {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

// --- api -------------------------------------------------------------------
async function kitGet(key, url, attempt) {
  const res = await fetch(url, { headers: { 'X-Kit-Api-Key': key, Accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) {
    if ((attempt || 0) < 2) {
      await new Promise(r => setTimeout(r, 2000 * ((attempt || 0) + 1)));
      return kitGet(key, url, (attempt || 0) + 1);
    }
  }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function listAllBroadcasts(key) {
  const all = [];
  let cursor = null;
  for (;;) {
    const url = `${API}/broadcasts?per_page=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const data = await kitGet(key, url);
    all.push(...(data.broadcasts || []));
    const pg = data.pagination || {};
    if (!pg.has_next_page || !pg.end_cursor) break;
    cursor = pg.end_cursor;
  }
  return all;
}

function existingIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/-kit-(\d+)-/);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

function renderFile(b, body) {
  const date = localDate(new Date(b.published_at || b.send_at || b.created_at));
  const title = (b.subject || 'Untitled').replace(/\s+/g, ' ').trim();
  const lines = [
    '---',
    `id: kit-${b.id}`,
    'platform: kit',
    `type: ${classify(b)}`,
    `title: ${title}`,
    `date: ${date}`,
    `published_at: ${b.published_at || ''}`,
    `public_url: ${b.public_url || ''}`,
    `word_count: ${wordCount(body)}`,
    '---',
    '',
    body,
    '',
  ];
  return { date, text: lines.join('\n') };
}

async function main() {
  const env = readEnv();
  const key = env.KIT_API_KEY;
  if (!key) {
    console.log('kit-export: skipped (no KIT_API_KEY in .env)');
    return;
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingIds(OUT_DIR);
  const broadcasts = (await listAllBroadcasts(key)).filter(b => b.status === 'completed');
  const fresh = broadcasts.filter(b => !seen.has(b.id)).slice(0, limit);
  console.log(`kit-export: ${broadcasts.length} completed broadcasts, ${seen.size} already in corpus, fetching ${fresh.length}`);

  const byType = {};
  let failures = 0;
  for (const b of fresh) {
    try {
      const data = await kitGet(key, `${API}/broadcasts/${b.id}`);
      const full = data.broadcast || b;
      const body = htmlToMd(full.content || '');
      const { date, text } = renderFile(full, body);
      const file = `${date}-kit-${b.id}-${slugify(b.subject)}.md`;
      fs.writeFileSync(path.join(OUT_DIR, file), text);
      const t = classify(full);
      byType[t] = (byType[t] || 0) + 1;
    } catch (e) {
      failures++;
      console.error(`kit-export: FAILED broadcast ${b.id} (${b.subject}): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350)); // stay well under Kit rate limits
  }
  const summary = Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(' ') || 'nothing new';
  console.log(`kit-export: done — ${summary}${failures ? ` (${failures} FAILED)` : ''}`);
  if (failures) process.exitCode = 1;
}

module.exports = { classify, slugify, htmlToMd, decodeEntities, wordCount, renderFile };

if (require.main === module) {
  main().catch(e => { console.error(`kit-export: fatal — ${e.message}`); process.exit(1); });
}
