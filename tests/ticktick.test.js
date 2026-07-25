const { test } = require('node:test');
const assert = require('node:assert');
const { formatDate, taskPayload } = require('../system/telegram/ticktick.js');

test('formatDate emits TickTick offset format and preserves local components', () => {
  const d = new Date(2026, 6, 7, 13, 30, 0); // Jul 7 2026 1:30pm local
  const s = formatDate(d);
  assert.match(s, /^2026-07-07T13:30:00[+-]\d{4}$/, 'shape + local date/time preserved');
});

test('taskPayload for a plain to-do carries only the title (Inbox)', () => {
  const p = taskPayload({ title: 'reply to Sarah' }, null);
  assert.deepStrictEqual(p, { title: 'reply to Sarah' });
  assert.ok(!('projectId' in p) && !('startDate' in p));
});

test('taskPayload targets a list when a listId is given', () => {
  const p = taskPayload({ title: 'idea: new series' }, '6632856a87be11060ca35f8e');
  assert.strictEqual(p.projectId, '6632856a87be11060ca35f8e');
});

test('taskPayload for a timed block sets start/due, isAllDay:false, timeZone', () => {
  const start = new Date(2026, 6, 7, 14, 0, 0), end = new Date(2026, 6, 7, 15, 0, 0);
  const p = taskPayload({ title: 'edit the video', start, end }, null);
  assert.match(p.startDate, /^2026-07-07T14:00:00/);
  assert.match(p.dueDate, /^2026-07-07T15:00:00/);
  assert.strictEqual(p.isAllDay, false);
  assert.strictEqual(p.timeZone, 'America/New_York');
});

test('a timed block with no explicit end falls back to the start time', () => {
  const start = new Date(2026, 6, 7, 16, 0, 0);
  const p = taskPayload({ title: 'call bank', start }, null);
  assert.match(p.dueDate, /^2026-07-07T16:00:00/);
});
