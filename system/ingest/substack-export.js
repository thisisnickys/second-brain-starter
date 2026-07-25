'use strict';
// Substack archive → raw/corpus/substack/. Set SUBSTACK_BASE in .env.
// Enumerates the public archive API and writes one markdown file per post
// (body converted from HTML). Resumable: posts whose id already exists in
// the corpus are skipped, so routine runs only fetch what's new.
const fs = require('fs');
const path = require('path');
const { htmlToMd } = require('./kit-export.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'substack');
const BASE = process.env.SUBSTACK_BASE; // e.g. https://yourname.substack.com

function slugify(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'untitled';
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function listArchive() {
  const all = [];
  for (let offset = 0; ; offset += 50) {
    const page = await getJson(`${BASE}/api/v1/archive?sort=new&limit=50&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    await new Promise(r => setTimeout(r, 500));
  }
  return all;
}

function existingIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const fd = fs.openSync(path.join(dir, f), 'r');
    const buf = Buffer.alloc(120);
    const n = fs.readSync(fd, buf, 0, 120, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/^id: substack-(\S+)$/m);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function renderPost(meta, body) {
  const date = String(meta.post_date || '').slice(0, 10);
  const title = String(meta.title || 'Untitled').replace(/\s+/g, ' ').trim();
  return {
    name: `${date}-substack-${meta.id}-${slugify(title)}.md`,
    text: [
      '---',
      `id: substack-${meta.id}`,
      'platform: substack',
      'type: post',
      `title: ${title}`,
      `date: ${date}`,
      `url: ${meta.canonical_url || ''}`,
      `audience: ${meta.audience || 'everyone'}`,
      `word_count: ${body.split(/\s+/).filter(Boolean).length}`,
      '---',
      '',
      meta.subtitle ? `*${meta.subtitle}*\n` : '',
      body,
      '',
    ].join('\n'),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingIds(OUT_DIR);
  const posts = (await listArchive()).filter(p => p.type !== 'thread');
  const fresh = posts.filter(p => !seen.has(String(p.id)));
  console.log(`substack-export: ${posts.length} posts in archive, ${seen.size} in corpus, fetching ${fresh.length}`);

  let ok = 0, paywalled = 0, failed = 0;
  for (const p of fresh) {
    try {
      const full = await getJson(`${BASE}/api/v1/posts/${p.slug}`);
      const html = full.body_html || '';
      if (!html && full.audience === 'only_paid') { paywalled++; continue; }
      const body = htmlToMd(html);
      const { name, text } = renderPost(full, body);
      fs.writeFileSync(path.join(OUT_DIR, name), text);
      ok++;
    } catch (e) {
      failed++;
      console.error(`substack-export: FAILED ${p.slug}: ${e.message.slice(0, 120)}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(`substack-export: done — ${ok} written${paywalled ? `, ${paywalled} paywalled (no public body)` : ''}${failed ? `, ${failed} FAILED` : ''}`);
}

module.exports = { renderPost, slugify };

if (require.main === module) main();
