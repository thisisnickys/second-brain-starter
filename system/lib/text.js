'use strict';
const STOPWORDS = new Set(('a an and are as at be but by do does for from has have how i in is it its me my of on or our so that the this to was we what when where which who why will with you your').split(' '));

function tokenize(str) {
  const out = [];
  const seen = new Set();
  for (const raw of String(str).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw); out.push(raw);
  }
  return out;
}

// Filesystem-safe slug from a title: lowercase, hyphens, trimmed to 60 chars.
function slugify(str) {
  return String(str == null ? '' : str)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'untitled';
}

module.exports = { tokenize, STOPWORDS, slugify };
