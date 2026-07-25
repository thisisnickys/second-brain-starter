'use strict';
// Deterministic search CLI over the published-content corpus (indexes/content-catalog.json
// + raw/corpus/<platform>/*.md). Zero runtime deps, sync reads, never crashes on a bad file.
//
// usage:
//   node system/corpus.js "<query>" [--platform p] [--type t] [--limit N] [--since YYYY[-MM-DD]] [--json]
//   node system/corpus.js --onthisweek [--years-back N] [--platform p] [--type t] [--limit N] [--json]
const fs = require('fs');
const path = require('path');
const { tokenize } = require('./lib/text.js');
const { localDate } = require('./lib/date.js');

const TITLE_WEIGHT = 5;      // per query token found in the title
const BODY_CAP = 5;          // fulltext occurrences per token count at most this much
const WINDOW_DAYS = 5;       // --onthisweek: ± days around today's month/day
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    query: null, platform: null, type: null, limit: 10,
    since: null, json: false, onthisweek: false, yearsBack: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--onthisweek') opts.onthisweek = true;
    else if (a === '--platform') opts.platform = argv[++i] || null;
    else if (a === '--type') opts.type = argv[++i] || null;
    else if (a === '--limit') { const n = parseInt(argv[++i], 10); if (n > 0) opts.limit = n; }
    else if (a === '--since') opts.since = argv[++i] || null;
    else if (a === '--years-back') { const n = parseInt(argv[++i], 10); if (n > 0) opts.yearsBack = n; }
    else if (!a.startsWith('--') && opts.query === null) opts.query = a;
  }
  // --since accepts a bare year: normalize "2024" -> "2024-01-01"
  if (opts.since && /^\d{4}$/.test(opts.since)) opts.since = opts.since + '-01-01';
  return opts;
}

function loadCatalog(rootDir) {
  const p = path.join(rootDir, 'indexes', 'content-catalog.json');
  if (!fs.existsSync(p)) {
    throw new Error('content-catalog.json not found — expected at indexes/content-catalog.json');
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('content-catalog.json is corrupt: ' + e.message); }
}

function filterItems(items, opts) {
  return items.filter(it => {
    if (opts.platform && it.platform !== opts.platform) return false;
    if (opts.type && it.type !== opts.type) return false;
    if (opts.since && (!it.date || it.date < opts.since)) return false;
    return true;
  });
}

// Word-frequency map of a fulltext file (lowercased, split on non-alphanumerics),
// so token counting matches whole words, not substrings.
function wordFreq(text) {
  const freq = new Map();
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

function scoreItem(tokens, item, freq) {
  const titleTokens = new Set(tokenize(item.title || ''));
  let score = 0;
  for (const t of tokens) {
    if (titleTokens.has(t)) score += TITLE_WEIGHT;
    if (freq) score += Math.min(freq.get(t) || 0, BODY_CAP);
  }
  return score;
}

function readFulltext(rootDir, item) {
  if (!item.file || !item.has_fulltext) return null;
  try { return fs.readFileSync(path.join(rootDir, item.file), 'utf8'); }
  catch (e) { return null; } // missing/unreadable file — skip, never crash
}

function search(query, opts, rootDir) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const catalog = loadCatalog(rootDir);
  const results = [];
  for (const item of filterItems(catalog.items, opts)) {
    const body = readFulltext(rootDir, item);
    const score = scoreItem(tokens, item, body ? wordFreq(body) : null);
    if (score > 0) results.push(toResult(item, score));
  }
  results.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return results.slice(0, opts.limit);
}

// True when dateStr (YYYY-MM-DD) falls within ±windowDays of today's month/day
// in dateStr's own year (year-boundary wrap handled by checking adjacent years).
function inWindow(dateStr, today, windowDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return false;
  const item = new Date(+m[1], +m[2] - 1, +m[3]);
  for (const y of [+m[1] - 1, +m[1], +m[1] + 1]) {
    const anchor = new Date(y, today.getMonth(), today.getDate());
    if (Math.abs(item - anchor) / DAY_MS <= windowDays) return true;
  }
  return false;
}

function onThisWeek(opts, rootDir, today) {
  today = today || new Date();
  const catalog = loadCatalog(rootDir);
  const thisYear = today.getFullYear();
  const minYear = opts.yearsBack ? thisYear - opts.yearsBack : -Infinity;
  const results = [];
  for (const item of filterItems(catalog.items, opts)) {
    const m = /^(\d{4})/.exec(String(item.date || ''));
    if (!m) continue;
    const year = +m[1];
    if (year >= thisYear || year < minYear) continue; // prior years only
    if (!inWindow(item.date, today, WINDOW_DAYS)) continue;
    results.push(toResult(item, thisYear - year)); // score = years ago
  }
  results.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return results.slice(0, opts.limit);
}

function toResult(item, score) {
  return {
    id: item.id, score, date: item.date || '', platform: item.platform,
    type: item.type, title: item.title || '', word_count: item.word_count,
    file: item.file || null,
  };
}

function formatHuman(results) {
  return results.map(r => {
    const title = r.title.length > 80 ? r.title.slice(0, 79) + '…' : r.title;
    const wc = r.word_count == null ? '-' : r.word_count + 'w';
    return [String(r.score).padStart(4), r.date || '(no date)', r.platform + '-' + r.type, title, wc, r.file || '(no file)'].join('  ');
  }).join('\n');
}

module.exports = { parseArgs, filterItems, wordFreq, scoreItem, search, inWindow, onThisWeek };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = path.join(__dirname, '..');
  try {
    let results;
    if (opts.onthisweek) {
      // localDate keeps "today" in local time; re-parse it so window math matches.
      const [y, mo, d] = localDate().split('-').map(Number);
      results = onThisWeek(opts, rootDir, new Date(y, mo - 1, d));
    } else {
      if (!opts.query) {
        console.error('usage: node system/corpus.js "<query>" [--platform p] [--type t] [--limit N] [--since YYYY[-MM-DD]] [--json]\n       node system/corpus.js --onthisweek [--years-back N]');
        process.exit(1);
      }
      results = search(opts.query, opts, rootDir);
    }
    if (!results.length) { console.log(opts.json ? '[]' : 'No matches.'); process.exit(0); }
    console.log(opts.json ? JSON.stringify(results, null, 1) : formatHuman(results));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
