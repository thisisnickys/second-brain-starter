const { test } = require('node:test');
const assert = require('node:assert');
const { parseFrontmatter, validatePage } = require('../system/lib/frontmatter.js');

const GOOD = `---
title: Retention Playbook
department: content
tags: [retention, youtube]
behaviors: [create, learn]
source: memory:channel-health-feb2026.md
updated: 2026-07-06
---

# Retention Playbook
Body text.`;

test('parses valid frontmatter', () => {
  const { data, body, errors } = parseFrontmatter(GOOD);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(data.title, 'Retention Playbook');
  assert.strictEqual(data.department, 'content');
  assert.deepStrictEqual(data.tags, ['retention', 'youtube']);
  assert.deepStrictEqual(data.behaviors, ['create', 'learn']);
  assert.match(body, /^# Retention Playbook/m);
});

test('missing frontmatter block is an error', () => {
  const { errors } = parseFrontmatter('# No frontmatter');
  assert.ok(errors.length > 0);
});

test('validatePage rejects bad department and behavior', () => {
  const errs = validatePage({ title: 'X', department: 'marketing',
    tags: [], behaviors: ['hustle'], updated: '2026-07-06' });
  assert.ok(errs.some(e => e.includes('department')));
  assert.ok(errs.some(e => e.includes('behavior')));
});

test('validatePage rejects missing title and bad date', () => {
  const errs = validatePage({ title: '', department: 'content',
    tags: [], behaviors: [], updated: 'yesterday' });
  assert.ok(errs.some(e => e.includes('title')));
  assert.ok(errs.some(e => e.includes('updated')));
});

test('strips BOM and normalizes CRLF', () => {
  const crlf = '\uFEFF---\r\ntitle: X\r\ndepartment: content\r\ntags: []\r\nbehaviors: []\r\nupdated: 2026-07-06\r\n---\r\nBody';
  const { data, errors } = parseFrontmatter(crlf);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(data.title, 'X');
});

test('hash without surrounding space is not a comment', () => {
  const { data } = parseFrontmatter('---\ntitle: Top 5 #shorts ideas\ndepartment: content\ntags: []\nbehaviors: []\nupdated: 2026-07-06\n---\nB');
  assert.strictEqual(data.title, 'Top 5 #shorts ideas');
});

test('spaced hash still strips comments', () => {
  const { data } = parseFrontmatter('---\ntitle: X\ndepartment: content\ntags: []\nbehaviors: []   # optional note\nupdated: 2026-07-06\n---\nB');
  assert.deepStrictEqual(data.behaviors, []);
});

test('optional type field validated against TYPES', () => {
  const { validatePage } = require('../system/lib/frontmatter.js');
  assert.deepStrictEqual(validatePage({ title: 'X', department: 'content', tags: [], behaviors: [], updated: '2026-07-06', type: 'decision' }), []);
  const errs = validatePage({ title: 'X', department: 'content', tags: [], behaviors: [], updated: '2026-07-06', type: 'wizard' });
  assert.ok(errs.some(e => e.includes('type')));
});

test('type: compass is a valid frontmatter type', () => {
  const { validatePage } = require('../system/lib/frontmatter.js');
  assert.deepStrictEqual(validatePage({ title: 'Business Compass', department: 'business', tags: [], behaviors: [], updated: '2026-07-09', type: 'compass' }), []);
});
