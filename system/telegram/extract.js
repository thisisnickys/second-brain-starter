'use strict';
// Conversational plan engine. Each turn, Claude is handed the CURRENT draft plan
// plus the owner's newest message (voice transcript or text) and returns the UPDATED
// plan — editing, not replacing. The pure parse/validate lives in morning.js and
// is unit-tested; the prompt builder here is unit-tested too.
const { execFile } = require('child_process');
const { parsePlan } = require('./morning.js');
const { localDate } = require('../lib/date.js');

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Now: Tuesday Jul 7 2026, 7:12pm (date 2026-07-07, time 19:12)" — the model
// needs both human and machine forms to place blocks after now and date items.
function nowLine(d) {
  let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; let hh = h % 12; if (hh === 0) hh = 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `Now: ${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}, ` +
         `${hh}:${min}${ap} (date ${localDate(d)}, time ${String(d.getHours()).padStart(2, '0')}:${min})`;
}

// Turn raw TickTick tasks into "13:00-14:00 Title (2026-07-08)" busy lines for
// the plan prompt. Keeps only timed (non-all-day) tasks that start today or
// tomorrow; anything unparseable is skipped. Pure — unit-tested; the network
// fetch lives in bot.js and fails soft to [].
function busyLines(tasks, now) {
  const base = now instanceof Date ? now : new Date();
  const today = localDate(base);
  const tomorrow = localDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1));
  const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t.title !== 'string' || !t.title.trim() || !t.startDate || t.isAllDay === true) continue;
    const s = new Date(t.startDate);
    if (isNaN(s)) continue;
    const day = localDate(s);
    if (day !== today && day !== tomorrow) continue;
    const e0 = t.dueDate ? new Date(t.dueDate) : s;
    const e = isNaN(e0) ? s : e0;
    out.push({ key: `${day} ${hm(s)}`, line: `${hm(s)}-${hm(e)} ${t.title.trim()} (${day})` });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out.map(x => x.line);
}

function buildPlanPrompt(currentPlan, message, now, busy) {
  const has = Array.isArray(currentPlan) && currentPlan.length;
  const busyList = (Array.isArray(busy) ? busy : []).filter(Boolean);
  return [
    "You maintain the owner's running daily plan across a back-and-forth conversation.",
    nowLine(now instanceof Date ? now : new Date()),
    ...(busyList.length ? [
      '',
      'Already scheduled (do NOT double-book these):',
      ...busyList.map(l => `- ${l}`),
    ] : []),
    has
      ? 'CURRENT plan (JSON) — this is what you built so far:\n' + JSON.stringify(currentPlan)
      : 'There is no plan yet; build the first draft from what the owner says.',
    '',
    'the owner just said (voice transcript or typed):',
    '"""',
    String(message == null ? '' : message),
    '"""',
    '',
    'Return the FULL updated plan. If a plan already exists, treat their message as an',
    'EDIT: apply their corrections, add or remove the items they mention, and KEEP every',
    'other item unchanged. Do not drop things they did not ask to change.',
    '',
    'Output ONLY a JSON array (no prose, no code fence) of items:',
    '{ "title": string, "date": "YYYY-MM-DD" | null, "start": "HH:MM" | null, "end": "HH:MM" | null, "calendar": boolean, "behaviors": string[] }',
    '- behaviors: which of ["move","breathe","create","learn","connect"] the item genuinely touches',
    '  (move = physical activity like a walk/workout; breathe = rest, mindfulness, recovery;',
    '  create = making content or product; learn = reading/watching/studying; connect = time with',
    '  or reaching out to a specific person). [] when none clearly apply — never stretch.',
    '- date: null means TODAY. Default to today unless the owner clearly says otherwise',
    '  ("tomorrow", a weekday name, or an explicit date → resolve to YYYY-MM-DD using Now above).',
    '  If they correct a date ("no, make it today"), update the date on those items.',
    '- calendar:true = a focused block worth time on the calendar → give real start+end (24h HH:MM).',
    '- calendar:false = a quick errand/reminder → start and end are null.',
    '- HONOR any time the owner states exactly ("at 6pm" → "18:00", "noon" → "12:00", "in an hour" → now+1h).',
    '- Auto-place today\'s unstated-time blocks AFTER the current time shown in Now — never at a time',
    '  that has already passed. Fit them into what is left of the day (before 23:00), no overlaps,',
    '  small gaps. If too little day remains to fit an item, make it calendar:false instead.',
    '- Keep titles short and clean (strip filler like "I need to").',
    ...(busyList.length ? [
      '- Place new unstated-time items in the remaining GAPS between the already-scheduled',
      '  blocks above (and after now). Never stack a new block on top of one.',
      '- If the owner EXPLICITLY states a time that conflicts with an already-scheduled block,',
      '  KEEP their stated time — never silently move it — and set "overlaps" on that item to',
      '  the conflicting block\'s title, e.g. { ..., "overlaps": "Deep work" }, so they can',
      '  adjust. Items with no conflict omit "overlaps" or set it to null.',
    ] : []),
    'If they clearly says start over / scrap it, return only the new items (or [] if none).',
  ].join('\n');
}

// planTurn(currentPlan, message) → Promise<plan[]>. Shells claude -p (no tools).
function planTurn(currentPlan, message, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    execFile('claude', ['-p', buildPlanPrompt(currentPlan, message, opts.now, opts.busy), '--max-turns', '4', '--allowedTools', ''],
      { cwd, env, timeout: opts.timeout || 120000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parsePlan(stdout));
      });
  });
}

module.exports = { buildPlanPrompt, busyLines, planTurn };
