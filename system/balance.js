#!/usr/bin/env node
'use strict';
// BALANCE GUARDRAILS — deterministic weekly aggregates + rule-based flags.
// Reads health notes (wiki/personal/health/*.md), task archives (tasks/archive/*.md
// `done:` stamps), wiki `updated:` frontmatter, inbox captures, and connect signals
// (people notes + <date>-connections.md journal notes), buckets everything by ISO
// week, and fires simple threshold flags. NO claude calls — the /brain-weekly skill
// interprets this output.
//
// CLI: node system/balance.js [--weeks N] [--json]
//
// Definitions:
//   coverage    = days-with-health-data / 7 for the week
//   work notes  = wiki notes updated that week in content + business departments
//   work output = tasks completed + work notes (the flag comparator)
//   connect     = people-note updates + <date>-connections.md notes in the week
//
// Coverage guard: health-derived flags only fire when every week they compare
// has >= MIN_COVERAGE_DAYS days of health data — sparse data stays quiet.
//
// Zero npm deps, node built-ins only. All dates are LOCAL YYYY-MM-DD (localDate).

const fs = require('fs');
const path = require('path');
const { localDate } = require('./lib/date.js');

const FIVE_BEHAVIORS = ['move', 'breathe', 'create', 'learn', 'connect'];
const WORK_DEPARTMENTS = ['content', 'business'];
const MIN_COVERAGE_DAYS = 4;

/* --------------------------------- dates --------------------------------- */

// Local Date from a YYYY-MM-DD string (null on junk). Never UTC.
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// Monday of the ISO week containing ymd.
function mondayOf(ymd) {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

// ISO week key like "2026-W28" (ISO year, not calendar year, at boundaries).
function isoWeekKey(ymd) {
  const d = parseYmd(ymd);
  if (!d) return null;
  const thu = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const y = thu.getFullYear();
  const jan4 = new Date(y, 0, 4);
  const week1Mon = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((thu.getTime() - week1Mon.getTime()) / (7 * 86400000));
  return `${y}-W${String(week).padStart(2, '0')}`;
}

/* ---------------------------- health note parsing ---------------------------- */

function toNum(v) {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// One metric: prefer the metrics-table row, fall back to the Summary line.
function pickMetric(text, rowRe, summaryRe) {
  let m = text.match(rowRe);
  if (m) return toNum(m[1]);
  m = text.match(summaryRe);
  return m ? toNum(m[1]) : null;
}

// Parse one health note. Missing fields → null; workouts counted from the
// `## Workouts` bullet list. hasData = at least one metric present.
function parseHealthNote(text) {
  const s = String(text == null ? '' : text);
  const out = {
    steps: pickMetric(s, /^\|\s*Steps\s*\|\s*([\d,.]+)\s*\|/mi, /([\d,]+)\s*steps/i),
    exerciseMin: pickMetric(s, /^\|\s*Exercise\s*\|\s*([\d,.]+)\s*min/mi, /([\d,.]+)\s*min exercise/i),
    hrv: pickMetric(s, /^\|\s*HRV\s*\|\s*([\d,.]+)\s*ms/mi, /HRV\s*([\d.]+)\s*ms/i),
    restingHr: pickMetric(s, /^\|\s*Resting HR\s*\|\s*([\d,.]+)\s*bpm/mi, /resting HR\s*([\d.]+)\s*bpm/i),
    mindfulMin: pickMetric(s, /^\|\s*Mindful minutes\s*\|\s*([\d,.]+)\s*min/mi, /([\d,.]+)\s*min mindful/i)
  };
  let workouts = 0;
  const sec = s.split(/^##\s+Workouts\s*$/m)[1];
  if (sec) {
    for (const line of sec.split(/^##\s/m)[0].split('\n')) {
      if (/^-\s+\S/.test(line)) workouts++;
    }
  }
  out.workouts = workouts;
  out.hasData = ['steps', 'exerciseMin', 'hrv', 'restingHr', 'mindfulMin']
    .some(k => out[k] != null) || workouts > 0;
  return out;
}

/* ------------------------------ fs scan helpers ------------------------------ */

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (err) { return null; }
}

function fmField(text, name) {
  const m = String(text == null ? '' : text).match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function fmBehaviors(text) {
  const raw = fmField(text, 'behaviors');
  if (!raw) return [];
  return raw.replace(/[[\]]/g, '').split(',')
    .map(s => s.trim().toLowerCase())
    .filter(b => FIVE_BEHAVIORS.includes(b));
}

// All .md files under dir (recursive), as absolute paths.
function walkMd(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/* -------------------------------- aggregation -------------------------------- */

function emptyWeek(start) {
  return {
    week: isoWeekKey(start),
    start,
    end: addDays(start, 6),
    partial: false,
    health: {
      days: 0, coverage: '0/7',
      avgSteps: null, exerciseMin: null, avgHrv: null, avgRestingHr: null,
      mindfulMin: null, mindfulDays: 0, workouts: 0,
      _steps: [], _hrv: [], _rhr: []
    },
    output: { tasksDone: 0, notesByDept: {}, workNotes: 0, workOutput: 0, inboxCaptures: 0 },
    connect: 0,
    behaviorDays: Object.create(null) // behavior -> Set of dates (finalized to counts)
  };
}

// Aggregate the last `weeks` ISO weeks (oldest → newest; last week = current, partial).
function aggregateWeeks(rootDir, opts) {
  const o = opts || {};
  const today = o.today || localDate();
  const nWeeks = o.weeks || 4;

  const curMon = mondayOf(today);
  const weeks = [];
  const idxByStart = new Map();
  for (let k = nWeeks - 1; k >= 0; k--) {
    const w = emptyWeek(addDays(curMon, -7 * k));
    w.partial = today < w.end;
    idxByStart.set(w.start, weeks.length);
    weeks.push(w);
  }
  const rangeLo = weeks[0].start;
  const rangeHi = weeks[weeks.length - 1].end;
  const weekOf = ymd => {
    if (!parseYmd(ymd) || ymd < rangeLo || ymd > rangeHi) return null;
    const i = idxByStart.get(mondayOf(ymd));
    return i == null ? null : weeks[i];
  };
  const touchBehavior = (w, behavior, ymd) => {
    (w.behaviorDays[behavior] = w.behaviorDays[behavior] || new Set()).add(ymd);
  };

  // --- health notes: wiki/personal/health/<YYYY-MM-DD>.md (date from filename) ---
  const healthDir = path.join(rootDir, 'wiki', 'personal', 'health');
  let healthFiles = [];
  try { healthFiles = fs.readdirSync(healthDir); } catch (err) { /* no health dir */ }
  for (const f of healthFiles) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
    if (!m) continue;
    const w = weekOf(m[1]);
    if (!w) continue;
    const note = parseHealthNote(readSafe(path.join(healthDir, f)));
    if (!note.hasData) continue;
    const h = w.health;
    h.days++;
    if (note.steps != null) h._steps.push(note.steps);
    if (note.exerciseMin != null) h.exerciseMin = (h.exerciseMin || 0) + note.exerciseMin;
    if (note.hrv != null) h._hrv.push(note.hrv);
    if (note.restingHr != null) h._rhr.push(note.restingHr);
    if (note.mindfulMin != null) { h.mindfulMin = (h.mindfulMin || 0) + note.mindfulMin; h.mindfulDays++; }
    h.workouts += note.workouts;
    if ((note.steps || 0) > 0 || (note.exerciseMin || 0) > 0 || note.workouts > 0) touchBehavior(w, 'move', m[1]);
    if ((note.mindfulMin || 0) > 0) touchBehavior(w, 'breathe', m[1]);
  }
  for (const w of weeks) {
    const h = w.health;
    const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    h.avgSteps = avg(h._steps);
    h.avgHrv = avg(h._hrv);
    h.avgRestingHr = avg(h._rhr);
    h.coverage = `${h.days}/7`;
    delete h._steps; delete h._hrv; delete h._rhr;
  }

  // --- wiki notes updated (by department; people notes + connections → connect) ---
  const peoplePrefix = path.join(rootDir, 'wiki', 'personal', 'people') + path.sep;
  const healthPrefix = healthDir + path.sep;
  for (const p of walkMd(path.join(rootDir, 'wiki'))) {
    if (p.startsWith(healthPrefix)) continue; // health notes counted above, not as note output
    const text = readSafe(p);
    if (text == null) continue;
    const updated = fmField(text, 'updated');
    const w = updated ? weekOf(updated) : null;
    if (!w) continue;
    const dept = path.relative(path.join(rootDir, 'wiki'), p).split(path.sep)[0];
    w.output.notesByDept[dept] = (w.output.notesByDept[dept] || 0) + 1;
    for (const b of fmBehaviors(text)) touchBehavior(w, b, updated);
    if (p.startsWith(peoplePrefix)) {
      w.connect++;
      touchBehavior(w, 'connect', updated);
    }
  }
  // <date>-connections.md journal notes (date from filename — auto Limitless pass)
  const journalDir = path.join(rootDir, 'wiki', 'personal', 'journal');
  let journalFiles = [];
  try { journalFiles = fs.readdirSync(journalDir); } catch (err) { /* no journal dir */ }
  for (const f of journalFiles) {
    const m = /^(\d{4}-\d{2}-\d{2})-connections\.md$/.exec(f);
    if (!m) continue;
    const w = weekOf(m[1]);
    if (!w) continue;
    w.connect++;
    touchBehavior(w, 'connect', m[1]);
  }

  // --- tasks completed: tasks/archive/*.md `done:<date>` stamps ---
  const archiveDir = path.join(rootDir, 'tasks', 'archive');
  let archiveFiles = [];
  try { archiveFiles = fs.readdirSync(archiveDir); } catch (err) { /* no archive */ }
  for (const f of archiveFiles) {
    if (!f.endsWith('.md')) continue;
    for (const line of String(readSafe(path.join(archiveDir, f)) || '').split('\n')) {
      const m = line.match(/^-\s*\[x\]\s*(.*)$/i);
      if (!m) continue;
      const done = m[1].match(/done:(\d{4}-\d{2}-\d{2})/);
      const w = done ? weekOf(done[1]) : null;
      if (!w) continue;
      w.output.tasksDone++;
      const bm = m[1].match(/\|\s*behaviors:([^|]*)/);
      if (bm) {
        for (const b of bm[1].split(',').map(s => s.trim().toLowerCase())) {
          if (FIVE_BEHAVIORS.includes(b)) touchBehavior(w, b, done[1]);
        }
      }
    }
  }

  // --- inbox captures: `- [<date>] text` lines ---
  for (const line of String(readSafe(path.join(rootDir, 'inbox', 'inbox.md')) || '').split('\n')) {
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\S/);
    const w = m ? weekOf(m[1]) : null;
    if (w) w.output.inboxCaptures++;
  }

  // --- finalize: work output + behavior day counts ---
  for (const w of weeks) {
    w.output.workNotes = WORK_DEPARTMENTS.reduce((s, d) => s + (w.output.notesByDept[d] || 0), 0);
    w.output.workOutput = w.output.tasksDone + w.output.workNotes;
    const counts = {};
    for (const b of FIVE_BEHAVIORS) counts[b] = w.behaviorDays[b] ? w.behaviorDays[b].size : 0;
    w.behaviorDays = counts;
  }
  return weeks;
}

/* ---------------------------------- flags ---------------------------------- */

// Rule-based flags over the aggregated weeks (oldest → newest). Health-derived
// comparisons only fire when every week involved has >= MIN_COVERAGE_DAYS days
// of health data. Each flag: { id, week, message }.
function computeFlags(weeks) {
  const flags = [];
  const eligible = w => w.health.days >= MIN_COVERAGE_DAYS;
  const pct = v => `${Math.round(v * 100)}%`;
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

  weeks.forEach((w, i) => {
    const prior = i > 0 ? weeks[i - 1] : null;

    // recovery-down-output-up: HRV down >10% vs prior week AND work output up >25%.
    if (prior && eligible(w) && eligible(prior) && w.health.avgHrv != null && prior.health.avgHrv > 0) {
      const hrvDrop = (prior.health.avgHrv - w.health.avgHrv) / prior.health.avgHrv;
      const po = prior.output.workOutput, co = w.output.workOutput;
      const outputUp = po > 0 ? (co - po) / po > 0.25 : co > 0;
      if (hrvDrop > 0.10 && outputUp) {
        flags.push({
          id: 'recovery-down-output-up', week: w.week,
          message: `${w.week}: avg HRV fell ${pct(hrvDrop)} while work output rose ` +
            `${po > 0 ? pct((co - po) / po) : `from 0 to ${co}`} vs the prior week — recovery is paying for the push.`
        });
      }
    }

    // movement-collapse: avg steps down >40% vs the mean of the other weeks in the window.
    if (eligible(w) && w.health.avgSteps != null) {
      const baseline = mean(weeks
        .filter((o, j) => j !== i && eligible(o) && o.health.avgSteps != null)
        .map(o => o.health.avgSteps));
      if (baseline != null && baseline > 0 && (baseline - w.health.avgSteps) / baseline > 0.40) {
        flags.push({
          id: 'movement-collapse', week: w.week,
          message: `${w.week}: avg steps ${Math.round(w.health.avgSteps)} is ` +
            `${pct((baseline - w.health.avgSteps) / baseline)} below the 4-week mean (${Math.round(baseline)}) — movement collapsed.`
        });
      }
    }

    // no-breathe: zero mindful minutes for the week while work output >= the 4-week mean.
    if (eligible(w) && w.health.mindfulMin === 0) {
      const outMean = mean(weeks.map(o => o.output.workOutput));
      if (outMean != null && w.output.workOutput >= outMean) {
        flags.push({
          id: 'no-breathe', week: w.week,
          message: `${w.week}: zero mindful minutes while work output (${w.output.workOutput}) sits at or ` +
            `above the 4-week mean (${Math.round(outMean * 10) / 10}) — all output, no breathing room.`
        });
      }
    }

    // connect-drought: zero connect signals for 2+ consecutive weeks (fires once,
    // at the end of the run; every drought week must pass the coverage guard).
    if (w.connect === 0 && eligible(w)) {
      let run = 1;
      for (let j = i - 1; j >= 0 && weeks[j].connect === 0 && eligible(weeks[j]); j--) run++;
      const next = weeks[i + 1];
      const runEnds = !next || next.connect > 0 || !eligible(next);
      if (run >= 2 && runEnds) {
        flags.push({
          id: 'connect-drought', week: w.week,
          message: `${w.week}: zero connect signals for ${run} consecutive weeks — reach out to someone this week.`
        });
      }
    }

    // streak (positive): all five behaviors touched on >= 5 of 7 days.
    if (FIVE_BEHAVIORS.every(b => w.behaviorDays[b] >= 5)) {
      flags.push({
        id: 'streak', week: w.week,
        message: `${w.week}: all five behaviors touched on 5+ of 7 days — a genuinely balanced week, keep it going.`
      });
    }
  });
  return flags;
}

/* --------------------------------- output --------------------------------- */

function fmtCell(v, digits) {
  if (v == null) return '—';
  const d = digits == null ? 0 : digits;
  return d ? String(Math.round(v * 10 ** d) / 10 ** d) : String(Math.round(v));
}

function formatTable(weeks, flags) {
  const header = ['week', 'cov', 'steps avg', 'exercise min', 'HRV', 'done', 'notes', 'connect'];
  const rows = weeks.map(w => [
    w.week + (w.partial ? '*' : ''),
    w.health.coverage,
    fmtCell(w.health.avgSteps),
    fmtCell(w.health.exerciseMin),
    fmtCell(w.health.avgHrv, 1),
    String(w.output.tasksDone),
    String(Object.values(w.output.notesByDept).reduce((s, v) => s + v, 0)),
    String(w.connect)
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c].length)));
  const line = r => r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  ');
  const out = [
    `Balance — last ${weeks.length} ISO weeks (* = current week, partial)`,
    '',
    line(header),
    line(widths.map(w => '-'.repeat(w))),
    ...rows.map(line),
    '',
    'Flags:'
  ];
  if (!flags.length) out.push('  none — nothing tripping the guardrails this window.');
  else for (const f of flags) out.push(`  [${f.id}] ${f.message}`);
  return out.join('\n');
}

/* ----------------------------------- CLI ----------------------------------- */

function main(argv) {
  const args = argv || process.argv.slice(2);
  let weeksN = 4;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--weeks') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) { console.error('--weeks needs a positive integer'); process.exit(1); }
      weeksN = n;
    } else { console.error(`unknown arg: ${args[i]}\nusage: node system/balance.js [--weeks N] [--json]`); process.exit(1); }
  }
  const rootDir = path.resolve(__dirname, '..');
  const weeks = aggregateWeeks(rootDir, { weeks: weeksN });
  const flags = computeFlags(weeks);
  console.log(json ? JSON.stringify({ weeks, flags }, null, 2) : formatTable(weeks, flags));
}

if (require.main === module) main();

module.exports = {
  FIVE_BEHAVIORS, MIN_COVERAGE_DAYS,
  parseYmd, addDays, mondayOf, isoWeekKey,
  parseHealthNote, aggregateWeeks, computeFlags, formatTable, main
};
