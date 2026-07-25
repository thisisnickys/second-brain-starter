'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { localDate } = require('../lib/date.js');
const ROOT = path.join(__dirname, '..', '..');

function catalogFolder(rootPath, label, department, opts) {
  const excludeDirs = new Set(opts.excludeDirs || []);
  const excludeFiles = (opts.excludeFiles || []).map(p => new RegExp(p));
  const entries = [];
  function walk(dir) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; } // unreadable subdir — skip
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!excludeDirs.has(it.name) && !it.name.startsWith('.')) walk(p);
      } else if (it.isFile()) {
        if (excludeFiles.some(re => re.test(it.name))) continue;
        let st;
        try { st = fs.statSync(p); } catch (e) { continue; }
        entries.push({
          name: it.name,
          relPath: path.relative(rootPath, p).split(path.sep).join('/'),
          root: label,
          department,
          ext: path.extname(it.name).toLowerCase().replace(/^\./, ''),
          size: st.size,
          mtime: localDate(st.mtime),
        });
      }
    }
  }
  walk(rootPath);
  return entries;
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-folders.json'), 'utf8'));
  const all = [];
  const rootStatus = {};
  for (const r of cfg.roots) {
    const abs = r.path.replace(/^~/, os.homedir());
    if (!fs.existsSync(abs)) { rootStatus[r.label] = 'skipped (not mounted)'; continue; }
    const entries = catalogFolder(abs, r.label, r.department,
      { excludeDirs: cfg.excludeDirs, excludeFiles: cfg.excludeFiles });
    all.push(...entries);
    rootStatus[r.label] = `${entries.length} files`;
  }
  const outDir = path.join(ROOT, 'indexes');
  fs.writeFileSync(path.join(outDir, 'files-catalog.json'),
    JSON.stringify({ generated: localDate(), roots: rootStatus, files: all }));
  let md = `# File Catalog\n\nRebuilt by system/ingest/file-catalog.js — asset locations, content not copied.\n\n`;
  for (const r of cfg.roots) md += `- **${r.label}**: ${rootStatus[r.label] || 'unknown'}\n`;
  const byExt = {};
  for (const e of all) byExt[e.ext || '(none)'] = (byExt[e.ext || '(none)'] || 0) + 1;
  md += `\n## By type\n\n| Ext | Count |\n|---|---|\n`;
  for (const [ext, n] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 30))
    md += `| ${ext} | ${n} |\n`;
  fs.writeFileSync(path.join(outDir, 'files-index.md'), md);
  console.log(`file-catalog: ${all.length} files across ${Object.keys(rootStatus).length} roots`);
}

module.exports = { catalogFolder };
if (require.main === module) main();
