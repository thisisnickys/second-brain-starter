'use strict';
const fs = require('fs');
const path = require('path');
const { parseFrontmatter, validatePage } = require('./lib/frontmatter.js');

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const root = process.argv[2] || path.join(__dirname, '..', 'wiki');
let bad = 0;
for (const file of walk(root)) {
  const { data, errors } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const all = errors.concat(validatePage(data));
  if (all.length) { bad++; console.error(`FAIL ${file}\n  - ${all.join('\n  - ')}`); }
}
console.log(bad ? `lint: ${bad} file(s) failed` : 'lint: all wiki pages valid');
process.exit(bad ? 1 : 0);
