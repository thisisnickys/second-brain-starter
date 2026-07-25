'use strict';
// One-time TickTick OAuth2 (authorization-code) helper.
// Reads TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET from .env, prints an
// authorize URL, catches the redirect on localhost:8080/callback, exchanges the
// code for an access token, and writes TICKTICK_ACCESS_TOKEN back to .env.
// The secret and token are never printed.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const REDIRECT = 'http://localhost:8080/callback';
const SCOPE = 'tasks:write tasks:read';
const AUTH_URL = 'https://ticktick.com/oauth/authorize';
const TOKEN_URL = 'https://ticktick.com/oauth/token';

function parseEnv(text) {
  const o = {};
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
function readEnv() { return fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {}; }
function upsertEnv(key, val) {
  let lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  let found = false;
  lines = lines.map(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)=/);
    if (m && m[1] === key) { found = true; return `${key}=${val}`; }
    return l;
  });
  if (!found) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); lines.push(`${key}=${val}`); }
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

function exchange(cid, sec, code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, scope: SCOPE, redirect_uri: REDIRECT,
      client_id: cid, client_secret: sec,
    }).toString();
    const basic = Buffer.from(`${cid}:${sec}`).toString('base64');
    const req = https.request(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function main() {
  const env = readEnv();
  const cid = env.TICKTICK_CLIENT_ID, sec = env.TICKTICK_CLIENT_SECRET;
  if (!cid || !sec) { console.error('Missing TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET in .env — add them first.'); process.exit(1); }
  const state = crypto.randomBytes(8).toString('hex');
  const authorizeUrl = `${AUTH_URL}?scope=${encodeURIComponent(SCOPE)}&client_id=${encodeURIComponent(cid)}&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;

  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url, 'http://localhost:8080'); } catch (e) { res.writeHead(400); res.end('bad'); return; }
    if (u.pathname !== '/callback') { res.writeHead(404); res.end('not found'); return; }
    if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end('state mismatch — restart the auth helper.'); return; }
    const code = u.searchParams.get('code');
    if (!code) { res.writeHead(400); res.end('no code in redirect'); return; }
    try {
      const raw = await exchange(cid, sec, code);
      const j = JSON.parse(raw);
      if (j.access_token) {
        upsertEnv('TICKTICK_ACCESS_TOKEN', j.access_token);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif">TickTick connected ✓</h2><p style="font-family:sans-serif">Token saved. You can close this tab.</p>');
        console.log('SUCCESS: TICKTICK_ACCESS_TOKEN saved to .env.');
        setTimeout(() => { server.close(); process.exit(0); }, 400);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Token exchange did not return an access_token. Check the redirect URI matches exactly.');
        console.error('EXCHANGE FAILED (no access_token). Raw response length:', raw.length);
        console.error('Response (may indicate the error):', raw.slice(0, 300));
      }
    } catch (e) {
      res.writeHead(500); res.end('exchange error');
      console.error('EXCHANGE ERROR:', e.message);
    }
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('Port 8080 is in use — close whatever is using it and retry.');
    else console.error('Server error:', e.message);
    process.exit(1);
  });
  server.listen(8080, () => {
    console.log('\n=== TickTick authorization ===');
    console.log('Open this URL in your browser, log in, and click Allow:\n');
    console.log(authorizeUrl);
    console.log('\nWaiting for the redirect… (this will save the token to .env automatically)\n');
  });
}
main();
