'use strict';
const fs = require('fs');
const path = require('path');
const { parseFrontmatter, DEPARTMENTS } = require('./lib/frontmatter.js');
const { tokenize } = require('./lib/text.js');
const { localDate } = require('./lib/date.js');

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Returns { nodes, hays } where hays[i] = { id, hay } is a lowercased search
// haystack (title + tags + body) used to connect skill/tool nodes to the wiki
// pages that reference them.
function wikiNodes(rootDir) {
  const wikiDir = path.join(rootDir, 'wiki');
  const nodes = [], hays = [];
  for (const file of walk(wikiDir)) {
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    if (!DEPARTMENTS.includes(data.department)) continue;
    const id = 'wiki/' + path.relative(wikiDir, file).split(path.sep).join('/');
    const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1]);
    const keywords = tokenize([data.title, ...(data.tags || []), ...headings].join(' ')).slice(0, 30);
    const links = [];
    for (const m of body.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(id), m[1]));
      if (resolved.startsWith('wiki/') && !links.includes(resolved)) links.push(resolved);
    }
    nodes.push({ id, type: data.type === 'decision' ? 'decision' : (data.type === 'person' ? 'person' : 'file'),
      title: data.title, department: data.department, arms: 'memory',
      behaviors: data.behaviors || [], keywords, links, updated: data.updated });
    hays.push({ id, hay: [data.title, (data.tags || []).join(' '), body].join(' ').toLowerCase() });
  }
  return { nodes, hays };
}

function taskNodes(tasksPath) {
  if (!fs.existsSync(tasksPath)) return [];
  const nodes = [];
  let n = 0;
  for (const line of fs.readFileSync(tasksPath, 'utf8').split('\n')) {
    const m = line.match(/^- \[ \] (.+?)\s*\|\s*due:(\S+)\s*\|\s*src:(\S+)\s*\|\s*behaviors:(\S+)\s*\|\s*link:(\S+)/);
    if (!m) continue;
    n++;
    nodes.push({ id: `task:${n}`, type: 'task', title: m[1], department: null, arms: 'memory',
      behaviors: m[4] === 'none' ? [] : m[4].split(','),
      keywords: tokenize(m[1]).slice(0, 15),
      links: m[5] === 'none' ? [] : [m[5]], updated: m[2] === 'none' ? null : m[2] });
  }
  return nodes;
}

// Collapse a frontmatter description (may be a folded multi-line block) to one
// readable line, capped so the drawer stays tight.
function oneLine(s, cap) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap).replace(/\s+\S*$/, '') + '…' : t;
}

function skillNodes(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const nodes = [];
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let p = path.join(skillsDir, e.name, 'SKILL.md');
    if (!fs.existsSync(p)) p = path.join(skillsDir, e.name, 'skill.md');
    if (!fs.existsSync(p)) continue;
    const { data } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
    const name = data.name || e.name;
    const desc = oneLine(data.description, 500);
    nodes.push({ id: `skill:${name}`, type: 'skill', title: name,
      department: null, arms: 'skills', behaviors: [],
      keywords: tokenize(desc).slice(0, 20), links: [], updated: null,
      desc: `**/${name}** — Claude Code skill\n\n${desc || 'No description set in SKILL.md.'}\n\n_Run it in Claude Code with_ \`/${name}\`.` });
  }
  return nodes;
}

function osNodes(osConfigPath) {
  if (!fs.existsSync(osConfigPath)) return [];
  const cfg = JSON.parse(fs.readFileSync(osConfigPath, 'utf8'));
  const nodes = [];
  for (const a of cfg.apps || [])
    nodes.push({ id: a.id, type: 'app', title: a.title, department: null, arms: 'applications',
      behaviors: [], keywords: tokenize(`${a.title} ${a.via || ''}`), links: a.links || [], updated: null,
      desc: `**${a.title}** — connected tool\n\nIntegrated via ${a.via || 'MCP'}. Part of the owner's agentic OS; the brain can read and act through it.` });
  for (const r of cfg.routines || [])
    nodes.push({ id: r.id, type: 'routine', title: r.title, department: null, arms: 'routines',
      behaviors: [], keywords: tokenize(`${r.title} ${r.schedule || ''}`), links: r.links || [], updated: null,
      desc: `**${r.title}** — automated routine\n\nSchedule: ${r.schedule || 'manual'}.` });
  return nodes;
}

// Connect otherwise-orphan skill/tool nodes to the wiki pages that reference
// them, so they stop being dead-end dots. Skills match on their invocation form
// `/name` (precise); tools/routines match a distinctive title token (len ≥ 7)
// to avoid linking on common words.
function connectReferences(wikiById, hays, refNodes) {
  for (const n of refNodes) {
    let needle, distinctive = null;
    if (n.type === 'skill') needle = '/' + n.id.slice('skill:'.length);
    else {
      const tok = String(n.title).toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 7)[0];
      distinctive = tok ? new RegExp('\\b' + tok + '\\b') : null;
      needle = null;
    }
    for (const { id, hay } of hays) {
      const w = wikiById[id];
      if (!w || w.links.length >= 14) continue;
      const hit = needle ? hay.includes(needle) : (distinctive && distinctive.test(hay));
      if (hit && !w.links.includes(n.id)) w.links.push(n.id);
    }
  }
}

function buildGraph(rootDir, opts = {}) {
  const skillsDir = opts.skillsDir || path.join(process.env.HOME || '', '.claude', 'skills');
  const osConfigPath = opts.osConfigPath || path.join(__dirname, 'graph', 'agentic-os.json');
  const tasksPath = opts.tasksPath || path.join(rootDir, 'tasks', 'tasks.md');
  const { nodes: wiki, hays } = wikiNodes(rootDir);
  const tasks = taskNodes(tasksPath);
  const skills = skillNodes(skillsDir);
  const os = osNodes(osConfigPath);
  const wikiById = {};
  for (const w of wiki) wikiById[w.id] = w;
  connectReferences(wikiById, hays, [...skills, ...os]);
  return { nodes: [...wiki, ...tasks, ...skills, ...os] };
}

function main() {
  const root = path.join(__dirname, '..');
  const { nodes } = buildGraph(root);
  const counts = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  fs.mkdirSync(path.join(root, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'indexes', 'graph.json'),
    JSON.stringify({ generated: localDate(), counts, catalogRef: 'files-catalog.json', nodes }));
  console.log(`graph: ${nodes.length} nodes (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')})`);
}

module.exports = { buildGraph };
if (require.main === module) main();
