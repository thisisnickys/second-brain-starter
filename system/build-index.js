'use strict';
const fs = require('fs');
const path = require('path');
const { parseFrontmatter, DEPARTMENTS } = require('./lib/frontmatter.js');

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function buildIndex(wikiDir) {
  const byDepartment = {};
  for (const d of DEPARTMENTS) byDepartment[d] = [];
  for (const file of walk(wikiDir)) {
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!DEPARTMENTS.includes(data.department)) continue;
    byDepartment[data.department].push({
      title: data.title || path.basename(file),
      relPath: path.relative(wikiDir, file),
      tags: data.tags || [],
      behaviors: data.behaviors || [],
      updated: data.updated || '',
    });
  }
  for (const d of DEPARTMENTS)
    byDepartment[d].sort((a, b) => a.title.localeCompare(b.title));
  return { byDepartment };
}

// indexes/ is gitignored (it is a cache), so a fresh clone has no such
// directory. Create it rather than crashing on the very first command a new
// user runs.
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeIndexes(root) {
  const wikiDir = path.join(root, 'wiki');
  const outDir = path.join(root, 'indexes');
  ensureDir(outDir);
  const { byDepartment } = buildIndex(wikiDir);
  let master = `# Brain Index\n\nRebuilt by system/build-index.js — do not hand-edit.\n\n`;
  for (const d of DEPARTMENTS) {
    const pages = byDepartment[d];
    master += `## ${d} (${pages.length})\n\n`;
    let deptDoc = `# ${d} index (${pages.length} pages)\n\n| Title | Path | Tags | Behaviors | Updated |\n|---|---|---|---|---|\n`;
    for (const p of pages) {
      master += `- [${p.title}](../wiki/${p.relPath})\n`;
      deptDoc += `| [${p.title}](../wiki/${p.relPath}) | ${p.relPath} | ${p.tags.join(', ')} | ${p.behaviors.join(', ')} | ${p.updated} |\n`;
    }
    master += '\n';
    fs.writeFileSync(path.join(outDir, `${d}-index.md`), deptDoc);
  }
  fs.writeFileSync(path.join(outDir, 'INDEX.md'), master);
  console.log('indexes rebuilt');
}

module.exports = { buildIndex };
if (require.main === module) writeIndexes(path.join(__dirname, '..'));
