const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  matchVerdict,
  parseCardBrand,
  findOpportunityNote,
  findSoleActiveToday,
  applyVerdict,
  fileVerdict
} = require('../system/telegram/deal.js');
const { noteErrors } = require('../system/lib/note-write.js');
const { localDate } = require('../system/lib/date.js');
const { classify, handleMessage } = require('../system/telegram/bot.js');

const TODAY = localDate();

/* ------------------------------ fixtures ------------------------------ */

function oppNote({ title, status, updated, log }) {
  return [
    '---',
    `title: ${title}`,
    'department: business',
    'tags: [opportunity, brand-deal]',
    'behaviors: [connect]',
    'type: file',
    'source: capture:gmail',
    `updated: ${updated}`,
    '---',
    '',
    `**Status:** ${status}`,
    '**From:** Someone <someone@example.com>',
    '**The ask:** sponsored integration',
    '',
    '## Log',
    log || '- 2026-07-01 — filed from Gmail scan',
    ''
  ].join('\n');
}

// Temp opportunities dir with fixture notes. Never touches the real wiki.
function makeOppDir(notes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-opp-'));
  for (const [file, content] of Object.entries(notes)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

/* ------------------------------ matchVerdict ------------------------------ */

test('matchVerdict: canonical verdicts match, case-insensitive, trimmed', () => {
  assert.strictEqual(matchVerdict('agree').kind, 'agree');
  assert.strictEqual(matchVerdict('  AGREE  ').kind, 'agree');
  assert.strictEqual(matchVerdict('counter $500').kind, 'counter');
  assert.strictEqual(matchVerdict('Counter with usage capped at 90 days').kind, 'counter');
  assert.strictEqual(matchVerdict('decline').kind, 'decline');
  assert.strictEqual(matchVerdict('skip').kind, 'skip');
  assert.strictEqual(matchVerdict('Draft topics').kind, 'draft');
  assert.strictEqual(matchVerdict('draft the counter email').kind, 'draft');
});

test('matchVerdict keeps the verbatim (trimmed) reply', () => {
  assert.strictEqual(matchVerdict(' counter $800 flat ').verbatim, 'counter $800 flat');
});

test('matchVerdict: non-verdicts do not match', () => {
  for (const t of ['agreed', 'skipping', 'drafts', 'counteroffer?', 'what should I counter with — thoughts?',
    'I agree with you', 'decline rate is high', '', null, undefined]) {
    assert.strictEqual(matchVerdict(t), null, `should not match: ${t}`);
  }
});

/* ------------------------------ parseCardBrand ------------------------------ */

test('parseCardBrand extracts the brand from a deal-card first line', () => {
  assert.strictEqual(parseCardBrand('💼 VidMuse — sponsored integration ($800)\nScore: Pursue\nReply: agree / counter $X / decline / skip'), 'VidMuse');
  assert.strictEqual(parseCardBrand('💼 Olight OStation — gifted product'), 'Olight OStation');
  assert.strictEqual(parseCardBrand('💼 Envato - creator partnership'), 'Envato');
});

test('parseCardBrand returns null for non-card text', () => {
  assert.strictEqual(parseCardBrand('Tonight: 3 tasks done…'), null);
  assert.strictEqual(parseCardBrand(''), null);
  assert.strictEqual(parseCardBrand(null), null);
});

/* ------------------------------ classify routing ------------------------------ */

test('classify routes bare verdicts to the deal desk, not ask', () => {
  for (const t of ['agree', 'counter $500', 'decline', 'skip', 'Draft topics']) {
    const c = classify(t);
    assert.strictEqual(c.kind, 'deal', `"${t}" should classify as deal`);
  }
  assert.strictEqual(classify('what did I decide about pricing?').kind, 'ask');
  assert.strictEqual(classify('todo: agree on the contract').kind, 'todo');
});

/* ------------------------------ note matching ------------------------------ */

test('findOpportunityNote matches a card brand to the right note (fuzzy)', () => {
  const dir = makeOppDir({
    '2026-07-07-olight-ostation.md': oppNote({ title: 'Olight OStation — gifted charging station', status: 'new', updated: '2026-07-07' }),
    '2026-07-08-vidmuse-sponsorship.md': oppNote({ title: 'VidMuse — sponsored integration', status: 'new', updated: TODAY })
  });
  assert.strictEqual(findOpportunityNote('VidMuse', dir).file, '2026-07-08-vidmuse-sponsorship.md');
  assert.strictEqual(findOpportunityNote('Olight OStation', dir).file, '2026-07-07-olight-ostation.md');
  assert.strictEqual(findOpportunityNote('Olight', dir).file, '2026-07-07-olight-ostation.md');
  assert.strictEqual(findOpportunityNote('Some Unknown Brand', dir), null);
});

/* ------------------------------ sole-active-today ------------------------------ */

test('findSoleActiveToday: exactly one new/reviewed note updated today wins', () => {
  const dir = makeOppDir({
    'old-deal.md': oppNote({ title: 'Old Brand — thing', status: 'new', updated: '2026-06-01' }),
    'won-deal.md': oppNote({ title: 'Won Brand — thing', status: 'won', updated: TODAY }),
    'live-deal.md': oppNote({ title: 'Live Brand — thing', status: 'new', updated: TODAY })
  });
  const r = findSoleActiveToday(dir);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.note.file, 'live-deal.md');
});

test('findSoleActiveToday: zero or several candidates -> no note', () => {
  const none = makeOppDir({ 'a.md': oppNote({ title: 'A — x', status: 'won', updated: TODAY }) });
  assert.strictEqual(findSoleActiveToday(none).note, null);

  const two = makeOppDir({
    'a.md': oppNote({ title: 'A — x', status: 'new', updated: TODAY }),
    'b.md': oppNote({ title: 'B — y', status: 'reviewed', updated: TODAY })
  });
  const r = findSoleActiveToday(two);
  assert.strictEqual(r.note, null);
  assert.strictEqual(r.count, 2);
});

/* ------------------------------ applyVerdict ------------------------------ */

test('applyVerdict: agree/counter/decline set Status reviewed, log + updated bumped', () => {
  const before = oppNote({ title: 'VidMuse — sponsored integration', status: 'new', updated: '2026-07-08' });
  for (const v of ['agree', 'counter $500', 'decline']) {
    const out = applyVerdict(before, { kind: matchVerdict(v).kind, verbatim: v, dateStr: '2026-07-09' });
    assert.match(out, /^\*\*Status:\*\* reviewed$/m, `${v}: status should be reviewed`);
    assert.match(out, /^updated: 2026-07-09$/m, `${v}: updated should bump`);
    assert.ok(out.includes(`- 2026-07-09 — Sam via Telegram: "${v}"`), `${v}: log line appended`);
    assert.ok(out.includes('- 2026-07-01 — filed from Gmail scan'), 'existing log kept');
    assert.deepStrictEqual(noteErrors(out), [], `${v}: result must pass the lint`);
  }
});

test('applyVerdict: skip and draft leave Status as-is', () => {
  const before = oppNote({ title: 'VidMuse — sponsored integration', status: 'new', updated: '2026-07-08' });
  for (const v of ['skip', 'Draft topics']) {
    const out = applyVerdict(before, { kind: matchVerdict(v).kind, verbatim: v, dateStr: '2026-07-09' });
    assert.match(out, /^\*\*Status:\*\* new$/m, `${v}: status untouched`);
    assert.ok(out.includes(`Sam via Telegram: "${v}"`));
    assert.deepStrictEqual(noteErrors(out), []);
  }
});

test('applyVerdict appends inside ## Log even when another section follows', () => {
  const before = oppNote({ title: 'X — y', status: 'new', updated: '2026-07-08' }).replace(/\s*$/, '\n') + '\n## Next\n\n- something\n';
  const out = applyVerdict(before, { kind: 'agree', verbatim: 'agree', dateStr: '2026-07-09' });
  const logIdx = out.indexOf('Sam via Telegram');
  const nextIdx = out.indexOf('## Next');
  assert.ok(logIdx !== -1 && nextIdx !== -1 && logIdx < nextIdx, 'log line must land before the next section');
});

test('applyVerdict creates a ## Log section when the note has none', () => {
  const before = oppNote({ title: 'X — y', status: 'new', updated: '2026-07-08' }).replace(/## Log[\s\S]*$/, '');
  const out = applyVerdict(before, { kind: 'skip', verbatim: 'skip', dateStr: '2026-07-09' });
  assert.match(out, /## Log\n- 2026-07-09 — Sam via Telegram: "skip"/);
});

/* ------------------------------ fileVerdict (lint gate) ------------------------------ */

test('fileVerdict writes a lint-clean mutation to disk', () => {
  const dir = makeOppDir({ 'deal.md': oppNote({ title: 'VidMuse — sponsorship', status: 'new', updated: '2026-07-08' }) });
  const p = path.join(dir, 'deal.md');
  fileVerdict(p, { kind: 'agree', verbatim: 'agree' });
  const after = fs.readFileSync(p, 'utf8');
  assert.match(after, /^\*\*Status:\*\* reviewed$/m);
  assert.ok(after.includes('Sam via Telegram: "agree"'));
  assert.deepStrictEqual(noteErrors(after), []);
});

test('fileVerdict refuses to land an invalid note (original untouched)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-bad-'));
  const p = path.join(dir, 'broken.md');
  const broken = '# no frontmatter here\n\n**Status:** new\n\n## Log\n- old\n';
  fs.writeFileSync(p, broken);
  assert.throws(() => fileVerdict(p, { kind: 'agree', verbatim: 'agree' }), /lint/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), broken, 'file must be unchanged');
});

/* ------------------------------ end-to-end via handleMessage ------------------------------ */

function fakeDeps(oppDir, tmp) {
  const sent = [];
  return {
    sent,
    deps: {
      oppDir,
      capturePath: path.join(tmp, 'inbox.md'),
      refreshDerived: async () => {},
      refreshGraph: () => {},
      sendMessage: async (token, chatId, text) => { sent.push(text); },
      askBrain: async () => { throw new Error('askBrain must not be called for deal replies'); }
    }
  };
}

const CFG = { token: 'tok', allowedId: '1' };

test('e2e: "Draft topics" replied to a 💼 card files onto the matching note', async () => {
  // A realistic opportunity note, written fresh into a temp dir. The test owns
  // its own fixture — it never reads from the live wiki.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-e2e-'));
  const oppDir = path.join(tmp, 'opportunities');
  fs.mkdirSync(oppDir);
  const notePath = path.join(oppDir, '2026-07-08-vidmuse-sponsorship.md');
  fs.writeFileSync(notePath, [
    '---',
    'title: VidMuse — sponsored integration',
    'department: business',
    'tags: [sponsorship, brand-deal]',
    'behaviors: [create]',
    'type: file',
    'updated: 2026-07-08',
    '---',
    '',
    '**Status:** reviewed',
    '**Offer:** $800 sponsored integration',
    '',
    '## Log',
    '- 2026-07-08 — scored 30/35, card sent',
    ''
  ].join('\n'));
  const statusBefore = fs.readFileSync(notePath, 'utf8').match(/^\*\*Status:\*\*\s*(\S+)/m)[1];

  const { sent, deps } = fakeDeps(oppDir, tmp);
  const update = {
    message: {
      chat: { id: 1 },
      text: 'Draft topics',
      reply_to_message: { message_id: 77, text: '💼 VidMuse — sponsored integration ($800)\nScore: Pursue 30/35\nReply: agree / counter $X / decline / skip' }
    }
  };
  await handleMessage(update, CFG, deps);

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^Filed ✅ — topic drafts queued for the next session\.$/);
  const after = fs.readFileSync(notePath, 'utf8');
  assert.ok(after.includes(`- ${TODAY} — Sam via Telegram: "Draft topics"`), 'log line appended');
  assert.strictEqual(after.match(/^\*\*Status:\*\*\s*(\S+)/m)[1], statusBefore, 'draft leaves Status as-is');
  assert.match(after, new RegExp(`^updated: ${TODAY}$`, 'm'));
  assert.deepStrictEqual(noteErrors(after), []);
});

test('e2e: "agree" replied to a card sets Status reviewed and confirms with the brand', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-e2e-'));
  const oppDir = path.join(tmp, 'opportunities');
  fs.mkdirSync(oppDir);
  fs.writeFileSync(path.join(oppDir, '2026-07-08-vidmuse.md'),
    oppNote({ title: 'VidMuse — sponsored integration', status: 'new', updated: TODAY }));

  const { sent, deps } = fakeDeps(oppDir, tmp);
  await handleMessage({
    message: { chat: { id: 1 }, text: 'agree', reply_to_message: { message_id: 5, text: '💼 VidMuse — sponsored integration ($800)' } }
  }, CFG, deps);

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^Filed ✅ VidMuse — "agree"\. Drafting happens in the next Claude session/);
  const after = fs.readFileSync(path.join(oppDir, '2026-07-08-vidmuse.md'), 'utf8');
  assert.match(after, /^\*\*Status:\*\* reviewed$/m);
});

test('e2e: bare verdict with ONE active-today deal resolves to it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-e2e-'));
  const oppDir = path.join(tmp, 'opportunities');
  fs.mkdirSync(oppDir);
  fs.writeFileSync(path.join(oppDir, 'live.md'), oppNote({ title: 'DramaLand — sponsorship', status: 'new', updated: TODAY }));
  fs.writeFileSync(path.join(oppDir, 'won.md'), oppNote({ title: 'Booked — gig', status: 'won', updated: TODAY }));

  const { sent, deps } = fakeDeps(oppDir, tmp);
  await handleMessage({ message: { chat: { id: 1 }, text: 'counter $1200' } }, CFG, deps);

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^Filed ✅ DramaLand — "counter \$1200"\./);
  const after = fs.readFileSync(path.join(oppDir, 'live.md'), 'utf8');
  assert.match(after, /^\*\*Status:\*\* reviewed$/m);
  assert.ok(after.includes('Sam via Telegram: "counter $1200"'));
});

test('e2e: ambiguous bare verdict asks which deal and mutates nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-e2e-'));
  const oppDir = path.join(tmp, 'opportunities');
  fs.mkdirSync(oppDir);
  const a = oppNote({ title: 'A — x', status: 'new', updated: TODAY });
  const b = oppNote({ title: 'B — y', status: 'reviewed', updated: TODAY });
  fs.writeFileSync(path.join(oppDir, 'a.md'), a);
  fs.writeFileSync(path.join(oppDir, 'b.md'), b);

  const { sent, deps } = fakeDeps(oppDir, tmp);
  await handleMessage({ message: { chat: { id: 1 }, text: 'agree' } }, CFG, deps);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0], 'Which deal? Reply to the card or name the brand.');
  assert.strictEqual(fs.readFileSync(path.join(oppDir, 'a.md'), 'utf8'), a);
  assert.strictEqual(fs.readFileSync(path.join(oppDir, 'b.md'), 'utf8'), b);
});

test('e2e: card reply whose brand matches no note asks for clarification', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-e2e-'));
  const oppDir = path.join(tmp, 'opportunities');
  fs.mkdirSync(oppDir);

  const { sent, deps } = fakeDeps(oppDir, tmp);
  await handleMessage({
    message: { chat: { id: 1 }, text: 'agree', reply_to_message: { message_id: 9, text: '💼 GhostBrand — mystery deal' } }
  }, CFG, deps);

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Which deal\? I couldn't match "GhostBrand"/);
});
