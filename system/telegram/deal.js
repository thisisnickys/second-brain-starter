'use strict';
const { OWNER } = require('../lib/config.js');
// Deal-desk verdict handling. Claude sessions (/oppty) push "deal cards" to
// Telegram — first line `💼 <Brand> — <ask>`, footer `Reply: agree / counter
// $X / decline / skip`. When the owner replies, this module files that verdict onto
// the matching note in wiki/business/opportunities/ (Log append + Status
// bump). The bot NEVER drafts emails or topics — its claude is read-scoped;
// the next session picks the verdict up from the note.
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { noteErrors } = require('../lib/note-write.js');
const { parseFrontmatter } = require('../lib/frontmatter.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const OPP_DIR = path.join(ROOT_DIR, 'wiki', 'business', 'opportunities');

// Verdict replies to a deal card. Anchored + trimmed; "agreed"/"skipping"/
// "drafts" deliberately do NOT match.
const VERDICT_RE = /^(agree|counter\b.*|decline|skip|draft topics|draft\b.*)$/i;

// Trimmed text -> { kind, verbatim } or null.
// kind ∈ agree | counter | decline | skip | draft
function matchVerdict(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || !VERDICT_RE.test(t)) return null;
  let kind;
  if (/^agree$/i.test(t)) kind = 'agree';
  else if (/^counter\b/i.test(t)) kind = 'counter';
  else if (/^decline$/i.test(t)) kind = 'decline';
  else if (/^skip$/i.test(t)) kind = 'skip';
  else kind = 'draft';
  return { kind, verbatim: t };
}

// '💼 VidMuse — sponsored integration ($800)' -> 'VidMuse'.
// Returns null when the text is not a deal card (doesn't start with 💼).
function parseCardBrand(cardText) {
  const first = String(cardText == null ? '' : cardText).split('\n')[0].trim();
  if (!first.startsWith('💼')) return null;
  const rest = first.replace(/^💼\s*/, '');
  // Brand ends at the first em/en dash or spaced hyphen separator.
  const brand = rest.split(/\s*[—–]\s*|\s+-\s+/)[0].trim();
  return brand || null;
}

// Read every opportunity note: { file, path, title, updated, status, content }.
function listOpportunityNotes(oppDir = OPP_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(oppDir).filter(f => f.endsWith('.md')).sort();
  } catch (err) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const abs = path.join(oppDir, f);
    let content = '';
    try { content = fs.readFileSync(abs, 'utf8'); } catch (err) { continue; }
    const { data } = parseFrontmatter(content);
    const status = (content.match(/^\*\*Status:\*\*\s*(\S+)/m) || [])[1] || '';
    out.push({
      file: f,
      path: abs,
      title: String((data && data.title) || f),
      updated: String((data && data.updated) || ''),
      status: status.toLowerCase(),
      content
    });
  }
  return out;
}

// Fuzzy brand -> note: slugified brand words matched (contains) against each
// note's slugified title + filename. Best score wins; ties go to the later
// filename (date-prefixed = most recent). Null when nothing matches at all.
function findOpportunityNote(brand, oppDir = OPP_DIR) {
  const tokens = slugify(brand).split('-').filter(t => t && t !== 'untitled');
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const n of listOpportunityNotes(oppDir)) {
    const hay = `${slugify(n.title)}-${n.file.toLowerCase()}`;
    let score = 0;
    for (const tok of tokens) if (hay.includes(tok)) score += 1;
    if (score > bestScore || (score === bestScore && score > 0 && best && n.file > best.file)) {
      best = n;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

// For a verdict with no reply-to context: if exactly ONE opportunity note has
// Status new/reviewed AND was updated today, that's the deal. Otherwise null.
function findSoleActiveToday(oppDir = OPP_DIR, today = localDate()) {
  const hits = listOpportunityNotes(oppDir).filter(
    n => (n.status === 'new' || n.status === 'reviewed') && n.updated === today
  );
  return { note: hits.length === 1 ? hits[0] : null, count: hits.length };
}

// Pure content transform: append the verdict to ## Log, bump Status
// (agree/counter/decline -> reviewed; skip/draft/anything else -> unchanged),
// bump frontmatter `updated:` to the local date.
function applyVerdict(content, { kind, verbatim, dateStr } = {}) {
  let out = String(content == null ? '' : content);
  const d = dateStr || localDate();

  if (kind === 'agree' || kind === 'counter' || kind === 'decline') {
    out = out.replace(/^(\*\*Status:\*\*)[^\n]*$/m, '$1 reviewed');
  }
  out = out.replace(/^updated:.*$/m, `updated: ${d}`); // frontmatter is first match

  const logLine = `- ${d} — ${OWNER.name} via Telegram: "${String(verbatim == null ? '' : verbatim).trim()}"`;
  const m = out.match(/^##\s+Log\s*$/m);
  if (!m) {
    out = out.replace(/\s*$/, '\n') + '\n## Log\n' + logLine + '\n';
  } else {
    const afterHeading = m.index + m[0].length;
    const rest = out.slice(afterHeading);
    const next = rest.search(/\n##\s+/);
    const insertAt = next === -1 ? out.length : afterHeading + next;
    const before = out.slice(0, insertAt).replace(/\s*$/, '');
    const after = out.slice(insertAt);
    out = `${before}\n${logLine}\n${after}`;
  }
  return out;
}

// Mutate the note on disk, lint-gated with rollback (same guarantee as the
// remember: route / workbench save): the new content must pass the
// frontmatter lint before AND after the write, else the original is restored
// and we throw so the caller can fall back to an inbox capture.
function fileVerdict(notePath, verdict, opts = {}) {
  const original = fs.readFileSync(notePath, 'utf8');
  const next = applyVerdict(original, {
    kind: verdict.kind,
    verbatim: verdict.verbatim,
    dateStr: opts.dateStr
  });
  const errs = noteErrors(next);
  if (errs.length) throw new Error(`deal note failed lint: ${errs.join('; ')}`);
  fs.writeFileSync(notePath, next);
  const landed = fs.readFileSync(notePath, 'utf8');
  const postErrs = noteErrors(landed);
  if (postErrs.length) {
    fs.writeFileSync(notePath, original); // rollback
    throw new Error(`deal note failed lint after write (rolled back): ${postErrs.join('; ')}`);
  }
  return next;
}

module.exports = {
  VERDICT_RE,
  matchVerdict,
  parseCardBrand,
  listOpportunityNotes,
  findOpportunityNote,
  findSoleActiveToday,
  applyVerdict,
  fileVerdict,
  OPP_DIR
};
