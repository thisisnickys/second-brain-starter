const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  recordLastCapture,
  loadLastCapture,
  queueSkillRequest
} = require('../system/telegram/skill-request.js');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillreq-'));
  return path.join(dir, name);
}

/* ------------------------- last-capture pointer ------------------------- */

test('recordLastCapture + loadLastCapture round-trip', () => {
  const file = tmpFile('last-capture.json');
  recordLastCapture({
    kind: 'social',
    title: 'Building a Short-Form Video Agent Skills Folder with Claude Fable 5',
    wikiPath: 'wiki/content/learning/2026-07-12-building-a-short-form-video-agent.md',
    transcriptPath: 'raw/transcripts/2026-07-12-building-a-short-form-video-agent.md',
    url: 'https://www.instagram.com/reel/DaTi5tkygqp/'
  }, { filePath: file });
  const got = loadLastCapture({ filePath: file });
  assert.strictEqual(got.kind, 'social');
  assert.ok(got.title.startsWith('Building a Short-Form'));
  assert.ok(got.at, 'stamps a date');
});

test('loadLastCapture returns null when nothing recorded or file corrupt', () => {
  assert.strictEqual(loadLastCapture({ filePath: tmpFile('nope.json') }), null);
  const bad = tmpFile('bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.strictEqual(loadLastCapture({ filePath: bad }), null);
});

/* --------------------------- skill request queue --------------------------- */

test('queueSkillRequest writes a pending request file linked to the capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillreq-q-'));
  const r = queueSkillRequest(
    'Is that a skill that you can create and install it into Claude for me?',
    {
      title: 'Building a Short-Form Video Agent Skills Folder',
      wikiPath: 'wiki/content/learning/2026-07-12-building.md',
      transcriptPath: 'raw/transcripts/2026-07-12-building.md',
      url: 'https://www.instagram.com/reel/DaTi5tkygqp/'
    },
    { dir, dateStr: '2026-07-12' }
  );
  assert.ok(fs.existsSync(r.path), 'request file exists');
  assert.ok(path.basename(r.path).startsWith('2026-07-12-'), 'filename is date-stamped');
  const body = fs.readFileSync(r.path, 'utf8');
  assert.ok(body.includes('status: pending'));
  assert.ok(body.includes('wiki/content/learning/2026-07-12-building.md'));
  assert.ok(body.includes('Is that a skill that you can create'));
});

test('queueSkillRequest works without a capture (verbatim-only request)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillreq-q-'));
  const r = queueSkillRequest('skill this: a daily hook generator', null, { dir, dateStr: '2026-07-12' });
  const body = fs.readFileSync(r.path, 'utf8');
  assert.ok(body.includes('a daily hook generator'));
  assert.ok(body.includes('status: pending'));
});

test('queueSkillRequest never overwrites an existing request the same day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillreq-q-'));
  const a = queueSkillRequest('skill this', { title: 'Same Title' }, { dir, dateStr: '2026-07-12' });
  const b = queueSkillRequest('skill this again', { title: 'Same Title' }, { dir, dateStr: '2026-07-12' });
  assert.notStrictEqual(a.path, b.path);
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
});
