'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { voiceLint, sourcesDiverse, validateSpark, gateSparks } = require('../system/nightshift/sparks.js');

function goodSpark(overrides) {
  return Object.assign({
    department: 'content',
    title: 'One thesis, three doors',
    text: 'Three of this week\'s captures — the Fable 5 site, the clipper automation dump, and the second brain itself — are the same idea arriving through different doors: systems that work while you sleep. That is not three projects, it is one thesis nobody in your lane owns yet. What if the next flagship video is the umbrella for all of it?',
    sources: ['wiki/content/learning/2026-07-05-fable5.md', 'wiki/personal/journal/2026-07-08-brain-dump.md']
  }, overrides || {});
}

test('voiceLint: clean observation+question text passes', () => {
  assert.deepStrictEqual(voiceLint(goodSpark().text), []);
});

test('voiceLint: imperatives are flagged', () => {
  for (const bad of ['You need to post this today.', 'You should focus on LB.',
    'Make sure you reply to that deal.', 'You must record this week.', "Don't forget the newsletter."]) {
    assert.ok(voiceLint(bad + ' Right?').length > 0, `expected flag: ${bad}`);
  }
});

test('voiceLint: observational "you have" without "to" is NOT flagged', () => {
  assert.deepStrictEqual(voiceLint('You have three drafts circling the same idea — coincidence?'), []);
});

test('voiceLint: "you have to" IS flagged', () => {
  assert.ok(voiceLint('You have to post this. Right?').length > 0);
});

test('voiceLint: text with no question mark is flagged (must end with an opening)', () => {
  assert.ok(voiceLint('This is a pattern. It is interesting.').some(p => /question/i.test(p)));
});

test('voiceLint: interrogative "do you need three channels?" is NOT flagged', () => {
  assert.deepStrictEqual(voiceLint('What if these are one system — do you need three separate channels?'), []);
});

test('voiceLint: "you need to" and "you ought to" still flagged', () => {
  assert.ok(voiceLint('You need to post. Right?').length > 0);
  assert.ok(voiceLint('You ought to post. Right?').length > 0);
});

test('voiceLint: "you\'ve got to" and "gotta" are flagged', () => {
  assert.ok(voiceLint("You've got to see this. Right?").length > 0);
  assert.ok(voiceLint('You gotta ship it. Yes?').length > 0);
});

test('sourcesDiverse: two departments -> true', () => {
  assert.strictEqual(sourcesDiverse(['wiki/content/a.md', 'wiki/business/b.md']), true);
});

test('sourcesDiverse: same dept, two distinct dates -> true', () => {
  assert.strictEqual(sourcesDiverse(['wiki/content/learning/2026-07-01-a.md', 'wiki/content/learning/2026-07-08-b.md']), true);
});

test('sourcesDiverse: same dept, same date -> false', () => {
  assert.strictEqual(sourcesDiverse(['wiki/content/learning/2026-07-08-a.md', 'wiki/content/learning/2026-07-08-b.md']), false);
});

test('sourcesDiverse: corpus sources count as their own door', () => {
  assert.strictEqual(sourcesDiverse(['wiki/content/learning/2026-07-08-a.md', 'corpus:kit:851']), true);
});

test('sourcesDiverse: same dept, undated filenames, different frontmatter updated dates -> true with rootDir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  const a = 'wiki/business/opportunities/acme-deal.md', b = 'wiki/business/pulse/stripe-baseline.md';
  for (const [rel, upd] of [[a, '2026-07-01'], [b, '2026-07-08']]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `---\ntitle: T\ndepartment: business\nupdated: ${upd}\n---\nBody.`);
  }
  assert.strictEqual(sourcesDiverse([a, b], root), true);
});

test('validateSpark: good spark against real files -> no problems', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  for (const s of goodSpark().sources) {
    fs.mkdirSync(path.join(root, path.dirname(s)), { recursive: true });
    fs.writeFileSync(path.join(root, s), 'x');
  }
  assert.deepStrictEqual(validateSpark(goodSpark(), { rootDir: root }), []);
});

test('validateSpark: missing source file is a problem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  const problems = validateSpark(goodSpark(), { rootDir: root });
  assert.ok(problems.some(p => /source/i.test(p)));
});

test('validateSpark: bad department, long title, short text, <2 sources all flagged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  assert.ok(validateSpark(goodSpark({ department: 'nope' }), { rootDir: root }).some(p => /department/i.test(p)));
  assert.ok(validateSpark(goodSpark({ title: 'x'.repeat(81) }), { rootDir: root }).some(p => /title/i.test(p)));
  assert.ok(validateSpark(goodSpark({ text: 'Too short?' }), { rootDir: root }).some(p => /text/i.test(p)));
  assert.ok(validateSpark(goodSpark({ sources: ['corpus:kit:1'] }), { rootDir: root }).some(p => /sources/i.test(p)));
});

test('gateSparks: keeps valid, drops invalid with reasons, caps at max', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  for (const s of goodSpark().sources) {
    fs.mkdirSync(path.join(root, path.dirname(s)), { recursive: true });
    fs.writeFileSync(path.join(root, s), 'x');
  }
  const bad = goodSpark({ text: 'You need to do this now. No question.' });
  const r = gateSparks([goodSpark(), bad, goodSpark(), goodSpark(), goodSpark()], { rootDir: root, max: 3 });
  assert.strictEqual(r.kept.length, 3);
  assert.strictEqual(r.dropped.length, 2); // 1 invalid + 1 over cap
  assert.ok(r.dropped[0].problems.length > 0);
});
