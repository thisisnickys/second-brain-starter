'use strict';
// Apple Health ingest (spec §5). Reads Health Auto Export's .hae (LZFSE-compressed
// JSON) drops from iCloud Drive, decodes via /usr/bin/compression_tool, and writes
// a daily digest to wiki/personal/health/<date>.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { localDate } = require('../lib/date.js');
const { parseFrontmatter } = require('../lib/frontmatter.js');

const ROOT = path.join(__dirname, '..', '..');
const CONTAINER = path.join(
  os.homedir(),
  'Library',
  'Mobile Documents',
  'iCloud~com~ifunography~HealthExport',
  'Documents',
  'AutoSync'
);

const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01 UTC

const METRICS = [
  'step_count',
  'apple_exercise_time',
  'sleep_analysis',
  'heart_rate_variability',
  'resting_heart_rate',
  'mindful_minutes',
];

function appleToUnix(sec) {
  return sec + APPLE_EPOCH_OFFSET;
}

function sumQty(metricJson) {
  if (!metricJson || !Array.isArray(metricJson.data)) return 0;
  let total = 0;
  for (const entry of metricJson.data) {
    if (entry && typeof entry.qty === 'number' && !Number.isNaN(entry.qty)) total += entry.qty;
  }
  return total;
}

function avgQty(metricJson) {
  if (!metricJson || !Array.isArray(metricJson.data) || metricJson.data.length === 0) return null;
  const vals = metricJson.data.filter(e => e && typeof e.qty === 'number' && !Number.isNaN(e.qty));
  if (!vals.length) return null;
  return sumQty(metricJson) / vals.length;
}

function hasData(metricJson) {
  return !!(metricJson && Array.isArray(metricJson.data) && metricJson.data.length > 0);
}

// Pure: takes pre-parsed per-metric JSON (or null if unavailable) + workouts array,
// returns the markdown body string. No file/decode I/O here.
function digestForDate({ date, inputs, workouts }) {
  const lines = [];
  const steps = hasData(inputs.step_count) ? Math.round(sumQty(inputs.step_count)) : null;
  const exercise = hasData(inputs.apple_exercise_time) ? Math.round(sumQty(inputs.apple_exercise_time)) : null;
  const hrv = hasData(inputs.heart_rate_variability) ? Math.round(avgQty(inputs.heart_rate_variability)) : null;
  const restingHr = hasData(inputs.resting_heart_rate) ? Math.round(avgQty(inputs.resting_heart_rate)) : null;
  const mindful = hasData(inputs.mindful_minutes) ? Math.round(sumQty(inputs.mindful_minutes)) : null;

  // sleep_analysis's data shape varies by export; only surface it if we can find
  // something recognizable. Omit rather than fabricate (per spec instructions).
  let sleepLine = null;
  if (hasData(inputs.sleep_analysis)) {
    const sleepData = inputs.sleep_analysis.data;
    const totalSeconds = sleepData.reduce((acc, e) => {
      if (e && typeof e.start === 'number' && typeof e.end === 'number') return acc + (e.end - e.start);
      if (e && typeof e.qty === 'number') return acc + e.qty * 60; // qty in minutes fallback
      return acc;
    }, 0);
    if (totalSeconds > 0) {
      const totalMin = Math.round(totalSeconds / 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      sleepLine = `${h}h${String(m).padStart(2, '0')}m`;
    }
  }

  // Summary line, morning-brief style ("8,400 steps, 6h20m sleep") — only
  // include facts we actually have; never fabricate a missing metric.
  const summaryParts = [];
  if (steps !== null) summaryParts.push(`${steps.toLocaleString('en-US')} steps`);
  if (sleepLine) summaryParts.push(`${sleepLine} sleep`);
  if (exercise !== null) summaryParts.push(`${exercise}min exercise`);
  if (hrv !== null) summaryParts.push(`HRV ${hrv}ms`);
  if (restingHr !== null) summaryParts.push(`resting HR ${restingHr}bpm`);
  if (mindful !== null) summaryParts.push(`${mindful}min mindful`);
  if (summaryParts.length) lines.push(`**Summary:** ${summaryParts.join(', ')}`, '');

  const rows = [];
  if (steps !== null) rows.push(['Steps', steps.toLocaleString('en-US')]);
  if (exercise !== null) rows.push(['Exercise', `${exercise}min`]);
  if (sleepLine) rows.push(['Sleep', sleepLine]);
  if (hrv !== null) rows.push(['HRV', `${hrv}ms`]);
  if (restingHr !== null) rows.push(['Resting HR', `${restingHr}bpm`]);
  if (mindful !== null) rows.push(['Mindful minutes', `${mindful}min`]);

  if (rows.length) {
    lines.push('| Metric | Value |', '|---|---|');
    for (const [label, value] of rows) lines.push(`| ${label} | ${value} |`);
    lines.push('');
  }

  lines.push('## Workouts');
  lines.push('');
  if (workouts && workouts.length) {
    for (const w of workouts) {
      const min = Math.round((w.duration || 0) / 60);
      lines.push(`- ${w.name || 'Workout'} (${min}min)`);
    }
  } else {
    lines.push('- (none)');
  }

  return lines.join('\n') + '\n';
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The .hae drops live in iCloud Drive, and iCloud evicts file contents
// ("dataless" files): metadata is visible but any read gets EDEADLK
// ("Resource deadlock avoided") until the content is downloaded. This is
// why Jul 8–9 2026 health notes silently went missing. Ask brctl to
// materialize the file and retry the read.
//
// Node has NO libuv mapping for errno 11 (EDEADLK) on macOS, so the real
// eviction error surfaces as code "Unknown system error -11" / errno -11 —
// never 'EDEADLK'. Matching only 'EDEADLK' left the retry dead code and
// caused the Jul 10–11 2026 gap; match all three shapes.
function isEvictedRead(err) {
  return err.code === 'EDEADLK' || err.errno === -11 ||
    /system error -11/.test(String(err.message || ''));
}

function readMaterialized(inputPath, opts = {}) {
  const {
    fsMod = fs,
    exec = execFileSync,
    sleep = sleepSync,
    retries = 4,
    waitMs = 5000,
  } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return fsMod.readFileSync(inputPath);
    } catch (err) {
      if (!isEvictedRead(err) || attempt >= retries) throw err;
      try { exec('/usr/bin/brctl', ['download', inputPath]); } catch (brctlErr) { /* best-effort */ }
      sleep(waitMs);
    }
  }
}

function decodeHae(inputPath) {
  // Real temp dir, not system/logs — and synchronous cleanup: the async
  // fs.rm callback never ran when decode threw, leaving zero-byte
  // health-decode-*.json litter behind.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-decode-'));
  const localIn = path.join(tmpDir, 'input.hae');
  const outPath = path.join(tmpDir, 'decoded.json');
  try {
    // Copy locally first so compression_tool never reads the iCloud path
    // (dataless files EDEADLK it — see readMaterialized).
    fs.writeFileSync(localIn, readMaterialized(inputPath));
    execFileSync('/usr/bin/compression_tool', ['-decode', '-i', localIn, '-o', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    const text = fs.readFileSync(outPath, 'utf8');
    return JSON.parse(text);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) { /* best-effort */ }
  }
}

function ymd(dateStr) {
  return dateStr.replace(/-/g, '');
}

let decodeFailures = 0;

function collectMetric(metric, dateStr) {
  const file = path.join(CONTAINER, 'HealthMetrics', metric, `${ymd(dateStr)}.hae`);
  if (!fs.existsSync(file)) return null;
  try {
    return decodeHae(file);
  } catch (err) {
    decodeFailures += 1;
    console.warn(`health-ingest: warn — failed to decode ${metric} for ${dateStr}: ${err.message}`);
    return null;
  }
}

// Pure decision: a run where files existed but every decode failed must exit
// non-zero so run-ingest marks the step red — a silent "no data" skip is how
// the Jul 8–9 2026 gap went unnoticed for two days.
function runOutcome({ anyMetric, decodeFailures }) {
  if (anyMetric) return { exitCode: 0, reason: 'ok' };
  if (decodeFailures > 0) return { exitCode: 1, reason: 'decode-failures' };
  return { exitCode: 0, reason: 'no-data' };
}

function collectWorkouts(dateStr) {
  const dir = path.join(CONTAINER, 'Workouts');
  if (!fs.existsSync(dir)) return [];
  const suffix = `_${ymd(dateStr)}_`;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.hae') && f.includes(suffix));
  const workouts = [];
  for (const f of files) {
    try {
      workouts.push(decodeHae(path.join(dir, f)));
    } catch (err) {
      decodeFailures += 1;
      console.warn(`health-ingest: warn — failed to decode workout ${f}: ${err.message}`);
    }
  }
  return workouts;
}

function yesterdayLocalDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function parseArgs(argv) {
  const idx = argv.indexOf('--date');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

function parseBackfill(argv) {
  const idx = argv.indexOf('--backfill');
  if (idx === -1) return null;
  const n = Number(argv[idx + 1]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 7;
}

// Pure decision: should a past day be re-ingested? Yes when its note is
// missing (and export data exists), or when the export synced AFTER the note
// was written (the iCloud/phone-lag class that permanently ate Jul 13 2026 —
// the nightly run only ever looked at yesterday). Manually-corrected notes
// are never overwritten.
function shouldReingest({ noteExists, noteText, noteMtimeMs, haeMtimeMs }) {
  if (!noteExists) return true;
  if (/corrected manually/i.test(String(noteText || ''))) return false;
  if (typeof haeMtimeMs === 'number' && typeof noteMtimeMs === 'number' && haeMtimeMs > noteMtimeMs) return true;
  return false;
}

// Sweep the last N finished days; re-run this script per day that needs it.
// Per-day failures are logged and don't stop the sweep (a red single day
// shouldn't kill the whole backfill step).
function runBackfill(days) {
  const { execFileSync } = require('child_process');
  const redone = [], failed = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = localDate(d);
    const hae = path.join(CONTAINER, 'HealthMetrics', 'step_count', `${ymd(dateStr)}.hae`);
    if (!fs.existsSync(hae)) continue; // nothing exported for that day — nothing to do
    const notePathAbs = path.join(ROOT, 'wiki', 'personal', 'health', `${dateStr}.md`);
    const noteExists = fs.existsSync(notePathAbs);
    let noteText = '', noteMtimeMs = null;
    if (noteExists) {
      try { noteText = fs.readFileSync(notePathAbs, 'utf8'); noteMtimeMs = fs.statSync(notePathAbs).mtimeMs; }
      catch (err) { /* treat as unreadable → re-ingest */ }
    }
    let haeMtimeMs = null;
    try { haeMtimeMs = fs.statSync(hae).mtimeMs; } catch (err) { /* leave null */ }
    if (!shouldReingest({ noteExists, noteText, noteMtimeMs, haeMtimeMs })) continue;
    try {
      execFileSync(process.execPath, [__filename, '--date', dateStr], { stdio: 'inherit', timeout: 120000 });
      redone.push(dateStr);
    } catch (err) {
      failed.push(dateStr);
      console.warn(`health-backfill: warn — re-ingest failed for ${dateStr}`);
    }
  }
  console.log(`health-backfill: checked ${days} days — re-ingested [${redone.join(', ') || 'none'}]${failed.length ? `, failed [${failed.join(', ')}]` : ''}`);
}

function main() {
  if (!fs.existsSync(CONTAINER)) {
    console.log('health-ingest: skipped (no Health Auto Export container)');
    process.exit(0);
  }

  const backfillDays = parseBackfill(process.argv.slice(2));
  if (backfillDays !== null) {
    runBackfill(backfillDays);
    process.exit(0);
  }

  const date = parseArgs(process.argv.slice(2)) || yesterdayLocalDate();

  const inputs = {};
  let anyMetric = false;
  for (const metric of METRICS) {
    const json = collectMetric(metric, date);
    inputs[metric] = json;
    if (hasData(json)) anyMetric = true;
  }
  const workouts = collectWorkouts(date);
  if (workouts.length) anyMetric = true;

  if (!anyMetric) {
    const outcome = runOutcome({ anyMetric, decodeFailures });
    if (outcome.reason === 'decode-failures') {
      console.error(`health-ingest: FAILED — ${decodeFailures} decode failure(s) for ${date}, no digest written`);
    } else {
      console.log(`health-ingest: skipped (no Health data for ${date})`);
    }
    process.exit(outcome.exitCode);
  }

  const body = digestForDate({ date, inputs, workouts });
  const outDir = path.join(ROOT, 'wiki', 'personal', 'health');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.md`);

  const newBody = `\n${body}\n`;
  let existingBody = null;
  if (fs.existsSync(outPath)) {
    existingBody = parseFrontmatter(fs.readFileSync(outPath, 'utf8')).body;
  }
  if (existingBody !== null && existingBody === newBody) {
    console.log(`health-ingest: ok ${date} (unchanged)`);
    return;
  }

  const out = `---\ntitle: Health ${date}\ndepartment: personal\ntags: [health]\nbehaviors: [move, breathe]\nsource: capture:health-auto-export\nupdated: ${localDate()}\n---\n\n${body}\n`;
  fs.writeFileSync(outPath, out);
  console.log(`health-ingest: ok ${date}`);
}

module.exports = { appleToUnix, sumQty, digestForDate, readMaterialized, runOutcome, shouldReingest, parseBackfill };
if (require.main === module) main();
