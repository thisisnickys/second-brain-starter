'use strict';
// Minimal strict frontmatter for OUR format only (not general YAML):
//   key: value            -> string
//   key: [a, b, c]        -> array of trimmed strings
const { DEPARTMENTS, BEHAVIORS } = require('./config.js');
const TYPES = ['file', 'decision', 'person', 'compass'];

function parseFrontmatter(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const errors = [];
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text, errors: ['no frontmatter block'] };
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const noComment = line.replace(/\s+#\s.*$/, '');
    const kv = noComment.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) { errors.push(`unparseable line: "${line}"`); continue; }
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val.startsWith('[')) {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
      data[key] = inner ? inner.split(',').map(s => s.trim()) : [];
    } else {
      data[key] = val;
    }
  }
  return { data, body: m[2], errors };
}

function validatePage(data) {
  const errs = [];
  if (!data.title || !String(data.title).trim()) errs.push('title: required');
  if (!DEPARTMENTS.includes(data.department))
    errs.push(`department: "${data.department}" not in ${DEPARTMENTS.join('|')}`);
  if (!Array.isArray(data.tags)) errs.push('tags: must be an array');
  const behaviors = data.behaviors || [];
  if (!Array.isArray(behaviors)) errs.push('behaviors: must be an array');
  else for (const b of behaviors)
    if (!BEHAVIORS.includes(b)) errs.push(`behavior: "${b}" not in ${BEHAVIORS.join('|')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated || ''))
    errs.push(`updated: "${data.updated}" must be YYYY-MM-DD`);
  if (data.type !== undefined && !TYPES.includes(data.type))
    errs.push(`type: "${data.type}" not in ${TYPES.join('|')}`);
  return errs;
}

module.exports = { parseFrontmatter, validatePage, DEPARTMENTS, BEHAVIORS, TYPES };
