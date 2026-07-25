'use strict';
// Plan-session persistence — the bot's conversational plan sessions used to
// live only in the in-memory `sessions` Map, and the bot restarts ~2×/day
// (network blips, kickstarts). A restart between a spoken plan and the
// "yes" silently ate the whole plan — every item in it, gone. Every
// session mutation now mirrors to disk; startup rehydrates SAME-DAY sessions
// (a plan is a plan for today — yesterday's proposal must not resurrect).
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

function storePath(rootDir) {
  return path.join(rootDir || ROOT_DIR, 'system', 'logs', 'plan-sessions.json');
}

function readStore(rootDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(storePath(rootDir), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) { return {}; }
}

function writeStore(rootDir, obj) {
  const p = storePath(rootDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

function saveSession(key, sess, rootDir, now) {
  const st = readStore(rootDir);
  st[String(key)] = {
    plan: Array.isArray(sess.plan) ? sess.plan : [],
    busy: Array.isArray(sess.busy) ? sess.busy : [],
    date: localDate(now instanceof Date ? now : new Date())
  };
  writeStore(rootDir, st);
}

function clearSession(key, rootDir) {
  const st = readStore(rootDir);
  if (st[String(key)] === undefined) return;
  delete st[String(key)];
  writeStore(rootDir, st);
}

// Same-local-date sessions only, as a Map ready to be the bot's `sessions`.
function loadSessions(rootDir, now) {
  const today = localDate(now instanceof Date ? now : new Date());
  const out = new Map();
  for (const [k, v] of Object.entries(readStore(rootDir))) {
    if (v && v.date === today && Array.isArray(v.plan)) {
      out.set(k, { plan: v.plan, busy: Array.isArray(v.busy) ? v.busy : [] });
    }
  }
  return out;
}

module.exports = { storePath, saveSession, clearSession, loadSessions };
