'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { parseFrontmatter, validatePage } = require('./lib/frontmatter.js');
const DEFAULT_ROOT = path.join(__dirname, '..');

function safeWikiPath(rootDir, id) {
  if (typeof id !== 'string') return null;
  const abs = path.resolve(rootDir, id);
  const wiki = path.resolve(rootDir, 'wiki') + path.sep;
  const raw = path.resolve(rootDir, 'raw') + path.sep;
  if (!abs.startsWith(wiki) && !abs.startsWith(raw)) return null;

  // Symlink-escape containment check: the REAL (post-symlink-resolution) path
  // must still land inside the real wiki/ or raw/ roots.
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realWiki = path.join(realRoot, 'wiki') + path.sep;
    const realRaw = path.join(realRoot, 'raw') + path.sep;
    const contained = (p) =>
      p === realWiki.slice(0, -1) || p.startsWith(realWiki) ||
      p === realRaw.slice(0, -1) || p.startsWith(realRaw);

    if (fs.existsSync(abs)) {
      if (!contained(fs.realpathSync(abs))) return null;
    } else {
      // New file (e.g. a save target that doesn't exist yet): walk up to the
      // deepest existing ancestor directory and check that instead.
      let dir = path.dirname(abs);
      while (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent === dir) break; // hit filesystem root; bail safely below
        dir = parent;
      }
      if (!contained(fs.realpathSync(dir))) return null;
    }
  } catch (e) {
    return null;
  }

  return abs;
}

function localStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseTasks(rootDir) {
  const p = path.join(rootDir, 'tasks', 'tasks.md');
  if (!fs.existsSync(p)) return { p, lines: [], active: [], proposed: [] };
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const active = [], proposed = [];
  let section = null;
  lines.forEach((line, idx) => {
    if (/^## Active/.test(line)) section = 'active';
    else if (/^## Proposed/.test(line)) section = 'proposed';
    else if (/^- \[ \] /.test(line)) {
      if (section === 'active') active.push({ line, idx });
      if (section === 'proposed') proposed.push({ line, idx });
    }
  });
  return { p, lines, active, proposed };
}

async function handleApi(req, rootDir) {
  rootDir = rootDir || DEFAULT_ROOT;
  const u = new URL(req.url, 'http://x');
  const route = req.method + ' ' + u.pathname;

  if (route === 'GET /api/ping') return { status: 200, json: { ok: true } };

  if (route === 'GET /api/file') {
    const abs = safeWikiPath(rootDir, u.searchParams.get('id'));
    if (!abs || !fs.existsSync(abs)) return { status: 400, json: { error: 'bad path' } };
    if (!fs.statSync(abs).isFile()) return { status: 400, json: { error: 'bad path' } };
    return { status: 200, json: { content: fs.readFileSync(abs, 'utf8') } };
  }

  if (route === 'POST /api/save') {
    const { id, content } = req.body || {};
    const abs = safeWikiPath(rootDir, id);
    const wikiRoot = path.resolve(rootDir, 'wiki') + path.sep;
    if (!abs || !abs.startsWith(wikiRoot)) return { status: 400, json: { error: 'bad path' } };
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    const { data, errors } = parseFrontmatter(String(content));
    const errs = errors.concat(validatePage(data));
    if (errs.length) return { status: 422, json: { error: 'lint: ' + errs.join('; ') } };
    fs.writeFileSync(abs, String(content));
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'lint-frontmatter.js'), path.join(rootDir, 'wiki')], { stdio: 'pipe' });
    } catch (e) {
      if (prev !== null) fs.writeFileSync(abs, prev);
      return { status: 422, json: { error: 'repo lint failed — save rolled back' } };
    }
    // Only rebuild the shared index/graph/viz artifacts when saving into the
    // real default root — never run repo-wide builder scripts against a
    // foreign/test root passed in via rootDir.
    if (path.resolve(rootDir) === path.resolve(DEFAULT_ROOT)) {
      for (const script of ['build-index.js', 'build-graph.js', 'build-viz.js'])
        try { execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'pipe' }); } catch (e) { /* non-fatal */ }
    }
    return { status: 200, json: { ok: true } };
  }

  if (route === 'POST /api/open') {
    const { id, reveal } = req.body || {};
    const abs = safeWikiPath(rootDir, id);
    if (!abs || !fs.existsSync(abs)) return { status: 400, json: { error: 'bad path' } };
    execFile('open', reveal ? ['-R', '--', abs] : ['-t', '--', abs]);
    return { status: 200, json: { ok: true } };
  }

  if (route === 'GET /api/tasks') {
    const { active, proposed } = parseTasks(rootDir);
    return { status: 200, json: { active, proposed } };
  }

  if (route === 'POST /api/task') {
    const { op, idx } = req.body || {};
    const t = parseTasks(rootDir);
    const line = t.lines[idx];
    if (typeof line !== 'string' || !/^- \[ \] /.test(line)) return { status: 400, json: { error: 'bad idx' } };
    const stamp = localStamp();
    if (op === 'done' || op === 'kill') {
      const marked = line.replace('- [ ]', '- [x]') + ` | ${op === 'done' ? 'done' : 'killed'}:${stamp}`;
      const archDir = path.join(rootDir, 'tasks', 'archive');
      fs.mkdirSync(archDir, { recursive: true });
      const archFile = path.join(archDir, stamp.slice(0, 7) + '.md');
      if (!fs.existsSync(archFile)) fs.writeFileSync(archFile, `# Archive ${stamp.slice(0, 7)}\n\n`);
      fs.appendFileSync(archFile, marked + '\n');
      t.lines.splice(idx, 1);
    } else if (op === 'confirm') {
      t.lines.splice(idx, 1);
      const ai = t.lines.findIndex(l => /^## Active/.test(l));
      t.lines.splice(ai + 1, 0, line);
    } else return { status: 400, json: { error: 'bad op' } };
    fs.writeFileSync(t.p, t.lines.join('\n'));
    return { status: 200, json: { ok: true } };
  }

  return { status: 404, json: { error: 'not found' } };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function createServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      // DNS-rebinding / cross-origin guard: only accept requests addressed to the loopback host.
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden host' })); return; }
      if (u.pathname.startsWith('/api/')) {
        // Require JSON on writes so a cross-origin page can't do a no-preflight "simple" POST (CSRF).
        if (req.method === 'POST' && (req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
          res.writeHead(415, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'content-type must be application/json' })); return;
        }
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
        req.on('end', async () => {
          try {
            let body = null;
            try { body = raw ? JSON.parse(raw) : null; } catch (e) { /* ignore */ }
            const out = await handleApi({ method: req.method, url: req.url, body }, rootDir);
            res.writeHead(out.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out.json));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
          }
        });
        return;
      }
      // static: serve ONLY the viz/, wiki/, raw/ trees — never system/, indexes/, .env, etc.
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/' || rel === '/index.html') rel = '/viz/index.html';
      if (rel === '/data.js') rel = '/viz/data.js';
      if (!/^\/(viz|wiki|raw)\//.test(rel)) { res.writeHead(404); res.end('not found'); return; }
      const abs = path.resolve(rootDir, '.' + rel);
      const lexRoots = ['viz', 'wiki', 'raw'].map(d => path.resolve(rootDir, d) + path.sep);
      if (!lexRoots.some(a => abs.startsWith(a)) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      // Symlink-escape containment against the REAL roots (macOS /tmp→/private/tmp, etc.).
      let real, realRoots;
      try {
        real = fs.realpathSync(abs);
        const realRoot = fs.realpathSync(rootDir);
        realRoots = ['viz', 'wiki', 'raw'].map(d => path.join(realRoot, d) + path.sep);
      } catch (e) { res.writeHead(404); res.end('not found'); return; }
      if (!realRoots.some(a => real.startsWith(a))) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(fs.readFileSync(abs));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { handleApi, createServer };
if (require.main === module) {
  const port = Number((process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1]) || 4321;
  createServer(DEFAULT_ROOT, port);
  console.log(`brain viz workbench: http://127.0.0.1:${port}  (Ctrl-C to stop)`);
  if (process.argv.includes('--open')) execFile('open', [`http://127.0.0.1:${port}`]);
}
