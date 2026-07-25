'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stamp, installTimestamps } = require('../system/lib/log.js');

test('stamp formats local date-time as YYYY-MM-DD HH:MM:SS', () => {
  const d = new Date(2026, 6, 9, 7, 5, 3); // Jul 9 2026 07:05:03 local
  assert.strictEqual(stamp(d), '2026-07-09 07:05:03');
});

test('stamp pads all fields', () => {
  const d = new Date(2026, 0, 1, 0, 0, 0);
  assert.strictEqual(stamp(d), '2026-01-01 00:00:00');
});

test('installTimestamps prefixes log/warn/error with a bracketed stamp', () => {
  const calls = [];
  const fake = {
    log: (...a) => calls.push(['log', a]),
    warn: (...a) => calls.push(['warn', a]),
    error: (...a) => calls.push(['error', a])
  };
  installTimestamps(fake);
  fake.log('hello');
  fake.error('boom', 'detail');
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0][1][0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
  assert.strictEqual(calls[0][1][1], 'hello');
  assert.strictEqual(calls[1][0], 'error');
  assert.strictEqual(calls[1][1][2], 'detail');
});

test('installTimestamps is idempotent (no double prefix)', () => {
  const calls = [];
  const fake = { log: (...a) => calls.push(a), warn: () => {}, error: () => {} };
  installTimestamps(fake);
  installTimestamps(fake);
  fake.log('x');
  assert.strictEqual(calls.length, 1);
  const stamps = calls[0].filter(a => /^\[\d{4}-\d{2}-\d{2} /.test(String(a)));
  assert.strictEqual(stamps.length, 1);
});
