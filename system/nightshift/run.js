'use strict';
// Night Shift orchestrator. Deterministic shell around one scoped claude
// session: delta -> prompt -> explore -> JSON -> code-level gate -> persist.
// Any failure ends in silence + a loud log line, never a broken half-result.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { gatherDelta } = require('./delta.js');
const { buildPrompt, parseOutput } = require('./compose.js');
const { gateSparks, voiceLint, DEPARTMENTS } = require('./sparks.js');
const { appendSparks, readRecent } = require('./ledger.js');

function readCompass(rootDir) {
  const compass = {};
  for (const dept of DEPARTMENTS) {
    try { compass[dept] = fs.readFileSync(path.join(rootDir, 'wiki', dept, 'compass.md'), 'utf8'); }
    catch (err) { compass[dept] = ''; }
  }
  return compass;
}

// Same scoped-execFile pattern as askBrain (bot.js) — read-only tools only.
function defaultExecClaude(rootDir) {
  return prompt => new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    delete env.CLAUDECODE;
    const child = execFile('claude', [
      '-p', prompt,
      '--max-turns', '25',
      '--allowedTools',
      `Bash(node ${rootDir}/system/brain.js:*) Bash(node ${rootDir}/system/corpus.js:*) Read`
    ], { cwd: rootDir, env, timeout: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ' | stderr: ' + String(stderr).slice(0, 300) : ''}`));
      else resolve(String(stdout || ''));
    });
    if (child.stdin) child.stdin.end();
  });
}

async function runNightShift({ rootDir, date, dryRun = false, deps = {} }) {
  const log = deps.log || console.log;
  const logError = deps.logError || console.error;
  const day = date || localDate();
  const execClaude = deps.execClaude || defaultExecClaude(rootDir);

  // Same-night rerun guard (M3): a sparks file for tonight means we already
  // ran — a second run would double-append the ledger and double-deliver at
  // 8am. Manual re-runs delete the file first, deliberately.
  const sparksPath = path.join(rootDir, 'system', 'nightshift', 'sparks', `${day}.json`);
  if (!dryRun && fs.existsSync(sparksPath)) {
    log(`night shift ${day}: already ran tonight (${sparksPath} exists) — refusing duplicate run.`);
    return { sparks: [], dropped: [], gapQuestion: null, wrote: false };
  }

  const delta = gatherDelta({ rootDir, exec: deps.exec });
  if (!delta.paths.length) {
    log(`night shift ${day}: empty delta — silence.`);
    return { sparks: [], dropped: [], gapQuestion: null, wrote: false };
  }

  const ledgerPath = path.join(rootDir, 'system', 'nightshift', 'ledger.jsonl');
  const prompt = buildPrompt({
    date: day, delta, rootDir,
    compass: readCompass(rootDir),
    recentLedger: readRecent(ledgerPath, 14, day)
  });

  let out = '';
  try { out = await execClaude(prompt); }
  catch (err) {
    logError(`night shift ${day}: claude failed — silence. ${err.message}`);
    return { sparks: [], dropped: [], gapQuestion: null, wrote: false };
  }

  const parsed = parseOutput(out);
  if (!parsed.found && String(out || '').trim()) {
    logError(`night shift ${day}: claude output had no valid JSON — silence (NOT a quiet day).`);
  }
  const { kept, dropped } = gateSparks(parsed.sparks, { rootDir });
  for (const d of dropped) log(`night shift ${day}: dropped "${(d.spark || {}).title}" — ${d.problems.join('; ')}`);

  let gapQuestion = parsed.gapQuestion;
  if (gapQuestion) {
    const problems = voiceLint(gapQuestion);
    if (problems.length) {
      log(`night shift ${day}: gap question dropped — ${problems.join('; ')}`);
      gapQuestion = null;
    }
  }

  if (dryRun) {
    log(`night shift ${day} DRY RUN: ${kept.length} spark(s)${gapQuestion ? ' + gap question' : ''}`);
    for (const s of kept) log(`\n⚡ [${s.department}] ${s.title}\n${s.text}\n(sources: ${s.sources.join(', ')})`);
    if (gapQuestion) log(`\n💭 ${gapQuestion}`);
    return { sparks: kept, dropped, gapQuestion, wrote: false };
  }

  if (!kept.length && !gapQuestion) {
    log(`night shift ${day}: nothing cleared the gate — silence.`);
    return { sparks: [], dropped, gapQuestion: null, wrote: false };
  }

  // Ledger first — appendSparks assigns the ids; the sparks file carries the
  // same ids so 8am delivery can stamp Telegram messageIds back onto the
  // ledger (markSent) for Phase 4's reaction matching.
  const entries = appendSparks(ledgerPath, day, kept);
  const withIds = kept.map((s, i) => ({ id: entries[i].id, ...s }));
  fs.mkdirSync(path.dirname(sparksPath), { recursive: true });
  fs.writeFileSync(sparksPath,
    JSON.stringify({ date: day, sparks: withIds, gapQuestion }, null, 2) + '\n');
  log(`night shift ${day}: wrote ${kept.length} spark(s)${gapQuestion ? ' + gap question' : ''}.`);
  return { sparks: kept, dropped, gapQuestion, wrote: true };
}

module.exports = { runNightShift };

if (require.main === module) {
  require('../lib/log.js').installTimestamps();
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  runNightShift({
    rootDir: path.join(__dirname, '..', '..'),
    date: dateIdx !== -1 ? args[dateIdx + 1] : null,
    dryRun: args.includes('--dry-run')
  }).then(r => process.exit(0))
    .catch(err => { console.error('night shift crashed:', err.message); process.exit(1); });
}
