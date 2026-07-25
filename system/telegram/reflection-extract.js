'use strict';
// Mines the owner's reflections and journal entries for the two things the Jul 22
// 2026 audit found rotting in the archive:
//   1. SYSTEM ASKS — feature/fix requests aimed at the second brain itself.
//      ("I gotta fix the second brain to ask the connect question at night"
//      sat in a weekly reflection with nothing acting on it.) These queue
//      into skill-requests/ so the next Claude session builds them.
//   2. PEOPLE she names in a connect answer — upserted as person pages, which
//      fills the empty people layer AND arms the Limitless connect gate.
// Tool-less claude -p, same pattern as dump/idea distills. Fail-soft callers.
const { execFile } = require('child_process');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

/* ------------------------------- pure ---------------------------------- */

function buildReflectionPrompt(question, answer) {
  return [
    'the owner answered her nightly reflection question. Extract ONLY what is explicitly there.',
    '',
    `Question: "${String(question == null ? '' : question)}"`,
    'Her answer:',
    '"""',
    String(answer == null ? '' : answer),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence):',
    '{"people": [{"name": "...", "context": "..."}], "system_asks": ["..."]}',
    '- people: actual humans SHE personally connected with (talked, texted, called, met),',
    '  per her answer. Use the name as she said it ("my mom" → "Mom"). NOT media figures',
    '  she watched or listened to, NOT people merely mentioned in passing. context = one',
    '  short clause on what happened. [] when none.',
    '- system_asks: explicit requests to change, fix, or add something to her second-brain',
    '  system / bot / reports ("it should ask me…", "fix the brain to…", "I want it to',
    '  track…"). One sentence each, her meaning kept. [] when none — do NOT invent asks.'
  ].join('\n');
}

function buildJournalPrompt(text) {
  return [
    "This is the owner's journal entry for today. Extract ONLY explicit requests to change,",
    'fix, or add something to her SECOND-BRAIN system / Telegram bot / reports',
    '("it should ask me…", "fix the brain to…", "I want it to track…").',
    'General life goals, tasks, and content ideas are NOT system asks.',
    '',
    'Journal:',
    '"""',
    String(text == null ? '' : text),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence): {"system_asks": ["..."]}',
    '[] when none — do NOT invent asks.'
  ].join('\n');
}

const NON_NAMES = /^(me|you|he|she|him|her|it|they|them|us|we|myself|someone|somebody|anyone|no one|nobody|everyone|everybody|people|friends?|family|god|jesus|owner)$/i;

// Model reply → { people: [{name, context}], system_asks: [string] },
// sanitized hard: bad JSON → empty result, junk names/asks dropped.
function parseExtract(stdout) {
  const empty = { people: [], system_asks: [] };
  const s = String(stdout == null ? '' : stdout);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return empty;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch (err) { return empty; }
  const people = [];
  for (const p of Array.isArray(obj.people) ? obj.people : []) {
    const name = String((p && p.name) || '').trim().replace(/[.,!?]+$/, '');
    if (!name || name.length > 40 || NON_NAMES.test(name)) continue;
    if (!/^[a-z][a-z .'’-]*$/i.test(name)) continue;
    people.push({ name, context: String((p && p.context) || '').trim().slice(0, 200) });
    if (people.length >= 6) break;
  }
  const system_asks = [];
  for (const raw of Array.isArray(obj.system_asks) ? obj.system_asks : []) {
    const ask = String(raw == null ? '' : raw).trim();
    if (ask.length < 10 || ask.length > 300) continue;
    system_asks.push(ask);
    if (system_asks.length >= 3) break;
  }
  return { people, system_asks };
}

/* ----------------------------- orchestration ---------------------------- */

function runClaude(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', prompt, '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 90000, maxBuffer: 4 << 20 },
      (err, stdout) => err ? reject(err) : resolve(String(stdout || '')));
  });
}

async function extractFromReflection(question, answer, opts = {}) {
  return parseExtract(await runClaude(buildReflectionPrompt(question, answer), opts));
}

async function extractFromJournal(text, opts = {}) {
  const out = parseExtract(await runClaude(buildJournalPrompt(text), opts));
  return { people: [], system_asks: out.system_asks };
}

module.exports = {
  buildReflectionPrompt, buildJournalPrompt, parseExtract,
  extractFromReflection, extractFromJournal
};
