'use strict';
const fs = require('fs');
const path = require('path');
const { localDate } = require('./lib/date.js');
const { CONFIG } = require('./lib/config.js');
const { parseFrontmatter } = require('./lib/frontmatter.js');
const ROOT = path.join(__dirname, '..');

const CONTENT_CAP = 15000;

const W = 1600, H = 1000;
const GOLDEN = 2.399963229728653;

// deterministic spiral placement around a center, index-ordered
function spiral(center, i, spread) {
  const r = spread * Math.sqrt(i + 1);
  const a = (i + 1) * GOLDEN;
  return [Math.round(center[0] + r * Math.cos(a)), Math.round(center[1] + r * Math.sin(a))];
}

function clamp(p) {
  return [Math.min(W - 20, Math.max(20, p[0])), Math.min(H - 20, Math.max(20, p[1]))];
}

// Department clusters are laid out from the config list, so renaming or
// reordering departments in brain.config.json just moves the clusters —
// no coordinates to hand-edit.
const DEPT_CENTERS = (() => {
  const grid = [[400, 300], [1200, 300], [400, 720], [1200, 720], [800, 180], [800, 860]];
  const out = { _none: [800, 510] };
  CONFIG.departments.forEach((d, i) => { out[d] = grid[i % grid.length]; });
  return out;
})();
const BEHAVIOR_CENTERS = {
  move: [800, 180], breathe: [1310, 500], create: [1080, 860],
  learn: [520, 860], connect: [290, 500], _untagged: [800, 520],
};
const ARMS_RINGS = { memory: 190, skills: 330, routines: 430, applications: 520 };
const CENTER = [800, 500];

function worldElementFor(node, map) {
  const hay = `${node.id} ${(node.keywords || []).join(' ')}`.toLowerCase();
  for (const rule of map.rules || [])
    if (new RegExp(rule.match, 'i').test(hay)) return rule.element;
  if (map.typeDefaults && map.typeDefaults[node.type]) return map.typeDefaults[node.type];
  if (node.department && map.departmentDefaults && map.departmentDefaults[node.department])
    return map.departmentDefaults[node.department];
  return Object.keys(map.elements)[0];
}

function computePositions(nodes, assetRoots, worldMap) {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const counters = { dep: {}, beh: {}, world: {} };
  const armsGroups = {};
  for (const n of sorted) (armsGroups[n.arms || 'memory'] = armsGroups[n.arms || 'memory'] || []).push(n);

  const out = sorted.map(n => {
    const depKey = n.department || '_none';
    const di = counters.dep[depKey] = (counters.dep[depKey] || 0) + 1;
    const behKey = (n.behaviors && n.behaviors[0]) || '_untagged';
    const bi = counters.beh[behKey] = (counters.beh[behKey] || 0) + 1;
    const el = worldElementFor(n, worldMap);
    const wi = counters.world[el] = (counters.world[el] || 0) + 1;
    const ring = ARMS_RINGS[n.arms] || ARMS_RINGS.memory;
    const group = armsGroups[n.arms || 'memory'];
    const gi = group.indexOf(n);
    const angle = (gi / group.length) * 2 * Math.PI - Math.PI / 2;
    return { ...n, worldElement: el, pos: {
      departments: clamp(spiral(DEPT_CENTERS[depKey] || DEPT_CENTERS._none, di - 1, 26)),
      arms: clamp([Math.round(CENTER[0] + ring * Math.cos(angle)), Math.round(CENTER[1] + ring * 0.82 * Math.sin(angle))]),
      behaviors: clamp(spiral(BEHAVIOR_CENTERS[behKey] || BEHAVIOR_CENTERS._untagged, bi - 1, 24)),
      world: clamp(spiral(worldMap.elements[el] || [W / 2, H / 2], wi - 1, 20)),
    }};
  });

  const assetNodes = (assetRoots || []).map((r, i) => {
    const depKey = r.department || '_none';
    const di = counters.dep[depKey] = (counters.dep[depKey] || 0) + 1;
    return { kind: 'asset-root', id: `assets:${r.label}`, title: r.label, department: r.department,
      count: r.count, topExts: r.topExts, pos: {
        departments: clamp(spiral(DEPT_CENTERS[depKey] || DEPT_CENTERS._none, di - 1, 26)),
        arms: clamp(spiral(CENTER, i, 18)),
        behaviors: clamp(spiral(BEHAVIOR_CENTERS._untagged, i, 18)),
        world: clamp(spiral((worldMap.elements || {}).Territory || [W / 2, H / 2], 40 + i, 20)),
      }};
  });

  const lensMeta = {
    departments: Object.entries(DEPT_CENTERS).filter(([k]) => k !== '_none').map(([k, c]) => ({ label: k, at: c })),
    arms: Object.entries(ARMS_RINGS).map(([k, r]) => ({ label: k, ring: r, at: CENTER })),
    behaviors: Object.entries(BEHAVIOR_CENTERS).filter(([k]) => k !== '_untagged').map(([k, c]) => ({ label: k, at: c })),
    world: Object.entries(worldMap.elements || {}).map(([k, c]) => ({ label: k, at: c })),
  };
  return { nodes: out, assetNodes, lensMeta };
}

function buildDataNodes(graphNodes, rootDir) {
  const inboundMap = {};
  for (const n of graphNodes)
    for (const l of n.links || []) (inboundMap[l] = inboundMap[l] || []).push(n.id);
  return graphNodes.map(n => {
    let content = null;
    if (n.id.startsWith('wiki/')) {
      const p = path.join(rootDir, n.id);
      if (fs.existsSync(p)) {
        let body = parseFrontmatter(fs.readFileSync(p, 'utf8')).body.trim();
        if (body.length > CONTENT_CAP) body = body.slice(0, CONTENT_CAP) + '\n\n… (truncated — open in editor)';
        content = body;
      }
    } else if (n.desc) {
      content = n.desc;   // skill/tool/routine nodes carry a synthesized blurb
    }
    return { ...n, content, inbound: inboundMap[n.id] || [] };
  });
}

function assetDotArrays(files, rootsOrder, hubs) {
  const dep = [], arms = [], rootIdx = [];
  const counters = {};
  for (const f of files) {
    const ri = rootsOrder.indexOf(f.root);
    const i = counters[f.root] = (counters[f.root] || 0) + 1;
    const hub = hubs[f.root];
    // concentric dotted arcs: ring holds 22 + 8*ring dots
    let ring = 1, cap = 30, idx = i;
    while (idx > cap) { idx -= cap; ring++; cap = 22 + 8 * ring; }
    const rDep = 26 + ring * 13;
    const a = (idx / cap) * 2 * Math.PI + ring * 0.35;
    dep.push(Math.round(hub.departments[0] + rDep * Math.cos(a)), Math.round(hub.departments[1] + rDep * Math.sin(a)));
    const rArm = 20 + ring * 10;
    arms.push(Math.round(hub.arms[0] + rArm * Math.cos(a)), Math.round(hub.arms[1] + rArm * 0.7 * Math.sin(a)));
    rootIdx.push(ri);
  }
  return { departments: dep, arms, rootIdx };
}

function main() {
  const graph = JSON.parse(fs.readFileSync(path.join(ROOT, 'indexes', 'graph.json'), 'utf8'));
  let assetRoots = [];
  let catalogFiles = [];
  const catPath = path.join(ROOT, 'indexes', 'files-catalog.json');
  if (fs.existsSync(catPath)) {
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    catalogFiles = cat.files;
    const byRoot = {};
    for (const f of cat.files) {
      byRoot[f.root] = byRoot[f.root] || { label: f.root, department: f.department, count: 0, exts: {} };
      byRoot[f.root].count++;
      byRoot[f.root].exts[f.ext] = (byRoot[f.root].exts[f.ext] || 0) + 1;
    }
    assetRoots = Object.values(byRoot).map(r => ({ label: r.label, department: r.department, count: r.count,
      topExts: Object.entries(r.exts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e]) => e) }));
  }
  const worldMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'viz', 'world-map.json'), 'utf8'));
  const { nodes, assetNodes, lensMeta } = computePositions(graph.nodes, assetRoots, worldMap);
  const dataNodes = buildDataNodes(nodes, ROOT);
  const hubs = {};
  for (const an of assetNodes) hubs[an.title] = { departments: an.pos.departments, arms: an.pos.arms };
  const rootsOrder = assetRoots.map(r => r.label);
  const dots = catalogFiles.length > 0 ? assetDotArrays(catalogFiles, rootsOrder, hubs) : { departments: [], arms: [], rootIdx: [] };
  fs.mkdirSync(path.join(ROOT, 'viz'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'viz', 'data.js'),
    'window.BRAIN_DATA = ' + JSON.stringify({ generated: localDate(), counts: graph.counts, nodes: dataNodes, assetNodes, lensMeta }) + ';\n' +
    'window.BRAIN_ASSETS = ' + JSON.stringify({ roots: assetRoots.map((r, i) => ({ ...r, hub: hubs[r.label] })), dots }) + ';\n' +
    'window.BRAIN_CONFIG = ' + JSON.stringify({ owner: CONFIG.owner.name, departments: CONFIG.departments, departmentColors: CONFIG.departmentColors, customLensLabel: CONFIG.customLens.label, behaviorsLabel: CONFIG.behaviorsLabel }) + ';\n');
  console.log(`viz: ${dataNodes.length} nodes + ${catalogFiles.length} asset dots -> viz/data.js`);
}

module.exports = { computePositions, buildDataNodes, assetDotArrays };
if (require.main === module) main();
