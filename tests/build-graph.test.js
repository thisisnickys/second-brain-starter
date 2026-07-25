const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGraph } = require('../system/build-graph.js');

function mkBrain() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
  fs.mkdirSync(path.join(tmp, 'wiki', 'content'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'a.md'),
`---
title: Retention Playbook
department: content
tags: [retention, avd]
behaviors: [create]
updated: 2026-07-06
---
# Retention Playbook

## Intro rules
See [Launch Rules](../content/b.md).
`);
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'b.md'),
`---
title: Launch Rules
department: content
tags: []
behaviors: []
type: decision
updated: 2026-07-06
---
# Launch Rules
`);
  fs.writeFileSync(path.join(tmp, 'tasks', 'tasks.md'),
`# Tasks

## Active
- [ ] verify token savings | due:none | src:apply | behaviors:learn | link:wiki/content/a.md

## Proposed (confirm or kill)
`);
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.mkdirSync(path.join(skills, 'yt'));
  fs.writeFileSync(path.join(skills, 'yt', 'SKILL.md'),
`---
name: yt
description: YouTube agent team for launch diagnosis and packaging
---
Body`);
  return { tmp, skills };
}

test('buildGraph emits file, decision, task, skill, app, routine nodes', () => {
  const { tmp, skills } = mkBrain();
  const os1 = path.join(tmp, 'agentic-os.json');
  fs.writeFileSync(os1, JSON.stringify({ apps: [{ id: 'app:notion', title: 'Notion', via: 'MCP' }], routines: [{ id: 'routine:x', title: 'X', schedule: 'manual' }] }));
  const g = buildGraph(tmp, { skillsDir: skills, osConfigPath: os1 });
  const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  const a = byId['wiki/content/a.md'];
  assert.strictEqual(a.type, 'file');
  assert.strictEqual(a.arms, 'memory');
  assert.ok(a.keywords.includes('retention'));
  assert.ok(a.keywords.includes('intro'));            // from heading
  assert.deepStrictEqual(a.links, ['wiki/content/b.md']); // resolved relative link
  assert.strictEqual(byId['wiki/content/b.md'].type, 'decision');
  const task = g.nodes.find(n => n.type === 'task');
  assert.match(task.title, /verify token savings/);
  assert.deepStrictEqual(task.links, ['wiki/content/a.md']);
  assert.strictEqual(byId['skill:yt'].arms, 'skills');
  assert.ok(byId['skill:yt'].keywords.includes('youtube'));
  assert.strictEqual(byId['app:notion'].arms, 'applications');
  assert.strictEqual(byId['routine:x'].arms, 'routines');
});

test('task lines with extra spaces around pipes still parse', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph2-'));
  fs.mkdirSync(path.join(tmp, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tasks', 'tasks.md'),
`# Tasks

## Active
- [ ] sloppy task  |  due:none |  src:manual |behaviors:none | link:none
`);
  const os1 = path.join(tmp, 'os.json');
  fs.writeFileSync(os1, JSON.stringify({ apps: [], routines: [] }));
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'sk2-'));
  const g = buildGraph(tmp, { skillsDir: skills, osConfigPath: os1 });
  const task = g.nodes.find(n => n.type === 'task');
  assert.ok(task, 'task node parsed despite sloppy spacing');
  assert.strictEqual(task.title.trim(), 'sloppy task');
});

function mkEnriched() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-enrich-'));
  fs.mkdirSync(path.join(root, 'wiki', 'content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', 'content', 'a.md'),
`---
title: How I retrieve
department: content
tags: []
behaviors: []
type: file
updated: 2026-07-07
---
# How I retrieve

I use /brain to search, and Limitless captures my voice notes.
`);
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-e-'));
  fs.mkdirSync(path.join(skillsDir, 'brain'));
  fs.writeFileSync(path.join(skillsDir, 'brain', 'SKILL.md'),
`---
name: brain
description: Retrieve answers from the second brain using deterministic index search.
---
# Brain
`);
  const osConfigPath = path.join(root, 'os.json');
  fs.writeFileSync(osConfigPath, JSON.stringify({
    apps: [{ id: 'app:limitless', title: 'Limitless AI', via: 'MCP' }], routines: [],
  }));
  return { root, skillsDir, osConfigPath, tasksPath: path.join(root, 'none.md') };
}

test('skill nodes carry a readable description + how-to-run', () => {
  const e = mkEnriched();
  const { nodes } = buildGraph(e.root, e);
  const brain = nodes.find(n => n.id === 'skill:brain');
  assert.match(brain.desc, /Retrieve answers from the second brain/);
  assert.match(brain.desc, /\/brain/);
});

test('tool nodes carry a purpose blurb', () => {
  const e = mkEnriched();
  const { nodes } = buildGraph(e.root, e);
  assert.match(nodes.find(n => n.id === 'app:limitless').desc, /connected tool/);
});

test('wiki pages that reference a skill (/name) or a named tool link to it', () => {
  const e = mkEnriched();
  const { nodes } = buildGraph(e.root, e);
  const page = nodes.find(n => n.id === 'wiki/content/a.md');
  assert.ok(page.links.includes('skill:brain'), 'links the /brain skill it mentions');
  assert.ok(page.links.includes('app:limitless'), 'links the Limitless tool it names');
});

test('an unreferenced skill still gets content, even if it stays unlinked', () => {
  const e = mkEnriched();
  fs.mkdirSync(path.join(e.skillsDir, 'obscure-skill'));
  fs.writeFileSync(path.join(e.skillsDir, 'obscure-skill', 'SKILL.md'),
    `---\nname: obscure-skill\ndescription: Nobody references this.\n---\n# x\n`);
  const { nodes } = buildGraph(e.root, e);
  assert.match(nodes.find(n => n.id === 'skill:obscure-skill').desc, /Nobody references this/);
});
