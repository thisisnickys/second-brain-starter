'use strict';
// Repurpose Queue Generator — deterministic (zero Claude cost) candidate surfacing
// over the published-content corpus (indexes/content-catalog.json).
//
// Three tiers:
//   Tier 1 — pillar-match evergreen (12+ months old, has_fulltext, title matches a pillar)
//   Tier 3 — cross-platform gaps (youtube-long never echoed on kit/threads, and reverse)
//   Tier 4 — compilation clusters (shared distinctive title tokens across platforms + years)
//
// usage:
//   node system/repurpose.js [--json] [--write]
//     --json   print the queue as JSON instead of human-readable text
//     --write  also write wiki/content/repurpose/queue.md (overwritten each run)
//
// Items whose id appears in system/logs/repurpose-used.json are skipped everywhere.
const fs = require('fs');
const path = require('path');
const { tokenize } = require('./lib/text.js');
const { localDate } = require('./lib/date.js');
const { noteErrors } = require('./lib/note-write.js');

const USED_FILE = path.join('system', 'logs', 'repurpose-used.json');
const QUEUE_NOTE = path.join('wiki', 'content', 'repurpose', 'queue.md');

// Content pillars — title-keyword map (single tokens, matched via tokenize()).
// Rename these to YOUR pillars; anything unmatched still lands in the queue.
const PILLARS = {
  'ai-tools': [
    'ai', 'tool', 'tools', 'chatgpt', 'claude', 'midjourney', 'automation',
    'automate', 'agent', 'agents', 'gpt', 'prompt', 'prompts', 'notion',
    'app', 'apps', 'software', 'canva', 'gemini',
  ],
  'creator-identity': [
    'introvert', 'introverts', 'introverted', 'burnout', 'confidence',
    'journey', 'mindset', 'fear', 'doubt', 'identity', 'authentic',
    'imposter', 'story', 'purpose', 'growth',
  ],
  'creator-systems': [
    'system', 'systems', 'workflow', 'workflows', 'batch', 'batching',
    'repurpose', 'repurposing', 'plan', 'planning', 'schedule', 'pipeline',
    'process', 'template', 'templates', 'calendar', 'consistency',
  ],
  'community': [
    'community', 'lions', 'behavior', 'membership', 'members', 'member',
    'tribe', 'audience', 'lock', 'heartbeat',
  ],
};

const TIER1_PER_PILLAR = 5;
const TIER3_LIMIT = 10;
const TIER4_LIMIT = 5;
const CLUSTER_MIN_ITEMS = 5;
const CLUSTER_MIN_PLATFORMS = 2;
const CLUSTER_MIN_YEARS = 2;
const CLUSTER_MIN_TOKEN_LEN = 5;
const CLUSTER_MAX_SHARE = 0.01;   // tokens in >1% of the catalog are too generic to be a theme
const GAP_MIN_TOKEN_LEN = 4;
const GAP_OVERLAP_TOKENS = 2;     // a title "crossed platforms" when some opposite-platform title shares this many tokens
const TIER1_MIN_TITLE_TOKENS = 3; // one-word titles ("Prompt:") aren't repurposable evergreen

// Common English words that slip past the small shared stopword list — never a
// compilation theme on their own (extends STOPWORDS for Tier 4 only).
const CLUSTER_GENERIC = new Set((
  'about after again already another because coming crazy going great however ' +
  'nothing really right still there these thing things think today trying using ' +
  'actually anyone before being everyone every doesn didn going gonna little ' +
  'making never other people something someone talking their through where while ' +
  'without would should could youre dont thats whats heres youve theyre'
).split(/\s+/));

function parseArgs(argv) {
  const opts = { json: false, write: false, markUsed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--write') opts.write = true;
    // --mark-used id1,id2 — record queue items as consumed so they never
    // resurface (the audit found the queue regenerated daily but NOTHING ever
    // marked anything used; /pipeline and /brain-weekly call this now).
    else if (a === '--mark-used' && argv[i + 1]) { opts.markUsed = argv[++i].split(',').map(s => s.trim()).filter(Boolean); }
  }
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

// --- used-ids tracking (system/logs/repurpose-used.json — a flat JSON array of ids) ---
function loadUsedIds(rootDir) {
  const p = path.join(rootDir, USED_FILE);
  if (!fs.existsSync(p)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (e) { return new Set(); } // corrupt file = treat as empty, never crash
}

// Append ids to the used file (dedup, sorted for stable diffs). Returns the new list.
function markUsed(rootDir, ids) {
  const set = loadUsedIds(rootDir);
  for (const id of [].concat(ids)) if (id) set.add(String(id));
  const list = Array.from(set).sort();
  const p = path.join(rootDir, USED_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 1) + '\n');
  return list;
}

// --- date helpers (local time, never toISOString) ---
function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

// Whole months between an item date and today (floor; null when undated).
function monthsOld(dateStr, today) {
  const d = parseDate(dateStr);
  if (!d) return null;
  let months = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth());
  if (today.getDate() < d.getDate()) months--;
  return months;
}

function yearsOld(dateStr, today) {
  const m = monthsOld(dateStr, today);
  return m == null ? null : m / 12;
}

// --- Tier 1: pillar-match evergreen ---
// Prefer 1-3 years old; older items decay gently (a 10-year-old post ranks
// below a 2-year-old one at the same keyword density).
function recencyWeight(ageYears) {
  if (ageYears <= 3) return 1;
  return Math.max(0, 1 - (ageYears - 3) * 0.1);
}

function pillarTier(items, today) {
  const out = {};
  for (const [pillar, keywords] of Object.entries(PILLARS)) {
    const kw = new Set(keywords);
    const ranked = [];
    for (const it of items) {
      if (!it.has_fulltext) continue;
      const age = monthsOld(it.date, today);
      if (age == null || age < 12) continue;
      const titleTokens = tokenize(it.title || '');
      if (titleTokens.length < TIER1_MIN_TITLE_TOKENS) continue;
      const matched = titleTokens.filter(t => kw.has(t));
      if (!matched.length) continue;
      const density = matched.length / titleTokens.length;
      const score = density + recencyWeight(age / 12);
      ranked.push({ item: it, score, matched });
    }
    ranked.sort((a, b) =>
      b.score - a.score ||
      String(b.item.date).localeCompare(String(a.item.date)) ||
      String(a.item.id).localeCompare(String(b.item.id)));
    out[pillar] = ranked.slice(0, TIER1_PER_PILLAR)
      .map(r => toCandidate(r.item, { score: round3(r.score), matched: r.matched }));
  }
  return out;
}

// --- Tier 3: cross-platform gaps ---
// Distinctive title tokens = tokenize() output with length >= GAP_MIN_TOKEN_LEN.
function gapTokens(title) {
  return tokenize(title || '').filter(t => t.length >= GAP_MIN_TOKEN_LEN);
}

// A title has "crossed platforms" when at least one opposite-platform title
// shares GAP_OVERLAP_TOKENS+ of its distinctive tokens (single shared words are
// coincidence at corpus scale; two shared words is the same topic).
function crossed(tokens, pool) {
  return pool.some(set => {
    let hits = 0;
    for (const t of tokens) if (set.has(t) && ++hits >= GAP_OVERLAP_TOKENS) return true;
    return false;
  });
}

function gapTier(items, today) {
  const kitThreadsPool = items
    .filter(it => it.platform === 'kit' || it.platform === 'threads')
    .map(it => new Set(gapTokens(it.title)));
  const youtubePool = items
    .filter(it => it.platform === 'youtube')
    .map(it => new Set(gapTokens(it.title)));
  const candidates = [];
  for (const it of items) {
    const age = monthsOld(it.date, today);
    if (age == null || age < 6) continue;
    if (it.platform === 'youtube' && it.type === 'long') {
      const toks = gapTokens(it.title);
      if (toks.length >= GAP_OVERLAP_TOKENS && !crossed(toks, kitThreadsPool)) {
        candidates.push(toCandidate(it, { direction: 'youtube → kit/threads' }));
      }
    } else if (it.platform === 'kit' && it.type === 'newsletter') {
      const toks = gapTokens(it.title);
      if (toks.length >= GAP_OVERLAP_TOKENS && !crossed(toks, youtubePool)) {
        candidates.push(toCandidate(it, { direction: 'kit → youtube' }));
      }
    }
  }
  candidates.sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) ||
    String(a.id).localeCompare(String(b.id)));
  return candidates.slice(0, TIER3_LIMIT);
}

// --- Tier 4: compilation clusters ---
// Distinctive tokens (>= 5 chars) shared by 5+ items spanning 2+ platforms and
// 2+ calendar years — flagship / product-material themes.
function clusterTier(items) {
  const byToken = new Map();
  for (const it of items) {
    const year = (parseDate(it.date) || { getFullYear: () => null }).getFullYear();
    if (year == null) continue;
    for (const t of tokenize(it.title || '')) {
      if (t.length < CLUSTER_MIN_TOKEN_LEN || CLUSTER_GENERIC.has(t)) continue;
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(it);
    }
  }
  const maxItems = Math.max(CLUSTER_MIN_ITEMS, Math.floor(items.length * CLUSTER_MAX_SHARE));
  const clusters = [];
  for (const [token, members] of byToken) {
    if (members.length < CLUSTER_MIN_ITEMS || members.length > maxItems) continue;
    const platforms = new Set(members.map(m => m.platform));
    if (platforms.size < CLUSTER_MIN_PLATFORMS) continue;
    const years = new Set(members.map(m => String(m.date).slice(0, 4)));
    if (years.size < CLUSTER_MIN_YEARS) continue;
    const sortedYears = Array.from(years).sort();
    clusters.push({
      theme: token,
      count: members.length,
      platforms: Array.from(platforms).sort(),
      yearSpan: sortedYears[0] + '–' + sortedYears[sortedYears.length - 1],
      sample: members
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 3)
        .map(m => toCandidate(m, {})),
    });
  }
  clusters.sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  return clusters.slice(0, TIER4_LIMIT);
}

function toCandidate(item, extra) {
  return Object.assign({
    id: item.id, platform: item.platform, type: item.type,
    date: item.date || '', title: item.title || '', file: item.file || null,
  }, extra);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// --- queue assembly ---
function buildQueue(rootDir, today) {
  today = today || parseDate(localDate());
  const catalog = loadCatalog(rootDir);
  const used = loadUsedIds(rootDir);
  const items = catalog.items.filter(it => !used.has(it.id));
  return {
    generated: localDate(today),
    tier1: pillarTier(items, today),
    tier3: gapTier(items, today),
    tier4: clusterTier(items),
  };
}

// --- output ---
function bullet(c) {
  return `- [${c.platform}-${c.type} · ${c.date || 'undated'}] ${c.title} — ${c.file || '(no file)'}`;
}

function renderNote(queue) {
  const L = [];
  L.push('---');
  L.push('title: Repurpose Queue');
  L.push('department: content');
  L.push('tags: [repurpose, queue]');
  L.push('behaviors: [create]');
  L.push('source: capture:repurpose-auto');
  L.push(`updated: ${queue.generated}`);
  L.push('---');
  L.push('');
  L.push(`Generated ${queue.generated} — candidates only; you decide.`);
  L.push('');
  L.push('## Tier 1 — Pillar-match evergreen');
  L.push('');
  for (const [pillar, cands] of Object.entries(queue.tier1)) {
    L.push(`### ${pillar}`);
    L.push('');
    if (!cands.length) L.push('- (none found)');
    else for (const c of cands) L.push(bullet(c));
    L.push('');
  }
  L.push('## Tier 3 — Cross-platform gaps');
  L.push('');
  if (!queue.tier3.length) L.push('- (none found)');
  else for (const c of queue.tier3) L.push(`${bullet(c)} _(${c.direction})_`);
  L.push('');
  L.push('## Tier 4 — Compilation clusters');
  L.push('');
  if (!queue.tier4.length) L.push('- (none found)');
  else for (const cl of queue.tier4) {
    L.push(`### ${cl.theme} — ${cl.count} items, ${cl.yearSpan}, ${cl.platforms.join(' + ')}`);
    L.push('');
    for (const c of cl.sample) L.push(bullet(c));
    L.push('');
  }
  return L.join('\n').replace(/\n+$/, '') + '\n';
}

// Lint-gated overwrite of the generated queue note (it's a surface, not history).
function writeQueueNote(rootDir, queue) {
  const content = renderNote(queue);
  const errs = noteErrors(content);
  if (errs.length) throw new Error('queue note failed lint: ' + errs.join('; '));
  const p = path.join(rootDir, QUEUE_NOTE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function formatHuman(queue) {
  const L = [`Repurpose queue — generated ${queue.generated} (candidates only; you decide)`, ''];
  L.push('TIER 1 — pillar-match evergreen');
  for (const [pillar, cands] of Object.entries(queue.tier1)) {
    L.push(`  ${pillar}:`);
    if (!cands.length) L.push('    (none)');
    for (const c of cands) L.push(`    ${c.date}  ${c.platform}-${c.type}  ${trim(c.title)}`);
  }
  L.push('');
  L.push('TIER 3 — cross-platform gaps');
  if (!queue.tier3.length) L.push('  (none)');
  for (const c of queue.tier3) L.push(`  ${c.date}  ${c.platform}-${c.type}  ${trim(c.title)}  (${c.direction})`);
  L.push('');
  L.push('TIER 4 — compilation clusters');
  if (!queue.tier4.length) L.push('  (none)');
  for (const cl of queue.tier4) L.push(`  ${cl.theme}: ${cl.count} items, ${cl.yearSpan}, ${cl.platforms.join('+')}`);
  return L.join('\n');
}

function trim(s) { return s.length > 70 ? s.slice(0, 69) + '…' : s; }

module.exports = {
  PILLARS, parseArgs, loadUsedIds, markUsed, monthsOld, yearsOld, recencyWeight,
  pillarTier, gapTier, gapTokens, clusterTier, buildQueue, renderNote, writeQueueNote,
};

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = path.join(__dirname, '..');
  try {
    if (opts.markUsed) {
      const all = markUsed(rootDir, opts.markUsed);
      console.log(`marked used: ${opts.markUsed.join(', ')} (${all.length} total in ${USED_FILE})`);
      process.exit(0);
    }
    const queue = buildQueue(rootDir);
    console.log(opts.json ? JSON.stringify(queue, null, 1) : formatHuman(queue));
    if (opts.write) {
      const p = writeQueueNote(rootDir, queue);
      console.log(`\nwrote ${path.relative(rootDir, p)}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
