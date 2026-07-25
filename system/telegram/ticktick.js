'use strict';
// TickTick Open API client. Pure request-building (payload + date formatting) is
// unit-tested; the network call is a thin wrapper. Token comes from .env
// (TICKTICK_ACCESS_TOKEN); optional TICKTICK_LIST_ID targets a specific list
// (omitted → the task lands in the Inbox).
const https = require('https');

const API = 'https://api.ticktick.com/open/v1';

// TickTick wants dates like 2026-07-07T13:00:00-0400 (offset, no colon).
// We format in the machine's LOCAL timezone (the bot runs on the owner's Mac, ET).
function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();               // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(off) / 60)), om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}${om}`;
}

// Build the create-task JSON body. A timed block sets start+due (isAllDay:false);
// a plain to-do with no time is left dateless.
function taskPayload(todo, listId) {
  const body = { title: todo.title };
  if (listId) body.projectId = listId;
  if (todo.start instanceof Date) {
    body.startDate = formatDate(todo.start);
    body.dueDate = formatDate(todo.end instanceof Date ? todo.end : todo.start);
    body.isAllDay = false;
    body.timeZone = 'America/New_York';
  }
  return body;
}

function request(method, pathPart, token, json) {
  return new Promise((resolve, reject) => {
    const data = json ? JSON.stringify(json) : null;
    const u = new URL(API + pathPart);
    const headers = { 'Authorization': `Bearer ${token}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request(u, { method, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// createTask(todo, {token, listId}) → { ok, id?, projectId?, error? }
// projectId is needed later to read the task's completion status back.
async function createTask(todo, opts) {
  const { token, listId } = opts || {};
  if (!token) return { ok: false, error: 'no TickTick token' };
  try {
    const r = await request('POST', '/task', token, taskPayload(todo, listId));
    if (r.status >= 200 && r.status < 300) {
      let id = null, projectId = null;
      try { const t = JSON.parse(r.body); id = t.id || null; projectId = t.projectId || null; } catch (e) { /* optional */ }
      return { ok: true, id, projectId };
    }
    return { ok: false, error: `TickTick ${r.status}: ${r.body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// getTask(projectId, taskId, {token}) → { ok, task?, error? }.
// task.status 2 = completed (task.completedTime carries when); 0 = open.
async function getTask(projectId, taskId, opts) {
  const { token } = opts || {};
  if (!token) return { ok: false, error: 'no TickTick token' };
  try {
    const r = await request('GET', `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`, token, null);
    if (r.status >= 200 && r.status < 300) {
      try { return { ok: true, task: JSON.parse(r.body) }; } catch (e) { return { ok: false, error: 'bad TickTick response' }; }
    }
    return { ok: false, error: `TickTick ${r.status}: ${r.body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The Open API accepts the literal project id "inbox" for the user's Inbox
// (verified live Jul 8 2026 — GET /project/inbox/data → 200 with tasks).
// Used as the busy-fetch fallback when TICKTICK_LIST_ID isn't set.
const INBOX_PROJECT_ID = 'inbox';

// listProjectTasks(token, projectId) → array of OPEN tasks in the project
// (GET /project/{id}/data returns undone tasks only). Unlike createTask/getTask
// this THROWS on any failure (no token, HTTP error, bad JSON) — callers are
// expected to fail-soft themselves (the morning planner just plans without
// busy info).
async function listProjectTasks(token, projectId) {
  if (!token) throw new Error('no TickTick token');
  const r = await request('GET', `/project/${encodeURIComponent(projectId)}/data`, token, null);
  if (r.status < 200 || r.status >= 300) throw new Error(`TickTick ${r.status}: ${r.body.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(r.body); } catch (e) { throw new Error('bad TickTick response'); }
  return parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
}

module.exports = { formatDate, taskPayload, createTask, getTask, listProjectTasks, INBOX_PROJECT_ID, API };
