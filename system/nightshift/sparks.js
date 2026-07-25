'use strict';
// Spark quality gate — code, not vibes (spec §2). The model proposes; this
// module decides what is allowed to reach the owner. Silence beats a weak spark.
const fs = require('fs');
const path = require('path');

const { DEPARTMENTS } = require('../lib/config.js');
// Directive phrasings that make a spark feel like being managed. Validated
// with the owner: imperatives kill the trigger. Extend as new ones slip through.
const IMPERATIVE_RES = [
  /\byou (need|ought) to\b/i,
  /\byou should\b/i,
  /\byou have to\b/i,
  /\byou must\b/i,
  /\bmake sure (you|to)\b/i,
  /\bdon'?t forget\b/i,
  /\byou'?d better\b/i,
  /\byou'?ve got to\b/i,
  /\bgotta\b/i
];
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function voiceLint(text) {
  const t = String(text == null ? '' : text);
  const problems = [];
  for (const re of IMPERATIVE_RES) {
    const m = t.match(re);
    if (m) problems.push(`imperative phrasing: "${m[0]}"`);
  }
  if (!t.includes('?')) problems.push('no question — a spark ends with an opening, not a statement');
  return problems;
}

// A spark must arrive through ≥2 doors: different departments, or the same
// department on different days. Corpus references (corpus:<platform>:<id>)
// count as a door named by their platform.
function frontmatterUpdatedDate(rootDir, src) {
  if (!rootDir) return null;
  try {
    const text = fs.readFileSync(path.join(rootDir, String(src)), 'utf8');
    const m = text.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
    return m ? m[1] : null;
  } catch (err) { return null; }
}

function sourceDoor(src, rootDir) {
  const s = String(src);
  if (s.startsWith('corpus:')) return { dept: s.split(':')[1] || 'corpus', date: null };
  const m = s.match(/^wiki\/([^/]+)\//);
  const filenameDate = (path.basename(s).match(DATE_RE) || [])[1] || null;
  const date = filenameDate || frontmatterUpdatedDate(rootDir, s);
  return { dept: m ? m[1] : 'other', date };
}

function sourcesDiverse(sources, rootDir) {
  const doors = (sources || []).map(src => sourceDoor(src, rootDir));
  const depts = new Set(doors.map(d => d.dept));
  if (depts.size >= 2) return true;
  const dates = new Set(doors.map(d => d.date).filter(Boolean));
  return dates.size >= 2;
}

function validateSpark(spark, { rootDir }) {
  const problems = [];
  const s = spark || {};
  if (!DEPARTMENTS.includes(s.department)) problems.push(`department must be one of ${DEPARTMENTS.join('/')}`);
  const title = String(s.title == null ? '' : s.title).trim();
  if (!title || title.length > 80) problems.push('title required, ≤80 chars');
  const text = String(s.text == null ? '' : s.text).trim();
  // 1100 (was 900): bullet format + plain-language metric explainers (the owner
  // feedback Jul 10 2026) need the extra room.
  if (text.length < 100 || text.length > 1100) problems.push('text must be 100–1100 chars');
  problems.push(...voiceLint(text));
  const sources = Array.isArray(s.sources) ? s.sources : [];
  if (sources.length < 2) problems.push('sources: at least 2 required');
  for (const src of sources) {
    if (String(src).startsWith('corpus:')) continue;
    if (/\.\./.test(String(src)) || path.isAbsolute(String(src))) { problems.push(`source outside repo: ${src}`); continue; }
    if (!fs.existsSync(path.join(rootDir, String(src)))) problems.push(`source does not exist: ${src}`);
  }
  if (sources.length >= 2 && !sourcesDiverse(sources, rootDir)) {
    problems.push('sources not diverse — need 2+ departments or 2+ distinct dates');
  }
  return problems;
}

function gateSparks(sparks, { rootDir, max = 3 }) {
  const kept = [], dropped = [];
  for (const spark of Array.isArray(sparks) ? sparks : []) {
    const problems = validateSpark(spark, { rootDir });
    if (problems.length) { dropped.push({ spark, problems }); continue; }
    if (kept.length >= max) { dropped.push({ spark, problems: [`over the ${max}-spark cap — scarcity is the product`] }); continue; }
    kept.push(spark);
  }
  return { kept, dropped };
}

module.exports = { voiceLint, sourcesDiverse, validateSpark, gateSparks, DEPARTMENTS };
