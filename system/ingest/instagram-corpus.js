'use strict';
// Instagram → raw/corpus/instagram/ (Phase 4).
// Converts an apify/instagram-scraper dataset dump (JSON array of posts for
// your own account) into one corpus file per post: caption as body, engagement
// in the header. Reel *transcripts* are a separate follow-up pass — this
// captures captions/metadata for the whole grid.
//
// Usage:
//   node system/ingest/instagram-corpus.js                 # newest raw file
//   node system/ingest/instagram-corpus.js --file <path>
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'instagram');
const RAW_DIR = path.join(os.homedir(), 'automation-scripts', 'data');

function slugify(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'untitled';
}

function newestRawFile() {
  if (!fs.existsSync(RAW_DIR)) return null;
  const files = fs.readdirSync(RAW_DIR)
    .filter(f => /^instagram-raw-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(RAW_DIR, files[files.length - 1]) : null;
}

// apify/instagram-scraper: type = Image | Video | Sidecar,
// productType = clips (reels) | feed | carousel_container | igtv
function postKind(p) {
  if (p.productType === 'clips') return 'reel';
  if (p.type === 'Sidecar') return 'carousel';
  if (p.type === 'Video') return 'video';
  return 'image';
}

function renderPost(p) {
  const date = String(p.timestamp || '').slice(0, 10);
  const caption = String(p.caption || '').trim();
  const words = caption ? caption.split(/\s+/).filter(Boolean).length : 0;
  const kind = postKind(p);
  const body = caption || `[no caption — ${kind}]`;
  return {
    name: `${date || 'undated'}-instagram-${p.shortCode}-${slugify(caption.slice(0, 60))}.md`,
    text: [
      '---',
      `id: instagram-${p.shortCode}`,
      'platform: instagram',
      `type: ${kind}`,
      `title: ${(caption.split('\n')[0] || `[${kind}]`).slice(0, 120)}`,
      `date: ${date}`,
      `url: ${p.url || `https://www.instagram.com/p/${p.shortCode}/`}`,
      `likes: ${Number(p.likesCount || 0)}`,
      `comments: ${Number(p.commentsCount || 0)}`,
      `views: ${Number(p.videoPlayCount || p.videoViewCount || 0)}`,
      `duration_sec: ${p.videoDuration ? Math.round(Number(p.videoDuration)) : 0}`,
      `pinned: ${p.isPinned ? 'yes' : 'no'}`,
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
    const m = head.match(/^id: instagram-(\S+)$/m);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  const rawPath = fileArg !== -1 ? args[fileArg + 1] : newestRawFile();
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.log('instagram-corpus: skipped (no instagram-raw-*.json found)');
    return;
  }
  const posts = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingIds(OUT_DIR);

  let written = 0, skipped = 0, noCode = 0;
  const byKind = {};
  for (const p of posts) {
    if (!p.shortCode) { noCode++; continue; }
    if (seen.has(p.shortCode)) { skipped++; continue; }
    seen.add(p.shortCode);
    const { name, text } = renderPost(p);
    fs.writeFileSync(path.join(OUT_DIR, name), text);
    const k = postKind(p);
    byKind[k] = (byKind[k] || 0) + 1;
    written++;
  }
  const kinds = Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`instagram-corpus: ${path.basename(rawPath)} → ${written} written (${kinds}), ${skipped} already in corpus${noCode ? `, ${noCode} without shortCode` : ''}`);
}

module.exports = { renderPost, postKind, slugify, newestRawFile };

if (require.main === module) main();
