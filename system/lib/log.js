'use strict';
// Local-time log timestamps for the launchd entry points (bot, morning,
// evening). Logs were untimestamped, which made incident triage impossible —
// a two-day-old TickTick 401 was indistinguishable from a live one.

function stamp(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Wraps console.log/warn/error so every line carries [YYYY-MM-DD HH:MM:SS].
// Call from `require.main === module` blocks only — imported modules and
// tests keep the plain console. Idempotent.
function installTimestamps(c) {
  c = c || console;
  if (c.__tsInstalled) return c;
  for (const m of ['log', 'warn', 'error']) {
    const orig = c[m].bind(c);
    c[m] = (...args) => orig(`[${stamp()}]`, ...args);
  }
  c.__tsInstalled = true;
  return c;
}

module.exports = { stamp, installTimestamps };
