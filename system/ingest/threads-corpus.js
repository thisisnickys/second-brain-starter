'use strict';
// Threads → raw/corpus/threads/ (Phase 3).
// Converts the newest threads-raw-*.json produced by
// automation-scripts/data/fetch_threads_apify.py (the Jul 2026 two-stage
// scraper) into one corpus file per post. The Notion Top Threads Archive
// stays the curated top-performers store; this is the full local footprint.
//
// Usage:
//   node system/ingest/threads-corpus.js                # newest raw file
//   node system/ingest/threads-corpus.js --file <path>  # specific raw file
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'threads');
const RAW_DIR = path.join(os.homedir(), 'automation-scripts', 'data');

function slugify(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'untitled';
}

function newestRawFile() {
  if (!fs.existsSync(RAW_DIR)) return null;
  const files = fs.readdirSync(RAW_DIR)
    .filter(f => /^threads-raw-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(RAW_DIR, files[files.length - 1]) : null;
}

function postKind(p) {
  if (p.is_repost) return 'repost';
  if (p.is_quote_post) return 'quote';
  if (p.is_reply) return 'reply';
  return 'post';
}

function renderPost(p) {
  const date = String(p.created_at || '').slice(0, 10);
  const text = String(p.text_content || '').trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const body = text || (p.has_media ? `[media-only ${p.media_type || 'post'}]` : '[empty post]');
  return {
    name: `${date || 'undated'}-threads-${p.shortcode}-${slugify(text.slice(0, 60))}.md`,
    text: [
      '---',
      `id: threads-${p.shortcode}`,
      'platform: threads',
      `type: ${postKind(p)}`,
      `title: ${(text.split('\n')[0] || `[${p.media_type || 'media'} post]`).slice(0, 120)}`,
      `date: ${date}`,
      `url: ${p.post_url || `https://www.threads.net/@${p.username}/post/${p.shortcode}`}`,
      `likes: ${Number(p.like_count || 0)}`,
      `replies: ${Number(p.reply_count || 0)}`,
      `views: ${Number(p.view_count || 0)}`,
      `media: ${p.has_media ? (p.media_type || 'yes') : 'none'}`,
      `pinned: ${p.is_pinned ? 'yes' : 'no'}`,
      `word_count: ${words}`,
      '---',
      '',
      body,
      '',
    ].join('\n'),
  };
}

// Read each file's `id:` header — filename parsing is ambiguous because
// shortcodes and slugs both contain hyphens.
function existingIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    let head = '';
    try {
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(200);
      const n = fs.readSync(fd, buf, 0, 200, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8', 0, n);
    } catch (e) { continue; }
    const m = head.match(/^id: threads-(\S+)$/m);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  const rawPath = fileArg !== -1 ? args[fileArg + 1] : newestRawFile();
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.log('threads-corpus: skipped (no threads-raw-*.json found)');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const posts = raw.posts || [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingIds(OUT_DIR);

  let written = 0, skipped = 0, noCode = 0;
  const byKind = {};
  for (const p of posts) {
    if (!p.shortcode) { noCode++; continue; }
    if (seen.has(p.shortcode)) { skipped++; continue; }
    seen.add(p.shortcode);
    const { name, text } = renderPost(p);
    fs.writeFileSync(path.join(OUT_DIR, name), text);
    const k = postKind(p);
    byKind[k] = (byKind[k] || 0) + 1;
    written++;
  }
  const kinds = Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`threads-corpus: ${path.basename(rawPath)} → ${written} written (${kinds}), ${skipped} already in corpus${noCode ? `, ${noCode} without shortcode` : ''}`);
}

module.exports = { renderPost, postKind, slugify, newestRawFile };

if (require.main === module) main();
