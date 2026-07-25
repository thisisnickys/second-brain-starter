const { test } = require('node:test');
const assert = require('node:assert');

const { isBrainQuestion, parseSkillRequest, routeVoice } = require('../system/telegram/intent.js');

/* ------------------------------- parseSkillRequest ------------------------------- */

test('parseSkillRequest matches the Jul 12 voice message that started this', () => {
  const t = 'Is that a skill that you can create and install it into Claude for me?';
  assert.strictEqual(parseSkillRequest(t), t);
});

test('parseSkillRequest matches explicit forms', () => {
  for (const t of [
    'skill this',
    'Skill that reel please',
    'can you make that a skill',
    'turn this into a skill',
    'Turn the reel from earlier into a skill',
    'can you create a skill from this for me? you know the one'
  ]) {
    assert.ok(parseSkillRequest(t), `should match: ${t}`);
  }
});

test('parseSkillRequest ignores planning talk that merely mentions skills', () => {
  for (const t of [
    'I need to update my clipper skill and make it better with this new style',
    'today I gotta build a skills folder for the video agent',
    'Find clipper styles for better retention',
    'Okay so here is what I gotta do today, post the LB report and write the substack'
  ]) {
    assert.strictEqual(parseSkillRequest(t), null, `should NOT match: ${t}`);
  }
});

/* -------------------------------- isBrainQuestion -------------------------------- */

test('isBrainQuestion recognizes short spoken questions (with filler)', () => {
  for (const t of [
    'Yo, can you give me when I said this?',
    'When did I capture that article about the AI watchdog',
    'What did I decide about thumbnails?',
    'Is the substack done?',
    'Do I have anything on the calendar tomorrow?'
  ]) {
    assert.strictEqual(isBrainQuestion(t), true, `should be question: ${t}`);
  }
});

test('isBrainQuestion leaves real planning voice notes alone', () => {
  // Verbatim (truncated) transcripts from ~/Library/Logs/second-brain-bot.log
  for (const t of [
    'Okay, so it is 1.50. I\'m walking cuddles a little bit of a late start today, so Things I got to do still working on The clipper agent that I have there\'s two clips that we started doing',
    'Oh, let\'s add first thing, um, I need to walk. I need to go for a walk, so let\'s add that first and then everything else.',
    'Oh, I have to make sure that I post on Content Corner for the Instagram and TikTok page.',
    'OK, add this to things I need to do. So I need to prepare my Claude for when I am traveling.',
    'Okay so here\'s some of the things that has to happen today. So Chachi BT is launching 5.6',
    'Do the laundry and pack for the cruise'
  ]) {
    assert.strictEqual(isBrainQuestion(t), false, `should NOT be question: ${t}`);
  }
});

test('isBrainQuestion vetoes long monologues even if they open with a question', () => {
  const long = 'What do I gotta do today? Okay so first the thumbnails, then release the video, ' +
    'run the A-B test, go for a walk, put away laundry, pack for the cruise, check my passport, ' +
    'post for ET, write the substack, and check in with Moose about the one o\'clock. ' +
    'Also need to look at the live from yesterday and get the clips going for Content Corner.';
  assert.strictEqual(isBrainQuestion(long), false);
});

/* ----------------------------------- routeVoice ----------------------------------- */

test('routeVoice: brain dump keyword still wins over everything', () => {
  const r = routeVoice('Brain dump. Today I learned that consistency beats intensity.', { hasSession: false });
  assert.strictEqual(r.kind, 'dump');
  assert.ok(r.payload.includes('consistency'));
});

test('routeVoice: skill request routes to skill even though it is phrased as a question', () => {
  const r = routeVoice('Is that a skill that you can create and install it into Claude for me?', { hasSession: false });
  assert.strictEqual(r.kind, 'skill');
});

test('routeVoice: question with no live plan session goes to the brain', () => {
  const r = routeVoice('When did I say that thing about retention?', { hasSession: false });
  assert.strictEqual(r.kind, 'ask');
});

test('routeVoice: question DURING a live plan session stays a plan edit', () => {
  const r = routeVoice('Can we move the substack to 11 p.m.', { hasSession: true });
  assert.strictEqual(r.kind, 'plan');
});

test('routeVoice: normal planning voice note goes to the plan engine', () => {
  const r = routeVoice('Okay, so this is what I gotta do today. Post the LB report, get my nails done, write the substack.', { hasSession: false });
  assert.strictEqual(r.kind, 'plan');
});
