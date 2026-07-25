'use strict';
// Published-content catalog → indexes/content-catalog.json (+ .md summary).
// One row per piece of published content across every platform, with a
// has_fulltext flag, so "what's missing from the corpus" is a query.
// Sources:
//   raw/corpus/<platform>/*.md        — full text already captured (kit,
//                                       youtube, threads, instagram, ...)
//   raw/corpus/manifests/<name>.txt   — known published inventory, one
//                                       "id|title" per line; <name> is
//                                       <platform>-<type> (e.g. youtube-live)
// A manifest row is matched to fulltext when any corpus file contains its id.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'raw', 'corpus');
const MANIFESTS = path.join(CORPUS, 'manifests');

// Parse the compact `---` header block a corpus file starts with.
function parseCorpusHeader(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return data;
}

function scanCorpus() {
  const items = [];
  if (!fs.existsSync(CORPUS)) return items;
  for (const dir of fs.readdirSync(CORPUS, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'manifests') continue;
    const dirPath = path.join(CORPUS, dir.name);
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.md')) continue;
      const rel = `raw/corpus/${dir.name}/${f}`;
      let data = null;
      try { data = parseCorpusHeader(fs.readFileSync(path.join(dirPath, f), 'utf8')); }
      catch (e) { /* unreadable — fall through to filename-only entry */ }
      items.push({
        id: (data && data.id) || f.replace(/\.md$/, ''),
        platform: (data && data.platform) || dir.name,
        type: (data && data.type) || '',
        title: (data && data.title) || f,
        date: (data && data.date) || '',
        word_count: data && data.word_count ? Number(data.word_count) : null,
        file: rel,
        has_fulltext: true,
      });
    }
  }
  return items;
}

function scanManifests(corpusItems) {
  // Any corpus id or filename can vouch for a manifest row.
  const known = new Set();
  for (const it of corpusItems) {
    known.add(it.id);
    for (const part of it.id.split(/[/-]/)) if (part.length >= 8) known.add(part);
    known.add(it.file);
  }
  const knownBlob = Array.from(known).join('\n');

  const items = [];
  if (!fs.existsSync(MANIFESTS)) return items;
  for (const f of fs.readdirSync(MANIFESTS)) {
    if (!f.endsWith('.txt')) continue;
    const name = f.replace(/\.txt$/, '');
    const dash = name.indexOf('-');
    const platform = dash === -1 ? name : name.slice(0, dash);
    const type = dash === -1 ? '' : name.slice(dash + 1);
    for (const line of fs.readFileSync(path.join(MANIFESTS, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const sep = line.indexOf('|');
      const id = (sep === -1 ? line : line.slice(0, sep)).trim();
      const title = sep === -1 ? '' : line.slice(sep + 1).trim();
      if (!id) continue;
      items.push({
        id: `${platform}-${id}`,
        platform,
        type,
        title,
        date: '',
        word_count: null,
        file: null,
        has_fulltext: knownBlob.includes(id),
      });
    }
  }
  return items;
}

function main() {
  const corpusItems = scanCorpus();
  const manifestItems = scanManifests(corpusItems);
  // Corpus wins on duplicates (a manifest row already captured as fulltext
  // keeps its manifest identity but is flagged; drop only exact id clashes).
  const seen = new Set(corpusItems.map(i => i.id));
  const items = corpusItems.concat(manifestItems.filter(i => !seen.has(i.id)));

  const platforms = {};
  for (const it of items) {
    const k = it.type ? `${it.platform}-${it.type}` : it.platform;
    platforms[k] = platforms[k] || { total: 0, fulltext: 0 };
    platforms[k].total++;
    if (it.has_fulltext) platforms[k].fulltext++;
  }

  const outDir = path.join(ROOT, 'indexes');
  fs.writeFileSync(path.join(outDir, 'content-catalog.json'),
    JSON.stringify({ generated: localDate(), platforms, items }, null, 1));

  let md = `# Published Content Catalog\n\nRebuilt by system/ingest/content-catalog.js — every published piece across platforms, with fulltext coverage.\n\n| Platform | Captured | Total | Coverage |\n|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(platforms).sort()) {
    const pct = v.total ? Math.round((v.fulltext / v.total) * 100) : 0;
    md += `| ${k} | ${v.fulltext} | ${v.total} | ${pct}% |\n`;
  }
  fs.writeFileSync(path.join(outDir, 'content-catalog.md'), md);

  const totals = Object.values(platforms).reduce((a, v) => ({ t: a.t + v.total, f: a.f + v.fulltext }), { t: 0, f: 0 });
  console.log(`content-catalog: ${totals.f}/${totals.t} pieces have fulltext across ${Object.keys(platforms).length} platform buckets`);
}

module.exports = { parseCorpusHeader, scanCorpus, scanManifests };

if (require.main === module) main();
