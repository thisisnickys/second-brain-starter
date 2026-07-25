'use strict';
const { OWNER, ownerLine } = require('../lib/config.js');
// Morning brief — the 8am counterpart to evening.js: "here's the day ahead".
// Gathers (all local + one best-effort TickTick read):
//   1. tasks/tasks.md            → due-today / overdue Actives + other-Active count
//   2. wiki/business/opportunities → deals with near deadlines, going-cold deals,
//                                    nurture follow-ups due, counts by status
//   3. yesterday's Five Behaviors rollup → ONE gentle invitation for today
//   4. TickTick (fail-soft)      → today's calendar-synced blocks (startDate today)
// Then claude -p composes the brief in the owner's voice (plain templated fallback),
// and it goes out as Telegram TEXT only — no voice note.
// Runs two ways:
//   1. launchd com.secondbrain.second-brain-morning, daily 08:00
//   2. by hand: node system/telegram/morning-brief.js [--dry-run]
// Deliberately requires nothing from bot.js or evening.js (one-way dependency),
// so it carries its own tiny .env/telegram helpers, same as evening.js.
// Pure gather/compose helpers are exported for unit tests.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { behaviorsRollup } = require('../lib/evening-insights.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_INDEX = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

/* ------------------------------- dates (pure) ------------------------------- */

// Whole days between two local YYYY-MM-DD strings (a - b). Null on bad input.
function daysBetween(a, b) {
  const parse = s => {
    const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
  };
  const ta = parse(a), tb = parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? null : Math.round((ta - tb) / 86400000);
}

// Pull a concrete date out of freeform deal text: "2026-07-10", "Jul 23",
// "July 23". Month-name dates get the current year — unless that would put
// them more than 60 days in the past, in which case they roll to next year
// (a "Jan 5" deadline read in December means the coming January).
// Returns local YYYY-MM-DD or null.
function parseLooseDate(s, today) {
  const text = String(s == null ? '' : s);
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/i);
  if (!m) return null;
  const mon = MONTH_INDEX[m[1].toLowerCase()];
  const day = +m[2];
  if (mon == null || day < 1 || day > 31) return null;
  const ty = today ? +today.slice(0, 4) : new Date().getFullYear();
  const fmt = y => `${y}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let out = fmt(ty);
  const diff = daysBetween(today || localDate(), out);
  if (diff != null && diff > 60) out = fmt(ty + 1); // long past → they meant next year
  return out;
}

function dayLabel(d) {
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

/* ------------------------------- tasks (pure) ------------------------------- */

function taskTitle(line) {
  return String(line || '').split(' | ')[0].trim();
}

// Unchecked ## Active lines split into { dueNow: [{title, due, overdue}],
// otherActive: n }. dueNow = `due:` date ≤ today; everything else just counts.
function tasksForToday(tasksMd, today) {
  const dueNow = [];
  let otherActive = 0;
  let inActive = false;
  for (const line of String(tasksMd == null ? '' : tasksMd).split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { inActive = /^Active\b/i.test(heading[1].trim()); continue; }
    if (!inActive) continue;
    const m = line.match(/^-\s*\[ \]\s*(.*)$/);
    if (!m) continue;
    const due = (m[1].match(/\|\s*due:(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    if (due && due <= today) dueNow.push({ title: taskTitle(m[1]), due, overdue: due < today });
    else otherActive++;
  }
  dueNow.sort((a, b) => a.due.localeCompare(b.due));
  return { dueNow, otherActive };
}

/* ------------------------------- deals (pure) ------------------------------- */

// One opportunity note's signal fields. All best-effort; missing → null.
function parseDealNote(text, relPath) {
  const s = String(text == null ? '' : text);
  const grab = re => { const m = s.match(re); return m ? m[1].trim() : null; };
  return {
    relPath: relPath || null,
    title: grab(/^title:\s*(.+)$/m),
    status: (grab(/^\*\*Status:\*\*\s*(\S+)/m) || '').toLowerCase() || null,
    updated: grab(/^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m),
    deadlineRaw: grab(/^\*\*Deadline:\*\*\s*(.+)$/m),
    nurtureRaw: grab(/^\*\*Nurture:\*\*\s*(.+)$/m),
    nextAction: grab(/^\*\*Next action:\*\*\s*(.+)$/m)
  };
}

const OPEN_STATUSES = ['new', 'reviewed'];
const URGENCY_RE = /this week|end of (?:the )?week|asap|urgent|today|tomorrow/i;

// Deadline pressure on an open (new/reviewed) deal: a parseable date within
// [0, 7] days of today, or urgency language ("this week", "asap") in the
// deadline line. A leading "none" kills the line ("none — GOING COLD (7 weeks)").
function dealDeadlineSoon(deal, today) {
  if (!OPEN_STATUSES.includes(deal.status)) return null;
  const raw = deal.deadlineRaw;
  if (!raw || /^none\b/i.test(raw)) return null;
  const date = parseLooseDate(raw, today);
  if (date != null) {
    const diff = daysBetween(date, today); // days until deadline
    if (diff != null && diff >= 0 && diff <= 7) return { date, daysLeft: diff };
    if (diff != null && (diff < 0 || diff > 7)) return null;
  }
  if (URGENCY_RE.test(raw)) return { date: null, daysLeft: null };
  return null;
}

// Going cold: still new/reviewed and untouched (frontmatter `updated:`) for 7+ days.
function dealGoingCold(deal, today) {
  if (!OPEN_STATUSES.includes(deal.status) || !deal.updated) return false;
  const age = daysBetween(today, deal.updated);
  return age != null && age >= 7;
}

// Nurture follow-up due: a `**Nurture:** … next follow-up <date> …` line whose
// date is today or past. Dead deals don't get nurtured.
function dealNurtureDue(deal, today) {
  if (deal.status === 'dead' || !deal.nurtureRaw) return null;
  const m = deal.nurtureRaw.match(/next follow-up\s+(.*)$/i);
  if (!m) return null;
  const date = parseLooseDate(m[1], today);
  if (!date || date > today) return null;
  return { date, overdueDays: daysBetween(today, date) };
}

// Full deal sweep → { hot, cold, nurture, counts }. `hot` is sorted so the
// nearest concrete deadline leads (urgency-text-only deals after dated ones).
function dealSignals(deals, today) {
  const hot = [], cold = [], nurture = [];
  const counts = {};
  for (const d of deals) {
    if (d.status) counts[d.status] = (counts[d.status] || 0) + 1;
    const dl = dealDeadlineSoon(d, today);
    if (dl) hot.push({ ...d, deadline: dl });
    if (dealGoingCold(d, today)) cold.push(d);
    const n = dealNurtureDue(d, today);
    if (n) nurture.push({ ...d, nurture: n });
  }
  hot.sort((a, b) => {
    const ad = a.deadline.daysLeft, bd = b.deadline.daysLeft;
    if (ad == null && bd == null) return 0;
    if (ad == null) return 1;
    if (bd == null) return -1;
    return ad - bd;
  });
  return { hot, cold, nurture, counts };
}

function readDeals(rootDir) {
  const dir = path.join(rootDir, 'wiki', 'business', 'opportunities');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (err) { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (err) { continue; }
    out.push(parseDealNote(text, path.join('wiki', 'business', 'opportunities', f)));
  }
  return out;
}

/* --------------------------- behaviors (yesterday) --------------------------- */

// Yesterday's untouched behaviors → ONE to gently invite today. Rotates by
// day-of-month so the same behavior doesn't get named every morning.
function behaviorInvitation(untouched, now) {
  if (!untouched || !untouched.length) return null;
  return untouched[(now ? now.getDate() : new Date().getDate()) % untouched.length];
}

/* --------------------------- TickTick today's blocks ------------------------- */
// Best-effort, fail-soft: any API hiccup → null, the brief goes out without
// blocks. These are their calendar-synced blocks (tasks WITH a startDate today).

function ttGet(pathPart, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.ticktick.com/open/v1${pathPart}`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` }, timeout: 20000 },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`TickTick ${res.statusCode}`)); return; }
          try { resolve(JSON.parse(d)); } catch (err) { reject(new Error('bad TickTick response')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('TickTick request timeout')));
    req.on('error', reject);
    req.end();
  });
}

// "1:00 PM" from a Date, local time.
function clockTime(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// Open tasks whose startDate lands on today (local) → [{title, time, allDay}],
// sorted chronologically. Pure — fed by fetchTodaysBlocks.
function todaysBlocks(tasks, today) {
  const out = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || t.status === 2 || !t.startDate || typeof t.title !== 'string') continue;
    const d = new Date(t.startDate);
    if (Number.isNaN(d.getTime()) || localDate(d) !== today) continue;
    out.push({ title: t.title.trim(), time: t.isAllDay ? null : clockTime(d), at: d.getTime() });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(({ title, time }) => ({ title, time }));
}

// The Inbox never shows up in GET /project (TickTick API quirk) — but every
// task the bot creates lands there and gets ledgered with its projectId, so
// the newest ledger entry is a reliable Inbox id. Pure; fed the file text.
function ledgerProjectId(text) {
  let last = null;
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch (err) { continue; }
    if (e && typeof e.projectId === 'string' && e.projectId) last = e.projectId;
  }
  return last;
}

async function fetchTodaysBlocks(cfg, today, rootDir) {
  if (!cfg.ticktickToken) return null;
  try {
    let listId = cfg.ticktickListId;
    if (!listId && rootDir) {
      let ledger = '';
      try { ledger = fs.readFileSync(path.join(rootDir, 'tasks', 'ticktick-ledger.jsonl'), 'utf8'); } catch (err) { /* no ledger yet */ }
      listId = ledgerProjectId(ledger);
    }
    if (!listId) {
      const projects = await ttGet('/project', cfg.ticktickToken);
      const inbox = (Array.isArray(projects) ? projects : []).find(p => p && /inbox/i.test(p.name || ''));
      listId = inbox ? inbox.id : null;
    }
    if (!listId) return null;
    const data = await ttGet(`/project/${encodeURIComponent(listId)}/data`, cfg.ticktickToken);
    return todaysBlocks(data && data.tasks, today);
  } catch (err) {
    console.error('ticktick blocks skipped (non-fatal):', err.message);
    return null;
  }
}

/* ---------------------------------- gather ---------------------------------- */

// How stale is the latest biz-pulse note (wiki/business/pulse/<date>.md)?
// Days since the newest file's date, or null when none exist. The pulse is a
// session skill (needs MCP) so it can't cron — this nudge is what keeps it
// from silently never happening again (it ran ONCE, Jul 8, then froze).
function pulseStaleness(rootDir, today) {
  const dir = path.join(rootDir, 'wiki', 'business', 'pulse');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch (err) { return null; }
  if (!files.length) return null;
  return daysBetween(today, files[files.length - 1].slice(0, 10));
}

// Days since the research feed last produced anything. The research mirror
// (wiki/content/research/<week>.md) is rewritten every night a Research &
// Scouting row was edited — so its newest mtime IS the feed's heartbeat.
// ≥2 days silent = the 7am scan is starving (it died "Not logged in" for
// for weeks at a time and nothing loudly says so).
function researchStaleness(rootDir, nowMs) {
  const dir = path.join(rootDir, 'wiki', 'content', 'research');
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch (err) { return null; }
  if (!newest) return null;
  return Math.max(0, Math.floor(((nowMs || Date.now()) - newest) / 86400000));
}

function gather(rootDir, now) {
  const today = localDate(now);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yesterday = localDate(y);
  const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (err) { return ''; } };

  const tasks = tasksForToday(read(path.join(rootDir, 'tasks', 'tasks.md')), today);
  const deals = dealSignals(readDeals(rootDir), today);
  // Maintenance nudges (audit Jul 22 2026): things only a session can do,
  // surfaced daily until they're done instead of rotting silently.
  let pendingSkills = [];
  try {
    const { listPendingRequests } = require('./skill-request.js');
    pendingSkills = listPendingRequests().map(p => path.basename(p, '.md'));
  } catch (err) { /* fail-soft */ }
  const pulseDays = pulseStaleness(rootDir, today);
  const researchDays = researchStaleness(rootDir, now.getTime());
  // Yesterday's Five Behaviors → what went untouched → one invitation for today.
  const yArchive = read(path.join(rootDir, 'tasks', 'archive', `${yesterday.slice(0, 7)}.md`));
  const rollup = behaviorsRollup(rootDir, yesterday, yArchive);
  return {
    today, yesterday,
    tasks, deals,
    behaviorsUntouched: rollup.untouched,
    invitation: behaviorInvitation(rollup.untouched, now),
    pendingSkills,
    pulseDays,
    researchDays,
    blocks: null // filled asynchronously by run()
  };
}

/* ---------------------------------- compose --------------------------------- */

function countsLine(counts) {
  const order = ['new', 'reviewed', 'replied', 'negotiating', 'won', 'dead'];
  const parts = order.filter(s => counts[s]).map(s => `${counts[s]} ${s}`);
  for (const s of Object.keys(counts).sort()) if (!order.includes(s)) parts.push(`${counts[s]} ${s}`);
  return parts.join(' · ');
}

function buildBriefPrompt(data, now) {
  const list = (arr, fmt) => (arr.length ? arr.map(fmt || (x => `- ${x}`)).join('\n') : '(none)');
  const dl = d => d.deadline.date
    ? `deadline ${d.deadline.date} (${d.deadline.daysLeft === 0 ? 'TODAY' : `${d.deadline.daysLeft}d`}) — ${d.deadlineRaw}`
    : `urgent — ${d.deadlineRaw}`;
  return [
    `You are writing the owner's MORNING brief for ${dayLabel(now)}. It's ~8am — fire their up for the day.`,
    '',
    'TODAY\'S BLOCKS (TickTick, calendar-synced):',
    data.blocks == null ? '(TickTick unavailable this morning — skip the section)'
      : list(data.blocks, b => `- ${b.time ? b.time + ' — ' : ''}${b.title}`),
    '',
    `TASKS DUE TODAY / OVERDUE (${data.tasks.dueNow.length}; plus ${data.tasks.otherActive} other active with no due date):`,
    list(data.tasks.dueNow, t => `- ${t.title}${t.overdue ? ` (OVERDUE since ${t.due})` : ''}`),
    '',
    `DEALS WITH DEADLINE PRESSURE (${data.deals.hot.length}) — the FIRST one is the one that matters most today:`,
    list(data.deals.hot, d => `- ${d.title} [${d.status}] — ${dl(d)}${d.nextAction ? ` — next action: ${d.nextAction}` : ''}`),
    '',
    `NURTURE FOLLOW-UPS DUE (${data.deals.nurture.length}):`,
    list(data.deals.nurture, d => `- ${d.title} — follow-up was due ${d.nurture.date}`),
    '',
    `DEALS GOING COLD (${data.deals.cold.length}; sat in new/reviewed 7+ days untouched):`,
    list(data.deals.cold, d => `- ${d.title} [${d.status}] — last touched ${d.updated}`),
    '',
    `PIPELINE COUNTS: ${countsLine(data.deals.counts) || '(no deals on file)'}`,
    '',
    'BEHAVIOR INVITATION (from yesterday):',
    data.invitation
      ? `Yesterday "${data.invitation}" went untouched (untouched: ${data.behaviorsUntouched.join(', ')}). Invite their to give it one small moment today — gently, never shame.`
      : '(all five behaviors got touched yesterday — you can celebrate that in one clause)',
    '',
    'MAINTENANCE NUDGES (only mention the ones that apply, ONE line each):',
    data.researchDays != null && data.researchDays >= 2
      ? `- 🚨 ALARM (this one is URGENT, put it near the top): the research feed has produced NOTHING for ${data.researchDays} days — the scheduled research scan is likely failing. Say so plainly: "check the ingest log".`
      : null,
    data.pulseDays != null && data.pulseDays > 7
      ? `- Business pulse is ${data.pulseDays} days stale — nudge a refresh in a Claude session.`
      : null,
    data.pendingSkills && data.pendingSkills.length
      ? `- ${data.pendingSkills.length} pending build request${data.pendingSkills.length === 1 ? '' : 's'} waiting (${data.pendingSkills.slice(0, 3).join(', ')}) — nudge: say "build my skill requests" in Claude.`
      : null,
    (data.pulseDays == null || data.pulseDays <= 7) && (!data.pendingSkills || !data.pendingSkills.length)
      ? '(none today)' : null,
    '',
    `Write in ${OWNER.name}'s voice: direct, warm, coach-energy — a corner-coach, not a data dump.`,
    // Pronouns come from brain.config.json, never guessed from a name.
    ownerLine(),
    'Address the owner as "you" or by name. Never use gendered terms of address',
    '("brother", "bro", "man", "king", "sir", "girl") — they are wrong as often as they are right.',
    'Return ONLY a JSON object, no code fence, shaped exactly: {"text": "..."}',
    `- "text": the Telegram message. Start "☀️ Morning brief — ${dayLabel(now)}".`,
    '  Then: today\'s blocks/tasks (tight, scannable), the ONE deal action that matters most',
    '  today (deadline-driven — name the deal and the move), a one-line cold-deal nudge if any',
    '  are going cold, the behavior invitation woven in as ONE gentle sentence,',
    '  and close with one punchy line that sets the tone for the day.',
    '  Skip any empty section entirely. Under 1800 characters.'
  ].filter(l => l !== null).join('\n');
}

// Extract {text} from the model reply. Null if unusable.
function parseBrief(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  let o; try { o = JSON.parse(s.slice(a, b + 1)); } catch (err) { return null; }
  if (!o || typeof o.text !== 'string' || !o.text.trim()) return null;
  return { text: o.text.trim() };
}

// No-LLM fallback: every section, mechanically, so the brief always arrives.
function plainBrief(data, now) {
  const lines = [`☀️ Morning brief — ${dayLabel(now)}`];
  if (data.blocks && data.blocks.length) {
    lines.push('', '📅 Today\'s blocks:');
    lines.push(...data.blocks.map(b => ` • ${b.time ? b.time + ' — ' : ''}${b.title}`));
  }
  if (data.tasks.dueNow.length) {
    lines.push('', `✅ Due today (${data.tasks.dueNow.length}):`);
    lines.push(...data.tasks.dueNow.map(t => ` • ${t.title}${t.overdue ? ` (overdue since ${t.due})` : ''}`));
  }
  if (data.tasks.otherActive) lines.push('', `🗂 ${data.tasks.otherActive} other active task${data.tasks.otherActive === 1 ? '' : 's'} on the board.`);
  if (data.deals.hot.length) {
    const d = data.deals.hot[0];
    lines.push('', `💼 Deal that matters most today: ${d.title}` +
      (d.deadline.date ? ` — deadline ${d.deadline.date}${d.deadline.daysLeft === 0 ? ' (TODAY)' : ''}` : ' — urgent') +
      (d.nextAction ? `. Next action: ${d.nextAction}` : ''));
    if (data.deals.hot.length > 1) lines.push(` • also under deadline: ${data.deals.hot.slice(1).map(x => x.title).join('; ')}`);
  }
  if (data.deals.nurture.length) {
    lines.push('', `🔁 Nurture follow-ups due:`);
    lines.push(...data.deals.nurture.map(d => ` • ${d.title} (was due ${d.nurture.date})`));
  }
  if (data.deals.cold.length) {
    lines.push('', `🧊 Going cold (7+ days untouched): ${data.deals.cold.map(d => d.title).join('; ')}`);
  }
  const cl = countsLine(data.deals.counts);
  if (cl) lines.push('', `📊 Pipeline: ${cl}`);
  if (data.invitation) {
    lines.push('', `🌱 Yesterday "${data.invitation}" went untouched — find one small moment for it today.`);
  }
  if (data.researchDays != null && data.researchDays >= 2) {
    lines.push('', `🚨 Research feed has produced nothing for ${data.researchDays} days — the scheduled scan is likely failing. Check the ingest log.`);
  }
  if (data.pulseDays != null && data.pulseDays > 7) {
    lines.push('', `📈 Business pulse is ${data.pulseDays} days stale — refresh it in a Claude session.`);
  }
  if (data.pendingSkills && data.pendingSkills.length) {
    lines.push('', `🛠 ${data.pendingSkills.length} pending build request${data.pendingSkills.length === 1 ? '' : 's'}: ${data.pendingSkills.slice(0, 3).join(', ')} — say "build my skill requests" in Claude.`);
  }
  lines.push('', 'Go get the day. 🦁');
  return { text: lines.join('\n') };
}

/* --------------------------- night shift delivery --------------------------- */
// Spec §3: after the brief, each spark goes out as its OWN message (⚡ prefix —
// individually reactable, feeds the Phase 4 learning loop), gap question last
// (💭). A stale file from a previous date is NEVER sent; malformed = silence.

function readTodaysSparks(fileText, today) {
  const none = { sparks: [], gapQuestion: null };
  let o = null;
  try { o = JSON.parse(String(fileText == null ? '' : fileText)); } catch (err) { return none; }
  if (!o || o.date !== today) return none;
  const sparks = (Array.isArray(o.sparks) ? o.sparks : [])
    .filter(s => s && typeof s.text === 'string' && s.text.trim());
  const gapQuestion = (typeof o.gapQuestion === 'string' && o.gapQuestion.trim()) ? o.gapQuestion.trim() : null;
  return { sparks, gapQuestion };
}

function sparkMessage(s) {
  const title = (s.title && String(s.title).trim()) ? `${String(s.title).trim()}\n\n` : '';
  return `⚡ ${title}${String(s.text).trim()}`.slice(0, 4096);
}

/* --------------------------- env + telegram (thin) -------------------------- */
// Same standalone helpers pattern as evening.js — deliberately no import.

function parseEnvFile(envPath) {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch (err) { text = ''; }
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function loadMorningConfig(envPath = ENV_PATH) {
  const env = parseEnvFile(envPath);
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_ALLOWED_USER_ID || '',
    ticktickToken: env.TICKTICK_ACCESS_TOKEN || '',
    ticktickListId: env.TICKTICK_LIST_ID || ''
  };
}

function telegramJson(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 40000
      },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('bad telegram response')); } });
      }
    );
    req.on('timeout', () => req.destroy(new Error('telegram request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function composeWithClaude(prompt, cwd) {
  return new Promise(resolve => {
    const env = { ...process.env }; delete env.CLAUDECODE;
    execFile('claude', ['-p', prompt, '--max-turns', '4', '--allowedTools', ''],
      { cwd, env, timeout: 180000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) { console.error('morning compose failed:', err.message); resolve(null); return; }
        resolve(parseBrief(stdout));
      });
  });
}

/* ----------------------------------- run ----------------------------------- */

// TickTick truth before gathering — the same sync the 10pm evening report
// runs (evening.js syncTickTick: poll the ledger, mark app-checked tasks done
// in tasks.md + archive, prune). Without this, anything checked off in the
// app AFTER the evening report resurfaces as "due" in the 8am brief. Fail-soft:
// TickTick being down must never take the brief down.
async function syncTickTickTruth(rootDir, cfg, today, syncFn) {
  const fn = syncFn || require('./evening.js').syncTickTick;
  try { return await fn(rootDir, cfg, today); }
  catch (err) { console.error('ticktick sync failed (non-fatal):', err.message); return []; }
}

// Build and send the brief. Degrades at every step: TickTick fails → no blocks
// section; claude fails → plain brief. `opts.dryRun`: gather + compose to
// stdout only — no Telegram send, fully read-only.
async function runMorningBrief(cfg, opts = {}) {
  const now = opts.now || new Date();
  const rootDir = opts.rootDir || ROOT_DIR;
  const chatId = opts.chatId || cfg.chatId;
  const dryRun = !!opts.dryRun;

  if (!dryRun) await syncTickTickTruth(rootDir, cfg, localDate(now), opts.syncFn);

  const data = gather(rootDir, now);
  data.blocks = await fetchTodaysBlocks(cfg, data.today, rootDir);

  const brief = (await composeWithClaude(buildBriefPrompt(data, now), rootDir)) || plainBrief(data, now);

  // Night Shift sparks written by the 3:30am run (fail-soft at every step —
  // a delivery problem must never take the brief itself down).
  let night = { sparks: [], gapQuestion: null };
  try {
    const sparksFile = fs.readFileSync(
      path.join(rootDir, 'system', 'nightshift', 'sparks', `${data.today}.json`), 'utf8');
    night = readTodaysSparks(sparksFile, data.today);
  } catch (err) { /* no sparks file — a valid quiet night */ }

  if (dryRun) {
    console.log('--- DRY RUN: nothing sent, nothing written ---');
    console.log(brief.text);
    for (const s of night.sparks) console.log(`\n${sparkMessage(s)}`);
    if (night.gapQuestion) console.log(`\n💭 ${night.gapQuestion}`);
    console.log('\n--- dry-run data ---');
    console.log(`blocks: ${data.blocks == null ? '(TickTick unavailable)' : data.blocks.length}`);
    console.log(`tasks due/overdue: ${data.tasks.dueNow.length} (+${data.tasks.otherActive} other active)`);
    console.log(`deals hot: ${data.deals.hot.length} · cold: ${data.deals.cold.length} · nurture due: ${data.deals.nurture.length}`);
    console.log(`invitation: ${data.invitation || '(none — all behaviors touched yesterday)'}`);
    console.log(`night shift: ${night.sparks.length} spark(s)${night.gapQuestion ? ' + gap question' : ''}`);
    return { textSent: false, dryRun: true, sparksSent: 0 };
  }

  await telegramJson(cfg.token, 'sendMessage', { chat_id: chatId, text: brief.text.slice(0, 4096) });

  const sentIds = {};
  for (const s of night.sparks) {
    try {
      const res = await telegramJson(cfg.token, 'sendMessage', { chat_id: chatId, text: sparkMessage(s) });
      if (res && res.ok && res.result && s.id) sentIds[s.id] = res.result.message_id;
    } catch (err) { console.error(`spark send failed (continuing): ${err.message}`); }
  }
  if (Object.keys(sentIds).length) {
    try {
      const { markSent } = require('../nightshift/ledger.js');
      markSent(path.join(rootDir, 'system', 'nightshift', 'ledger.jsonl'), data.today, sentIds);
    } catch (err) { console.error(`ledger markSent failed (non-fatal): ${err.message}`); }
  }
  if (night.gapQuestion) {
    try {
      await telegramJson(cfg.token, 'sendMessage', { chat_id: chatId, text: `💭 ${night.gapQuestion}`.slice(0, 4096) });
    } catch (err) { console.error(`gap question send failed: ${err.message}`); }
  }

  return { textSent: true, dryRun: false, sparksSent: Object.keys(sentIds).length };
}

module.exports = {
  daysBetween, parseLooseDate, taskTitle, tasksForToday,
  parseDealNote, dealDeadlineSoon, dealGoingCold, dealNurtureDue, dealSignals, readDeals,
  behaviorInvitation, todaysBlocks, clockTime, ledgerProjectId, gather, syncTickTickTruth, pulseStaleness, researchStaleness,
  buildBriefPrompt, parseBrief, plainBrief, countsLine,
  readTodaysSparks, sparkMessage,
  loadMorningConfig, runMorningBrief
};

if (require.main === module) {
  require('../lib/log.js').installTimestamps();
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadMorningConfig();
  if (!dryRun && (!cfg.token || !cfg.chatId)) {
    console.error('morning-brief.js: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID missing from .env');
    process.exit(1);
  }
  runMorningBrief(cfg, { dryRun })
    .then(r => { if (!r.dryRun) console.log('morning brief sent'); })
    .catch(err => { console.error('morning brief crashed:', err.message); process.exit(1); });
}
