'use strict';
// Second-brain health check. Deterministic, read-only, zero-dep.
// Run: node system/doctor.js [--json] [--tests]
// Exit 0 unless any check FAILS.
//
// Checks: .env integrity · launchd jobs · log error scan · index freshness
// · git state · system/logs litter · inbox backlog · (--tests) full suite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkEnvText } = require('./lib/env-check.js');
const { localDate } = require('./lib/date.js');

const ROOT = path.join(__dirname, '..');
const REQUIRED_ENV = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_ID',
  'TICKTICK_ACCESS_TOKEN', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
// running = must have a live PID (KeepAlive daemons); ondemand = calendar
// jobs that are '-' between runs, judged by last exit status.
const LAUNCHD_JOBS = {
  'com.secondbrain.second-brain-bot': 'running',
  'com.secondbrain.second-brain-morning': 'ondemand',
  'com.secondbrain.second-brain-evening': 'ondemand',
  'com.secondbrain.second-brain-ingest': 'ondemand',
  'com.secondbrain.second-brain-nightshift': 'ondemand',
  'com.secondbrain.second-brain-weekly': 'ondemand'
};
const LOG_FILES = ['second-brain-bot.log', 'second-brain-morning.log', 'second-brain-evening.log', 'second-brain-ingest.log', 'second-brain-nightshift.log', 'second-brain-weekly.log'];
const ERROR_RE = /error|fail|401|403|429|crash|ETIMEDOUT|ECONN/i;
const FRESHNESS_GRACE_MS = 26 * 3600 * 1000; // nightly ingest cadence + slack
const WEEKLY_GRACE_MS = (7 * 24 + 2) * 3600 * 1000; // Sunday-only job: one cycle + slack

/* ------------------------- pure, unit-tested logic ------------------------ */

// launchctl list output: "<pid|-> <last-exit> <label>" per line.
function parseLaunchctl(text, jobs) {
  const rows = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(-?\d+)\s+(\S+)$/);
    if (m) rows.set(m[3], { pid: m[1] === '-' ? null : m[1], lastExit: Number(m[2]) });
  }
  const out = [];
  for (const [label, kind] of Object.entries(jobs)) {
    const row = rows.get(label);
    const name = `launchd ${label.replace('com.secondbrain.', '')}`;
    if (!row) { out.push({ name, level: 'fail', detail: 'not loaded — launchctl bootstrap it' }); continue; }
    if (kind === 'running') {
      out.push(row.pid
        ? { name, level: 'ok', detail: `running (pid ${row.pid})` }
        : { name, level: 'fail', detail: `not running (last exit ${row.lastExit})` });
    } else {
      out.push(row.lastExit === 0
        ? { name, level: 'ok', detail: row.pid ? `running (pid ${row.pid})` : 'idle, last run clean' }
        : { name, level: 'warn', detail: `last run exited ${row.lastExit} — check its log` });
    }
  }
  return out;
}

function scanLogText(text) {
  let count = 0, last = '';
  for (const line of String(text || '').split('\n')) {
    if (line && ERROR_RE.test(line)) { count += 1; last = line.trim(); }
  }
  return { count, last };
}

function freshnessCheck({ indexMtime, newestWikiMtime }) {
  if (indexMtime == null) return { name: 'index freshness', level: 'fail', detail: 'indexes/graph.json missing — run the ingest' };
  if (newestWikiMtime == null) return { name: 'index freshness', level: 'ok', detail: 'no wiki files found (nothing to index)' };
  const lag = newestWikiMtime - indexMtime;
  if (lag <= FRESHNESS_GRACE_MS) return { name: 'index freshness', level: 'ok', detail: 'graph index covers the wiki' };
  return {
    name: 'index freshness', level: 'warn',
    detail: `wiki is ${Math.round(lag / 3600000)}h newer than graph.json — run bash system/ingest/run-ingest.sh`
  };
}

function litterCheck(entries) {
  const litter = (entries || []).filter(e => e.size === 0 || /^health-decode-/.test(e.name));
  if (!litter.length) return { name: 'system/logs litter', level: 'ok', detail: 'clean' };
  return {
    name: 'system/logs litter', level: 'warn',
    detail: `${litter.length} stray file(s): ${litter.slice(0, 3).map(e => e.name).join(', ')}${litter.length > 3 ? ', …' : ''}`
  };
}

// launchd shows "idle, last run clean" even when a calendar job never FIRED
// (machine asleep at 10pm). The log's mtime is the only local record of the
// last actual run — silent past one full cycle (+2h slack) means a miss.
function recencyCheck({ name, mtime, now, graceMs }) {
  const label = `${name} last ran`;
  if (mtime == null) return { name: label, level: 'warn', detail: 'no log file — has this job ever run?' };
  const age = now - mtime;
  if (age <= (graceMs || FRESHNESS_GRACE_MS)) return { name: label, level: 'ok', detail: `${Math.round(age / 3600000)}h ago` };
  return { name: label, level: 'warn', detail: `${Math.round(age / 3600000)}h ago — machine asleep at fire time? Run it manually to catch up` };
}

// Doctor verifies process health, but a two-week health-note gap once
// was a DATA gap every process check missed (ingest green, launchd clean).
// Yesterday's note is written by the 2:30am ingest AND the 10pm evening
// report refresh — if it's still missing, something in the chain is off.
function healthNoteCheck({ hasContainer, yesterday, noteExists }) {
  const name = 'health note freshness';
  if (!hasContainer) return { name, level: 'ok', detail: 'no Health Auto Export container (skipped)' };
  if (noteExists) return { name, level: 'ok', detail: `yesterday (${yesterday}) captured` };
  return {
    name, level: 'warn',
    detail: `no health note for ${yesterday} — run node system/ingest/health-ingest.js --date ${yesterday}; ` +
      'if it says "no Health data", the .hae file never dropped: open Health Auto Export on the phone'
  };
}

const ICON = { ok: '🟢', warn: '🟡', fail: '🔴' };

function formatReport(checks) {
  const lines = checks.map(c => `${ICON[c.level] || '❓'} ${c.name} — ${c.detail}`);
  const fails = checks.filter(c => c.level === 'fail').length;
  const warns = checks.filter(c => c.level === 'warn').length;
  lines.push('', fails ? `${fails} FAIL, ${warns} warn — fix the red items first.`
    : warns ? `No failures, ${warns} warning(s).` : 'All green. 🧠');
  return { text: lines.join('\n'), exitCode: fails ? 1 : 0 };
}

/* --------------------------- system state gathering ----------------------- */

function safeExec(cmd, args, opts) {
  try { return String(execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts))); }
  catch (err) { return null; }
}

function newestMtimeUnder(dir) {
  let newest = null;
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.name.endsWith('.md')) {
        try { const t = fs.statSync(p).mtimeMs; if (newest === null || t > newest) newest = t; } catch (err) { /* ignore */ }
      }
    }
  }
  return newest;
}

function gatherChecks(opts = {}) {
  const checks = [];

  // 1. .env integrity (the fused-line bug guard)
  let envText = '';
  try { envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (err) { envText = ''; }
  const envProblems = checkEnvText(envText, REQUIRED_ENV);
  checks.push(envProblems.length
    ? { name: '.env', level: 'fail', detail: envProblems.join(' | ') + ' — after fixing, restart the bot (it caches .env)' }
    : { name: '.env', level: 'ok', detail: 'all keys present, no fused lines' });

  // 2. launchd jobs
  const lc = safeExec('launchctl', ['list']);
  if (lc === null) checks.push({ name: 'launchd', level: 'warn', detail: 'launchctl unavailable (not on this Mac?)' });
  else checks.push(...parseLaunchctl(lc, LAUNCHD_JOBS));

  // 3. log error scan (last 200 lines each) + recency for the calendar jobs
  // (launchd can't distinguish "ran clean yesterday" from "never fired today")
  for (const f of LOG_FILES) {
    const p = path.join(os.homedir(), 'Library', 'Logs', f);
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (err) { text = ''; }
    const tail = text.split('\n').slice(-200).join('\n');
    const r = scanLogText(tail);
    checks.push(r.count
      ? { name: `log ${f}`, level: 'warn', detail: `${r.count} error line(s), last: "${r.last.slice(0, 120)}"` }
      : { name: `log ${f}`, level: 'ok', detail: 'clean' });
    if (/morning|evening|ingest|nightshift|weekly/.test(f)) {
      let mtime = null;
      try { mtime = fs.statSync(p).mtimeMs; } catch (err) { mtime = null; }
      checks.push(recencyCheck({
        name: f.replace('second-brain-', '').replace('.log', ''), mtime, now: Date.now(),
        // the weekly report only fires Sundays — judge it on a 7-day cycle
        graceMs: /weekly/.test(f) ? WEEKLY_GRACE_MS : undefined
      }));
    }
  }

  // 4. index freshness
  let indexMtime = null;
  try { indexMtime = fs.statSync(path.join(ROOT, 'indexes', 'graph.json')).mtimeMs; } catch (err) { indexMtime = null; }
  checks.push(freshnessCheck({ indexMtime, newestWikiMtime: newestMtimeUnder(path.join(ROOT, 'wiki')) }));

  // 5. git state (uncommitted is informational — the 2:30am ingest auto-commits)
  const porcelain = safeExec('git', ['status', '--porcelain'], { cwd: ROOT });
  if (porcelain !== null) {
    const dirty = porcelain.split('\n').filter(Boolean).length;
    checks.push({ name: 'git working tree', level: 'ok', detail: dirty ? `${dirty} uncommitted change(s) — nightly ingest will sweep them` : 'clean' });
    const unpushed = safeExec('git', ['rev-list', '--count', 'origin/main..main'], { cwd: ROOT });
    const n = unpushed === null ? null : Number(unpushed.trim());
    if (n) checks.push({ name: 'git sync', level: 'warn', detail: `${n} commit(s) not pushed to origin — ingest push may be failing` });
    else if (n === 0) checks.push({ name: 'git sync', level: 'ok', detail: 'origin up to date' });
  }

  // 6. system/logs litter
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(ROOT, 'system', 'logs'), { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => ({ name: e.name, size: fs.statSync(path.join(ROOT, 'system', 'logs', e.name)).size }));
  } catch (err) { entries = []; }
  checks.push(litterCheck(entries));

  // 7. health note freshness (data-gap check, not process check)
  const container = path.join(os.homedir(), 'Library', 'Mobile Documents',
    'iCloud~com~ifunography~HealthExport', 'Documents', 'AutoSync');
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yesterday = localDate(yd);
  checks.push(healthNoteCheck({
    hasContainer: fs.existsSync(container),
    yesterday,
    noteExists: fs.existsSync(path.join(ROOT, 'wiki', 'personal', 'health', `${yesterday}.md`))
  }));

  // 8. inbox backlog — fallback captures land here and nothing drains them
  let inbox = '';
  try { inbox = fs.readFileSync(path.join(ROOT, 'inbox', 'inbox.md'), 'utf8'); } catch (err) { inbox = ''; }
  const pending = inbox.split('\n').filter(l => /^-\s*\[/.test(l.trim())).length;
  checks.push(pending
    ? { name: 'inbox backlog', level: 'warn', detail: `${pending} unprocessed capture(s) in inbox/inbox.md — triage them into the wiki` }
    : { name: 'inbox backlog', level: 'ok', detail: 'empty' });

  // 9. full test suite (opt-in, ~1s)
  if (opts.tests) {
    const out = safeExec(process.execPath, ['--test', 'tests/'], { cwd: ROOT, timeout: 120000 });
    checks.push(out !== null
      ? { name: 'test suite', level: 'ok', detail: (out.match(/# pass (\d+)/) || [])[0] || 'passed' }
      : { name: 'test suite', level: 'fail', detail: 'failures — run node --test "tests/**/*.test.js"' });
  }

  return checks;
}

module.exports = { parseLaunchctl, scanLogText, freshnessCheck, litterCheck, recencyCheck, healthNoteCheck, formatReport, gatherChecks };

if (require.main === module) {
  const args = process.argv.slice(2);
  const checks = gatherChecks({ tests: args.includes('--tests') });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ date: new Date().toString(), checks }, null, 2));
    process.exit(checks.some(c => c.level === 'fail') ? 1 : 0);
  }
  const { text, exitCode } = formatReport(checks);
  console.log(text);
  process.exit(exitCode);
}
