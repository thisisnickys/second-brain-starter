const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { handleApi, createServer } = require('../system/viz-server.js');

// Raw HTTP client so we can set a custom Host header (fetch forbids it).
function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function startServer(root) {
  const server = createServer(root, 0);
  await new Promise(r => server.once('listening', r));
  return { server, port: server.address().port };
}

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  fs.mkdirSync(path.join(tmp, 'wiki', 'content'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wiki', 'content', 'a.md'),
`---
title: A
department: content
tags: []
behaviors: []
updated: 2026-07-07
---
# A

body
`);
  fs.writeFileSync(path.join(tmp, 'tasks', 'tasks.md'),
`# Tasks

## Active
- [ ] t-one | due:none | src:manual | behaviors:none | link:none

## Proposed (confirm or kill)
- [ ] t-two | due:none | src:limitless | behaviors:none | link:none
`);
  return tmp;
}

test('ping ok', async () => {
  const r = await handleApi({ method: 'GET', url: '/api/ping', body: null }, mkRoot());
  assert.deepStrictEqual(r, { status: 200, json: { ok: true } });
});

test('file read + path traversal rejected', async () => {
  const root = mkRoot();
  const ok = await handleApi({ method: 'GET', url: '/api/file?id=wiki/content/a.md', body: null }, root);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.json.content, /body/);
  const bad = await handleApi({ method: 'GET', url: '/api/file?id=../../../etc/passwd', body: null }, root);
  assert.strictEqual(bad.status, 400);
});

test('save writes only lint-valid content, restores on invalid', async () => {
  const root = mkRoot();
  const good = await handleApi({ method: 'POST', url: '/api/save',
    body: { id: 'wiki/content/a.md', content: `---\ntitle: A\ndepartment: content\ntags: []\nbehaviors: []\nupdated: 2026-07-07\n---\n# A\n\nedited body\n` } }, root);
  assert.strictEqual(good.status, 200);
  assert.match(fs.readFileSync(path.join(root, 'wiki/content/a.md'), 'utf8'), /edited body/);
  const bad = await handleApi({ method: 'POST', url: '/api/save',
    body: { id: 'wiki/content/a.md', content: `---\ntitle: A\ndepartment: NOPE\ntags: []\nbehaviors: []\nupdated: 2026-07-07\n---\nx` } }, root);
  assert.strictEqual(bad.status, 422);
  assert.match(fs.readFileSync(path.join(root, 'wiki/content/a.md'), 'utf8'), /edited body/); // restored
});

test('tasks list + done moves to archive', async () => {
  const root = mkRoot();
  const list = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root);
  assert.strictEqual(list.json.active.length, 1);
  assert.strictEqual(list.json.proposed.length, 1);
  const done = await handleApi({ method: 'POST', url: '/api/task', body: { op: 'done', idx: list.json.active[0].idx } }, root);
  assert.strictEqual(done.status, 200);
  const after = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root);
  assert.strictEqual(after.json.active.length, 0);
  const archive = fs.readFileSync(path.join(root, 'tasks', 'archive', new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '.md'), 'utf8');
  assert.match(archive, /t-one.*done:/);
});

test('file read on a directory rejected (no throw)', async () => {
  const root = mkRoot();
  // handleApi must resolve (not reject/throw) even though the target is a directory.
  const r = await handleApi({ method: 'GET', url: '/api/file?id=wiki/content', body: null }, root);
  assert.strictEqual(r.status, 400);
});

test('symlink escape rejected', async () => {
  const root = mkRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'wiki', 'content', 'escape'));
  const r = await handleApi({ method: 'GET', url: '/api/file?id=wiki/content/escape/secret.txt', body: null }, root);
  assert.strictEqual(r.status, 400);
});

test('missing tasks.md returns empty arrays', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-notasks-'));
  fs.mkdirSync(path.join(tmp, 'wiki', 'content'), { recursive: true });
  // Note: no tasks/ dir created at all.
  const r = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, tmp);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { active: [], proposed: [] });
});

test('task kill archives with killed: stamp, confirm moves proposed to active', async () => {
  const root = mkRoot();
  const list = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root);
  const proposedIdx = list.json.proposed[0].idx;

  const kill = await handleApi({ method: 'POST', url: '/api/task', body: { op: 'kill', idx: proposedIdx } }, root);
  assert.strictEqual(kill.status, 200);
  const archive = fs.readFileSync(path.join(root, 'tasks', 'archive', new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '.md'), 'utf8');
  assert.match(archive, /t-two.*killed:/);
  const afterKill = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root);
  assert.strictEqual(afterKill.json.proposed.length, 0);

  const root2 = mkRoot();
  const list2 = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root2);
  const proposedIdx2 = list2.json.proposed[0].idx;
  const confirm = await handleApi({ method: 'POST', url: '/api/task', body: { op: 'confirm', idx: proposedIdx2 } }, root2);
  assert.strictEqual(confirm.status, 200);
  const afterConfirm = await handleApi({ method: 'GET', url: '/api/tasks', body: null }, root2);
  assert.strictEqual(afterConfirm.json.proposed.length, 0);
  assert.strictEqual(afterConfirm.json.active.length, 2);
  assert.ok(afterConfirm.json.active.some(a => /t-two/.test(a.line)));
});

test('server survives malformed URL and keeps serving', async () => {
  const root = mkRoot();
  const server = createServer(root, 0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const badRes = await fetch(`http://127.0.0.1:${port}/%`);
    assert.strictEqual(badRes.status, 400);
    const pingRes = await fetch(`http://127.0.0.1:${port}/api/ping`);
    assert.strictEqual(pingRes.status, 200);
    const pingJson = await pingRes.json();
    assert.deepStrictEqual(pingJson, { ok: true });
  } finally {
    server.close();
  }
});

test('rejects a non-loopback Host header (DNS-rebind guard)', async () => {
  const { server, port } = await startServer(mkRoot());
  try {
    const bad = await httpReq({ host: '127.0.0.1', port, path: '/api/ping', method: 'GET', headers: { Host: 'evil.example.com' } });
    assert.strictEqual(bad.status, 403);
    const ok = await httpReq({ host: '127.0.0.1', port, path: '/api/ping', method: 'GET', headers: { Host: '127.0.0.1:' + port } });
    assert.strictEqual(ok.status, 200);
  } finally { server.close(); }
});

test('POST to /api requires application/json content-type (CSRF guard)', async () => {
  const { server, port } = await startServer(mkRoot());
  try {
    const noct = await httpReq({ host: '127.0.0.1', port, path: '/api/task', method: 'POST', headers: { Host: '127.0.0.1:' + port, 'Content-Type': 'text/plain' } }, '{"op":"done","idx":3}');
    assert.strictEqual(noct.status, 415);
    // Correct content-type is accepted and processed (bad idx → 400, i.e. it got past the guard).
    const withct = await httpReq({ host: '127.0.0.1', port, path: '/api/task', method: 'POST', headers: { Host: '127.0.0.1:' + port, 'Content-Type': 'application/json' } }, '{"op":"done","idx":9999}');
    assert.strictEqual(withct.status, 400);
  } finally { server.close(); }
});

test('static route serves only viz/wiki/raw, never system/ or repo-root files', async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 's.js'), 'secret code');
  fs.writeFileSync(path.join(root, 'secret-config'), 'TOKEN=xyz');
  const { server, port } = await startServer(root);
  try {
    const wiki = await fetch(`http://127.0.0.1:${port}/wiki/content/a.md`);
    assert.strictEqual(wiki.status, 200);
    const sys = await fetch(`http://127.0.0.1:${port}/system/s.js`);
    assert.strictEqual(sys.status, 404);
    const cfg = await fetch(`http://127.0.0.1:${port}/secret-config`);
    assert.strictEqual(cfg.status, 404);
  } finally { server.close(); }
});

test('static route denies a symlink escaping the served roots', async () => {
  const root = mkRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside2-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'wiki', 'content', 'escape'));
  const { server, port } = await startServer(root);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wiki/content/escape/secret.txt`);
    assert.strictEqual(r.status, 404);
  } finally { server.close(); }
});
