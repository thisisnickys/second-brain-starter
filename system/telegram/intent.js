'use strict';
// Voice-note intent routing. Zero deps, deterministic — no LLM call happens
// here; this only decides WHICH pipeline gets the transcript. Born from the
// Jul 12 2026 misroute where "Is that a skill that you can create and install
// it into Claude for me?" was fed to the morning-plan engine and proposed as
// a to-do (bot.js used to hardwire every voice note to the planner).

const { parseDump, parseIdeasBrief } = require('./dump.js');
const { parseIdea } = require('./idea.js');

// Spoken preamble Whisper faithfully transcribes but that says nothing about
// intent. Stripped (repeatedly) before looking at the first real sentence.
const FILLER_RE = /^(?:(?:okay|ok|alright|all right|oh|um+|uh+|so|hey|yo|hi|well|and|like)[,.!\s]+)+/i;

// Above this length a transcript is a monologue (planning/dump territory),
// never a lookup question — even if it happens to open with one.
const QUESTION_MAX_CHARS = 280;

// Skill-request shapes, most specific first. Each pattern is scoped to a
// single sentence ([^.?!]*) so a passing mention of "skill" elsewhere in a
// planning ramble can't combine with an unrelated verb.
const SKILL_PATTERNS = [
  /\bskill (this|that|it)\b/i,
  /\bis (that|this) (a )?skill\b/i,
  /\bmake (this|that|it) (a |into a )skill\b/i,
  /\b(turn|turning|convert|converting|make|making)\b[^.?!]*\binto a skill\b/i
];

// Broader create/build/install + skill shapes require "you" in the message —
// "can YOU create a skill from this" is a request to the bot; "I need to
// build a skills folder today" is a plan item and must stay one.
const SKILL_YOU_PATTERNS = [
  /\b(create|build|install)\b[^.?!]*\bskills?\b/i,
  /\bskills?\b[^.?!]*\b(create|build|install)\b/i
];

// "Turn this into a skill" in any recognized phrasing → the verbatim request
// text; null when the message merely mentions skills.
function parseSkillRequest(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  if (SKILL_PATTERNS.some(re => re.test(t))) return t;
  if (/\byou\b/i.test(t) && SKILL_YOU_PATTERNS.some(re => re.test(t))) return t;
  return null;
}

// "Can you put/add … on my (to-do/task) list" — spoken-polite todo phrasing.
// It reads as a question, so it used to fall to ask-the-brain and the task was
// lost entirely. "test list" is included deliberately:
// Whisper mishears "task list" as "test list".
const LIST_ADD_PATTERNS = [
  // "can you put on my task list (to) buy milk"
  /^(?:can|could|will|would)\s+you\s+(?:please\s+)?(?:put|add|stick)\s+(?:this\s+|that\s+)?(?:on|to|onto)\s+(?:my|the)\s+(?:to-?do|todo|task|test)?\s*list\b[,.:;!?\s]*(?:to\s+)?(.*)$/i,
  // "can you add buy milk to my list"
  /^(?:can|could|will|would)\s+you\s+(?:please\s+)?(?:put|add|stick)\s+(.+?)\s+(?:on|to|onto)\s+(?:my|the)\s+(?:to-?do|todo|task|test)?\s*list\b/i,
  // "add buy milk to my to-do list"
  /^(?:please\s+)?(?:put|add|stick)\s+(.+?)\s+(?:on|to|onto)\s+(?:my|the)\s+(?:to-?do|todo|task|test)?\s*list\b/i
];

// "Can you put X on my list" → "X"; null when the message isn't a list-add.
function parseListAdd(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return null;
  t = t.replace(FILLER_RE, '');
  for (const re of LIST_ADD_PATTERNS) {
    const m = re.exec(t);
    if (m) {
      const title = String(m[1] || '').trim()
        .replace(/^to\s+/i, '')
        .replace(/[.!?\s]+$/, '')
        .trim();
      return title || null;
    }
  }
  return null;
}

// Question words that open a lookup ("what did I decide…", "when did I say…").
const WH_RE = /^(what|what's|when|when's|where|where's|who|who's|whose|why|how|how's|which)\b/i;

// Auxiliary + subject ("is that…", "can you…", "do I…"). The subject list is
// deliberately narrow: "Do the laundry" must NOT read as a question.
const AUX_SUBJECT_RE = /^(is|are|was|were|am|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|don't|doesn't|didn't|isn't|aren't|can't|couldn't|won't|wouldn't|shouldn't)\s+(i|you|we|they|he|they|it|there|that|this|my|your)\b/i;

// True when the transcript reads as a short lookup question for the brain
// rather than day-planning speech.
function isBrainQuestion(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return false;
  if (t.length > QUESTION_MAX_CHARS) return false;
  t = t.replace(FILLER_RE, '');
  const m = t.match(/^[^.?!]*[.?!]?/);
  const first = (m ? m[0] : t).trim();
  if (!first) return false;
  if (first.endsWith('?')) return true;
  if (WH_RE.test(first)) return true;
  return AUX_SUBJECT_RE.test(first);
}

// The one router handleVoice consults. Order matters: the "brain dump"
// keyword always wins; "idea brief" and the explicit idea triggers come next
// (an idea capture must never reach the planner as a to-do proposal); a skill
// request wins over question detection (it is usually phrased as one);
// questions go to the brain only when no plan session is live (mid-session,
// "can we move X to 11pm" is a plan edit).
function routeVoice(transcript, opts = {}) {
  const t = String(transcript == null ? '' : transcript);
  const dump = parseDump(t);
  if (dump !== null) return { kind: 'dump', payload: dump };
  const brief = parseIdeasBrief(t);
  if (brief) return { kind: 'ideabrief', payload: brief };
  const idea = parseIdea(t);
  if (idea !== null) return { kind: 'idea', payload: idea };
  const listAdd = parseListAdd(t);
  if (listAdd) return { kind: 'todo', payload: listAdd };
  const skill = parseSkillRequest(t);
  if (skill) return { kind: 'skill', payload: skill };
  if (!opts.hasSession && isBrainQuestion(t)) return { kind: 'ask', payload: t.trim() };
  return { kind: 'plan', payload: t };
}

module.exports = { parseSkillRequest, isBrainQuestion, parseListAdd, routeVoice };
