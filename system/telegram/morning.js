'use strict';
const { OWNER } = require('../lib/config.js');
// Morning-meeting presentation + plan helpers (pure). The plan is maintained
// CONVERSATIONALLY: each message edits the running draft (see extract.planTurn)
// rather than replacing it. Plan items carry "HH:MM" string times so the draft
// survives across turns without Date juggling; commit converts to Dates.
// Item shape: { title, date: "YYYY-MM-DD"|null (null = today),
//               start: "HH:MM"|null, end: "HH:MM"|null, calendar: bool }.

const { localDate } = require('../lib/date.js');

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIVE_BEHAVIORS = ['move', 'breathe', 'create', 'learn', 'connect'];

// "2026-07-09" → "Thu Jul 9" (local, no UTC). Null on malformed input.
function fmtDay(dateStr) {
  const m = DATE_RE.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

// "13:00" -> "1:00pm". Returns null on malformed input.
function fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  let h = Number(m[1]); const min = m[2];
  if (h < 0 || h > 23 || Number(min) > 59) return null;
  const ap = h < 12 ? 'am' : 'pm';
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${min}${ap}`;
}

// Validate/normalize a plan array from the model's reply. Drops junk items;
// a block missing a valid start/end degrades to a plain to-do (calendar:false).
function parsePlan(text) {
  if (typeof text !== 'string') return [];
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return [];
  let arr; try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.title !== 'string' || !it.title.trim()) continue;
    const date = DATE_RE.test(String(it.date || '')) ? String(it.date) : null;
    const start = fmt12(it.start) ? String(it.start) : null;
    const end = fmt12(it.end) ? String(it.end) : null;
    const timed = it.calendar === true && start && end;
    const item = { title: it.title.trim(), date, start: timed ? start : null, end: timed ? end : null, calendar: !!timed };
    // Five Behaviors tag — sanitized to the canonical five so a hallucinated
    // behavior can never reach tasks.md (balance.js and the evening rollup
    // count these; before Jul 22 2026 every task was behaviors:none).
    item.behaviors = Array.isArray(it.behaviors)
      ? [...new Set(it.behaviors.map(b => String(b).toLowerCase().trim()).filter(b => FIVE_BEHAVIORS.includes(b)))]
      : [];
    // Busy-aware planning: when the owner insists on a time that clashes with an
    // already-scheduled TickTick block, the model tags the item with that
    // block's title. Key present only when set, so untagged items are unchanged.
    if (typeof it.overlaps === 'string' && it.overlaps.trim()) item.overlaps = it.overlaps.trim();
    out.push(item);
  }
  return out;
}

// Render the approval message from a plan (times are "HH:MM" strings). Items
// dated later than today get a "(Thu Jul 9)" tag so date mistakes are visible
// before the owner says yes.
function formatProposal(plan, date) {
  const d = date || new Date();
  const today = localDate(d);
  const dayTag = t => (t.date && t.date !== today ? `  (${fmtDay(t.date) || t.date})` : '');
  // Conflict with an already-scheduled TickTick block — shown, never auto-moved.
  const overlapTag = t => (t.overlaps ? `  ⚠️ (overlaps ${t.overlaps})` : '');
  const blocks = plan.filter(t => t.calendar && t.start);
  const tasksOnly = plan.filter(t => !(t.calendar && t.start));
  const out = [`🗓 ${OWNER.name}'s plan — ${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`];
  if (!plan.length) {
    out.push('', "I didn't catch any to-dos in that. Tell me what's on your plate?");
    return out.join('\n');
  }
  if (blocks.length) {
    out.push('', '⏱ Calendar blocks:');
    for (const t of blocks) out.push(` • ${fmt12(t.start)}–${fmt12(t.end)}  ${t.title}${dayTag(t)}${overlapTag(t)}`);
  }
  if (tasksOnly.length) {
    out.push('', '✓ To-dos:');
    for (const t of tasksOnly) out.push(` • ${t.title}${dayTag(t)}${overlapTag(t)}`);
  }
  out.push('', 'Reply "yes" to save, or just tell me what to change (e.g. "move Isaiah to 6pm", "drop the nap"). "no" scraps it.');
  return out.join('\n');
}

const YES_RE = /^\s*(yes|yep|yeah|yup|y|do it|book it|confirm|save it|looks good|perfect|ok(ay)?|sure)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(no|nope|nah|n|cancel|discard|scrap it|nevermind|never mind|start over)\s*[.!]*\s*$/i;
function confirmIntent(text) {
  const t = String(text == null ? '' : text);
  if (YES_RE.test(t)) return 'yes';
  if (NO_RE.test(t)) return 'no';
  return null;
}

module.exports = { fmt12, fmtDay, parsePlan, formatProposal, confirmIntent };
