'use strict';
// Lint-gated wiki note writing. Every programmatic wiki write goes through
// here so nothing invalid ever lands in wiki/ (same guarantee the workbench
// save gives). Throws with the lint errors instead of writing.
const fs = require('fs');
const path = require('path');
const { parseFrontmatter, validatePage } = require('./frontmatter.js');

// Validate a full markdown document (frontmatter + body). Returns [] when
// valid, otherwise the list of lint errors.
function noteErrors(content) {
  const { data, errors } = parseFrontmatter(String(content == null ? '' : content));
  return errors.concat(validatePage(data));
}

// Write a validated note. Creates the directory, never overwrites: an
// existing filename gets a -2/-3/... suffix. Returns the absolute path.
function writeNote(absPath, content) {
  const errs = noteErrors(content);
  if (errs.length) throw new Error(`note failed lint: ${errs.join('; ')}`);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(absPath);
  const base = absPath.slice(0, -ext.length || undefined);
  let target = absPath;
  for (let i = 2; fs.existsSync(target); i++) target = `${base}-${i}${ext}`;
  fs.writeFileSync(target, content);
  return target;
}

module.exports = { noteErrors, writeNote };
