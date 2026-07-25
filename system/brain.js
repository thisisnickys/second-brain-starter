'use strict';
const fs = require('fs');
const path = require('path');
const { tokenize } = require('./lib/text.js');
const { parseFrontmatter } = require('./lib/frontmatter.js');

function scoreNode(tokens, node) {
  const title = new Set(tokenize(node.title || ''));
  const tags = new Set([...(node.tags || []), ...(node.behaviors || [])].map(s => String(s).toLowerCase()));
  const keywords = new Set((node.keywords || []).map(s => String(s).toLowerCase()));
  const idTokens = new Set(tokenize(node.id || ''));
  let score = 0;
  for (const t of tokens) {
    if (title.has(t)) score += 5;
    if (tags.has(t)) score += 4;
    if (keywords.has(t)) score += 2;
    if (idTokens.has(t)) score += 1;
  }
  return score;
}

function bestSection(tokens, body) {
  const lines = body.split('\n');
  const sections = [];
  let cur = { heading: '(top)', text: [] };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) { sections.push(cur); cur = { heading: h[1], text: [] }; }
    else cur.text.push(line);
  }
  sections.push(cur);
  const candidates = sections.filter(s => s.text.join('').trim());
  const pool = candidates.length ? candidates : sections;
  let best = null, bestScore = -1;
  for (const s of pool) {
    const headingTokens = new Set(tokenize(s.heading));
    const bodyTokens = new Set(tokenize(s.text.join(' ')));
    let sc = 0;
    for (const t of tokens) {
      if (headingTokens.has(t)) sc += 3;
      if (bodyTokens.has(t)) sc += 1;
    }
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return { heading: best.heading, text: best.text.join('\n').trim().slice(0, 1500), score: bestScore };
}

function readBody(rootDir, id) {
  const p = path.join(rootDir, id);
  if (!fs.existsSync(p)) return null;
  return parseFrontmatter(fs.readFileSync(p, 'utf8')).body;
}

function retrieve(query, rootDir) {
  const tokens = tokenize(query);
  const graphPath = path.join(rootDir, 'indexes', 'graph.json');
  if (!fs.existsSync(graphPath)) {
    throw new Error('graph.json not found — run: node system/build-graph.js');
  }
  let graph;
  try { graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')); }
  catch (e) { throw new Error('graph.json is corrupt — rerun: node system/build-graph.js'); }
  const scored = graph.nodes
    .map(n => ({ id: n.id, title: n.title, type: n.type, score: scoreNode(tokens, n), links: n.links }))
    .filter(n => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  let snippet = null;
  // scored is already sorted by score desc, so the first match here is the highest-scoring one
  const topWiki = scored.find(n => n.type === 'file' || n.type === 'decision' || n.type === 'person');
  if (topWiki) {
    const body = readBody(rootDir, topWiki.id);
    if (body) {
      const s = bestSection(tokens, body);
      snippet = { id: topWiki.id, heading: s.heading, text: s.text, followed: null };
      if (s.text.length < 200) {
        const m = s.text.match(/\]\(([^)\s]+\.md)\)/);
        if (m) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(topWiki.id), m[1]));
          const tbody = target.startsWith('wiki/') ? readBody(rootDir, target) : null;
          if (tbody) {
            const ts = bestSection(tokens, tbody);
            snippet.followed = target;
            snippet.text = (snippet.text + '\n\n--- (followed pointer to ' + target + ') ---\n' + ts.text).slice(0, 3000);
          }
        }
      }
    }
  }

  let assets = [];
  const catPath = path.join(rootDir, 'indexes', 'files-catalog.json');
  if (fs.existsSync(catPath)) {
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    assets = cat.files
      .map(f => {
        const nameTokens = new Set(tokenize(f.name + ' ' + f.relPath));
        let hits = 0;
        for (const t of tokens) if (nameTokens.has(t)) hits += 1;
        return { f, hits, strong: [...tokens].some(t => t.length >= 5 && nameTokens.has(t)) };
      })
      .filter(x => x.hits >= 2 || (x.hits >= 1 && x.strong))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5)
      .map(x => ({ root: x.f.root, relPath: x.f.relPath, name: x.f.name }));
  }

  return { query, tokens, top: scored.map(({ links, ...rest }) => rest), snippet, assets };
}

module.exports = { scoreNode, bestSection, retrieve };
if (require.main === module) {
  const q = process.argv.slice(2).join(' ').trim();
  if (!q) { console.error('usage: node system/brain.js "your question"'); process.exit(1); }
  try {
    console.log(JSON.stringify(retrieve(q, path.join(__dirname, '..')), null, 1));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
