'use strict';
// Related-capture linking — the Jul 22 2026 audit found the same topic minted
// as five separate notes (one topic ×5, another ×6) with ZERO authored
// links anywhere in the wiki. On each new Telegram capture, this finds the
// most similar existing learning note by title-token overlap and stamps a
// `**Related:**` line into the fresh note, so knowledge threads instead of
// fragmenting. Deterministic, no LLM.
const fs = require('fs');
const path = require('path');
const { DEPARTMENTS } = require('./config.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

const STOP = new Set([
  'the', 'and', 'for', 'with', 'how', 'what', 'why', 'when', 'you', 'your',
  'from', 'this', 'that', 'are', 'was', 'not', 'its', 'into', 'about', 'her',
  'his', 'she', 'him', 'they', 'them', 'their', 'can', 'will', 'just', 'one', 'two',
  'new', 'all', 'out', 'get', 'use', 'using', 'via', 'vs'
]);

// Light suffix strip so "launching"/"launch"/"launches" collide.
function stem(w) {
  return w.replace(/(?:ing|ers?|es|ed|s)$/i, '') || w;
}

function tokens(title) {
  const out = new Set();
  for (const raw of String(title == null ? '' : title).toLowerCase().split(/[^a-z0-9.]+/i)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

// Scan learning + remembered notes for the closest title. Returns
// { relPath, title, overlap } or null. Match bar: ≥2 shared tokens AND at
// least half of the smaller title's tokens shared — passing mentions don't
// count as related.
function findRelated(title, rootDir, opts = {}) {
  const root = rootDir || ROOT_DIR;
  const mine = tokens(title);
  if (mine.size < 2) return null;
  const excludeRel = opts.excludeRel ? path.normalize(opts.excludeRel) : null;
  let best = null;
  for (const dept of DEPARTMENTS) {
    for (const sub of ['learning', 'remembered']) {
      const dir = path.join(root, 'wiki', dept, sub);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (err) { continue; }
      for (const f of files) {
        const rel = path.join('wiki', dept, sub, f);
        if (excludeRel && path.normalize(rel) === excludeRel) continue;
        let text = '';
        try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (err) { continue; }
        const m = text.match(/^title:\s*(.+)$/m);
        if (!m) continue;
        const theirs = tokens(m[1]);
        let overlap = 0;
        for (const t of mine) if (theirs.has(t)) overlap++;
        // ≥2 shared always required; a third of the smaller title's tokens on
        // top of that for longer titles (half was too strict — a model name alone
        // splits into two tokens, and real dupes share 3 of 7, not 4 of 7).
        const bar = Math.max(2, Math.ceil(Math.min(mine.size, theirs.size) / 3));
        if (overlap >= bar && (!best || overlap > best.overlap)) {
          best = { relPath: rel, title: m[1].trim(), overlap };
        }
      }
    }
  }
  return best;
}

// Find + stamp: appends a Related line to the just-written note (body-only
// append — frontmatter untouched, lint-safe). Returns the related note or
// null; never throws (a linking failure must not break the capture).
function linkRelated(rootDir, relPath, title) {
  try {
    const root = rootDir || ROOT_DIR;
    const related = findRelated(title, root, { excludeRel: relPath });
    if (!related) return null;
    const abs = path.join(root, relPath);
    const slug = path.basename(related.relPath, '.md');
    const content = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, `${content.replace(/\s+$/, '')}\n\n**Related:** [[${slug}]] — ${related.title}\n`);
    return related;
  } catch (err) {
    console.error('related-notes link failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { tokens, findRelated, linkRelated };
