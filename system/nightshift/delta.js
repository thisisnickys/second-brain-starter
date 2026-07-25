'use strict';
// What changed today? git log (committed by the 2:30am ingest) + porcelain
// (uncommitted — matters for midday --dry-run taste tests).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseFrontmatter } = require('../lib/frontmatter.js');

const KEEP_RE = /^(wiki\/.+\.md|tasks\/tasks\.md)$/;

function parseChangedPaths(gitLogText, porcelainText) {
  const out = [];
  const seen = new Set();
  const push = p => {
    const rel = String(p || '').trim();
    if (rel && KEEP_RE.test(rel) && !seen.has(rel)) { seen.add(rel); out.push(rel); }
  };
  for (const line of String(gitLogText || '').split('\n')) push(line);
  for (const line of String(porcelainText || '').split('\n')) {
    const t = line.slice(3).trim(); // strip the two-char status + space
    push(t.includes(' -> ') ? t.split(' -> ').pop() : t);
  }
  return out;
}

function defaultExec(rootDir) {
  return (cmd, args) => {
    try { return String(execFileSync(cmd, args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (err) { console.error(`delta: git ${args.find(a => !a.startsWith('-') && a !== 'core.quotePath=off')} failed: ${err.message}`); return ''; }
  };
}

function gatherDelta({ rootDir, sinceHours = 26, exec }) {
  const run = exec || defaultExec(rootDir);
  // -c core.quotePath=off: git quotes/escapes non-ASCII paths by default
  // (wiki titles carry em-dashes and emoji), which would break KEEP_RE matching.
  const gitLog = run('git', ['-c', 'core.quotePath=off', 'log', `--since=${sinceHours} hours ago`, '--name-only', '--pretty=format:']);
  const porcelain = run('git', ['-c', 'core.quotePath=off', 'status', '--porcelain']);
  const paths = parseChangedPaths(gitLog, porcelain);
  const notes = [];
  for (const rel of paths) {
    if (!rel.startsWith('wiki/')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(rootDir, rel), 'utf8'); } catch (err) { continue; }
    const fm = parseFrontmatter(text);
    if (!fm || !fm.data || !fm.data.title) continue;
    notes.push({ path: rel, title: fm.data.title, department: fm.data.department || '', type: fm.data.type || '', updated: fm.data.updated || '' });
  }
  return { paths, notes };
}

module.exports = { parseChangedPaths, gatherDelta };
