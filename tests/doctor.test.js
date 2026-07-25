'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseLaunchctl,
  scanLogText,
  freshnessCheck,
  litterCheck,
  healthNoteCheck,
  formatReport
} = require('../system/doctor.js');

/* ---------------------------- healthNoteCheck ---------------------------- */

test('healthNoteCheck: ok when yesterday\'s health note exists', () => {
  const c = healthNoteCheck({ hasContainer: true, yesterday: '2026-07-09', noteExists: true });
  assert.strictEqual(c.level, 'ok');
});

test('healthNoteCheck: warns with remediation when yesterday\'s note is missing', () => {
  const c = healthNoteCheck({ hasContainer: true, yesterday: '2026-07-09', noteExists: false });
  assert.strictEqual(c.level, 'warn');
  assert.match(c.detail, /2026-07-09/);
  assert.match(c.detail, /health-ingest\.js --date 2026-07-09/);
  assert.match(c.detail, /phone/i);
});

test('healthNoteCheck: skips cleanly when no Health Auto Export container', () => {
  const c = healthNoteCheck({ hasContainer: false, yesterday: '2026-07-09', noteExists: false });
  assert.strictEqual(c.level, 'ok');
  assert.match(c.detail, /no Health Auto Export container/);
});

/* ---------------------------- parseLaunchctl ---------------------------- */

const LAUNCHCTL = [
  '4990\t-15\tcom.secondbrain.second-brain-bot',
  '-\t0\tcom.secondbrain.second-brain-morning',
  '-\t0\tcom.secondbrain.second-brain-evening',
  '-\t78\tcom.secondbrain.something-broken',
  '1179\t0\tcom.other.job'
].join('\n');

test('parseLaunchctl: running job with pid is ok even after SIGTERM restart', () => {
  const r = parseLaunchctl(LAUNCHCTL, { 'com.secondbrain.second-brain-bot': 'running' });
  assert.strictEqual(r[0].level, 'ok');
});

test('parseLaunchctl: on-demand job with last exit 0 is ok', () => {
  const r = parseLaunchctl(LAUNCHCTL, { 'com.secondbrain.second-brain-morning': 'ondemand' });
  assert.strictEqual(r[0].level, 'ok');
});

test('parseLaunchctl: running job with no pid is fail', () => {
  const r = parseLaunchctl(LAUNCHCTL, { 'com.secondbrain.second-brain-morning': 'running' });
  assert.strictEqual(r[0].level, 'fail');
});

test('parseLaunchctl: nonzero last exit on on-demand job is warn', () => {
  const r = parseLaunchctl(LAUNCHCTL, { 'com.secondbrain.something-broken': 'ondemand' });
  assert.strictEqual(r[0].level, 'warn');
  assert.match(r[0].detail, /78/);
});

test('parseLaunchctl: missing label is fail', () => {
  const r = parseLaunchctl(LAUNCHCTL, { 'com.secondbrain.not-loaded': 'running' });
  assert.strictEqual(r[0].level, 'fail');
  assert.match(r[0].detail, /not loaded/i);
});

/* ------------------------------ scanLogText ----------------------------- */

test('scanLogText counts error-ish lines and keeps the last example', () => {
  const log = ['polling started', 'TickTick create failed: 401', 'ok line', 'getUpdates failed: read ETIMEDOUT'].join('\n');
  const r = scanLogText(log);
  assert.strictEqual(r.count, 2);
  assert.match(r.last, /ETIMEDOUT/);
});

test('scanLogText ignores clean logs', () => {
  const r = scanLogText('started\nsent report\n');
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.last, '');
});

/* ---------------------------- freshnessCheck ---------------------------- */

test('freshnessCheck: index newer than wiki is ok', () => {
  const r = freshnessCheck({ indexMtime: 2000, newestWikiMtime: 1000 });
  assert.strictEqual(r.level, 'ok');
});

test('freshnessCheck: wiki newer but within the nightly-ingest window is ok', () => {
  const HOUR = 3600 * 1000;
  const r = freshnessCheck({ indexMtime: 0, newestWikiMtime: 10 * HOUR });
  assert.strictEqual(r.level, 'ok');
});

test('freshnessCheck: wiki newer than index by more than 26h is warn', () => {
  const HOUR = 3600 * 1000;
  const r = freshnessCheck({ indexMtime: 0, newestWikiMtime: 30 * HOUR });
  assert.strictEqual(r.level, 'warn');
});

test('freshnessCheck: missing index is fail', () => {
  const r = freshnessCheck({ indexMtime: null, newestWikiMtime: 1000 });
  assert.strictEqual(r.level, 'fail');
});

/* ------------------------------ litterCheck ----------------------------- */

test('litterCheck flags zero-byte and health-decode files', () => {
  const r = litterCheck([
    { name: 'ingest-2026-07-08.log', size: 500 },
    { name: 'health-decode-123.json', size: 0 },
    { name: 'stray.json', size: 0 }
  ]);
  assert.strictEqual(r.level, 'warn');
  assert.match(r.detail, /2/);
});

test('litterCheck is ok when logs dir is clean', () => {
  const r = litterCheck([{ name: 'ingest.log', size: 10 }]);
  assert.strictEqual(r.level, 'ok');
});

/* ------------------------------ formatReport ---------------------------- */

test('formatReport renders levels and returns worst exit code', () => {
  const checks = [
    { name: 'env', level: 'ok', detail: 'clean' },
    { name: 'logs', level: 'warn', detail: '2 error lines' },
    { name: 'bot', level: 'fail', detail: 'not loaded' }
  ];
  const { text, exitCode } = formatReport(checks);
  assert.match(text, /🟢.*env/);
  assert.match(text, /🟡.*logs/);
  assert.match(text, /🔴.*bot/);
  assert.strictEqual(exitCode, 1);
});

test('formatReport exits 0 with only ok/warn', () => {
  const { exitCode } = formatReport([{ name: 'env', level: 'warn', detail: 'x' }]);
  assert.strictEqual(exitCode, 0);
});

/* ---------------------------- recencyCheck ------------------------------ */

const { recencyCheck } = require('../system/doctor.js');
const DAY = 24 * 3600 * 1000;

test('recencyCheck: log written within 26h is ok', () => {
  const r = recencyCheck({ name: 'evening', mtime: 1000 * DAY - 3600000, now: 1000 * DAY });
  assert.strictEqual(r.level, 'ok');
});

test('recencyCheck: log silent for more than 26h is warn', () => {
  const r = recencyCheck({ name: 'evening', mtime: 1000 * DAY - 2 * DAY, now: 1000 * DAY });
  assert.strictEqual(r.level, 'warn');
  assert.match(r.detail, /48h/);
});

test('recencyCheck: missing log is warn', () => {
  const r = recencyCheck({ name: 'morning', mtime: null, now: 1000 * DAY });
  assert.strictEqual(r.level, 'warn');
});

test('recencyCheck: custom graceMs lets the Sunday-only weekly job go a full cycle', () => {
  const WEEKLY = (7 * 24 + 2) * 3600 * 1000;
  const ok = recencyCheck({ name: 'weekly', mtime: 1000 * DAY - 6 * DAY, now: 1000 * DAY, graceMs: WEEKLY });
  assert.strictEqual(ok.level, 'ok');
  const warn = recencyCheck({ name: 'weekly', mtime: 1000 * DAY - 8 * DAY, now: 1000 * DAY, graceMs: WEEKLY });
  assert.strictEqual(warn.level, 'warn');
});
