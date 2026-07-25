'use strict';
const { DEPARTMENTS, OWNER, ownerLine } = require('../lib/config.js');
// Builds the Night Shift prompt and parses the model's JSON back out.
// The prompt is the product spec in miniature: validated spark shape,
// hard voice rules, silence-is-valid, don't repeat recent sparks.

function buildPrompt({ date, delta, compass, recentLedger, rootDir }) {
  const noteLines = (delta.notes || [])
    .map(n => `- [${n.department}] ${n.title} (${n.path}, updated ${n.updated})`).join('\n') || '- (none)';
  const compassBlocks = Object.entries(compass || {})
    .filter(([, body]) => String(body || '').trim())
    .map(([dept, body]) => `### ${dept} compass\n${String(body).trim()}`).join('\n\n') || '(no compass pages yet)';
  const priorLines = (recentLedger || [])
    .map(e => `- [${e.date}] ${e.title}${e.reaction ? ' (🔥 HIT)' : ''}`).join('\n') || '- (none)';

  return [
    `You are the Night Shift of this second brain. Date: ${date}. Repo root: ${rootDir}.`,
    '',
    `${ownerLine()} Everything below is ${OWNER.pronouns.possessive} own material.`,
    'Your ONE job: forward synthesis. Find where several recent activities are secretly ONE bigger idea,',
    'and hand it back as a spark: pattern -> thesis -> opportunity. It must feel like THEIR OWN idea, freshly seen.',
    '',
    '## Today\'s activity (the delta)',
    noteLines,
    '',
    '## The Compass (what the owner is building — a lens for noticing, NEVER a scorecard)',
    compassBlocks,
    '',
    '## Recent sparks (do NOT repeat these themes; 🔥 HIT marks what landed — prefer more like those)',
    priorLines,
    '',
    '## How to explore',
    `Search old material for resonance with today's delta before concluding anything:`,
    `- node ${rootDir}/system/brain.js "<query>"   (the knowledge base)`,
    `- node ${rootDir}/system/corpus.js "<query>"  (everything the owner has published)`,
    'Read any wiki file that looks relevant. Cite only real paths you actually saw.',
    '',
    '## Voice rules (violations are dropped by a code-level gate — waste nothing)',
    '- Observation + question. NO imperatives: never "you need to / you should / make sure".',
    '- Forward-facing only: no nostalgia framing, no behavior-nagging, no gap-pointing.',
    '- Each spark ends with an opening (a question or a "what if"), not an order.',
    '- 0 sparks is a valid, respected answer. Silence beats a manufactured insight.',
    '- Plain language. If any metric or acronym appears — HRV, resting heart',
    '  rate, CTR, retention, MRR — explain it in everyday words the FIRST time: what it is, what this',
    '  reading means, and what it suggests. Assume the term is brand new to them. "Heart-rate variability',
    '  (HRV) — how recovered your body is; higher is better — has dropped from ~60 to ~40" beats "HRV 42ms".',
    '  Everyday terms used daily in their own work need NO explainer.',
    '',
    '## Format (these get read on a phone; one long paragraph gets scrolled past)',
    '- "text" is 3–5 short bullets, each its own line starting "• ", ONE idea per bullet.',
    '- Bullet flow: what happened (the pattern) → what it means (the thesis) → what it could become (the opportunity).',
    '- The final line is the question or "what if" on its OWN line, no bullet.',
    '- Blank line between the bullets and the closing question.',
    '',
    '## The novelty bar — this is what separates a hit from a scroll-past',
    '- A spark must surface at least one pattern or fact the owner has NOT already seen or said.',
    '  Recombining what they personally wrote, captured, or decided this week — however elegantly — is',
    '  a MIRROR, not a spark. They were there. Drop it.',
    '- The best sparks cross data they do not read directly (the deal inbox, the deep published corpus,',
    '  research feeds, long-forgotten notes) with what they are doing right now. Information',
    '  asymmetry is the product: tell them what their own data knows that they do not.',
    '- Test before including: "could they have written this spark from memory?" If yes, drop it.',
    '',
    '## Output contract',
    'After exploring, output — as the LAST thing you print — exactly one JSON object:',
    `{"sparks":[{"department":"${DEPARTMENTS.join('|')}","title":"<=80 chars",`,
    '"text":"150-1100 chars, newline-separated • bullets + closing question line (see Format)","sources":["wiki/... or corpus:<platform>:<id>", "... >=2, must span 2+ departments or 2+ distinct days (filename or note \'updated\' date)"]}],',
    '"gapQuestion": null or "ONE question ONLY if a compass hole blocked you"}',
    'Maximum 3 sparks. No markdown fences around the JSON.'
  ].join('\n');
}

function parseOutput(stdout) {
  const empty = { sparks: [], gapQuestion: null, found: false };
  const s = String(stdout == null ? '' : stdout);

  // Forward, string-aware scan: record every top-level balanced {...} span.
  // Tracks whether we're inside a JSON string (and backslash-escapes) so
  // braces that appear inside string values never affect nesting depth.
  const spans = [];
  let depth = 0;
  let spanStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) spanStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && spanStart !== -1) {
          spans.push(s.slice(spanStart, i + 1));
          spanStart = -1;
        }
      }
    }
  }

  // Parse from the latest span to the earliest; return the first that
  // yields an object with an Array sparks property.
  for (let i = spans.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(spans[i]);
      if (obj && Array.isArray(obj.sparks)) {
        return { sparks: obj.sparks, gapQuestion: typeof obj.gapQuestion === 'string' && obj.gapQuestion.trim() ? obj.gapQuestion.trim() : null, found: true };
      }
    } catch (err) { /* try the next span */ }
  }
  return empty;
}

module.exports = { buildPrompt, parseOutput };
