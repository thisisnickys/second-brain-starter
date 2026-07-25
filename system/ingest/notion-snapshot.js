'use strict';
const fs = require('fs');
const path = require('path');
const { localDate } = require('../lib/date.js');
const { parseFrontmatter } = require('../lib/frontmatter.js');
const ROOT = path.join(__dirname, '..', '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function rt(block) {
  const arr = (block && block.rich_text) || [];
  return arr.map(t => t.plain_text || '').join('');
}

function blocksToMarkdown(blocks) {
  const lines = [];
  let inTable = false;
  for (const b of blocks) {
    const t = b.type;
    if (t !== 'table_row' && inTable) inTable = false;
    if (t === 'heading_1') lines.push(`# ${rt(b[t])}`, '');
    else if (t === 'heading_2') lines.push(`## ${rt(b[t])}`, '');
    else if (t === 'heading_3') lines.push(`### ${rt(b[t])}`, '');
    else if (t === 'paragraph') lines.push(rt(b[t]), '');
    else if (t === 'bulleted_list_item') lines.push(`- ${rt(b[t])}`);
    else if (t === 'numbered_list_item') lines.push(`1. ${rt(b[t])}`);
    else if (t === 'to_do') lines.push(`- [${b[t].checked ? 'x' : ' '}] ${rt(b[t])}`);
    else if (t === 'quote') lines.push(`> ${rt(b[t])}`, '');
    else if (t === 'callout') lines.push(`> **Note:** ${rt(b[t])}`, '');
    else if (t === 'code') lines.push('```' + (b[t].language || ''), rt(b[t]), '```', '');
    else if (t === 'divider') lines.push('---', '');
    else if (t === 'table_row') {
      const cells = (b[t].cells || []).map(c => c.map(x => x.plain_text || '').join(''));
      lines.push(`| ${cells.join(' | ')} |`);
      if (!inTable) { lines.push(`| ${cells.map(() => '---').join(' | ')} |`); inTable = true; }
    }
    // unknown block types are skipped
    if (b.__children) lines.push(blocksToMarkdown(b.__children));
  }
  return lines.join('\n');
}

async function fetchAllBlocks(id, token, depth) {
  let blocks = [], cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${id}/children?page_size=100` +
      (cursor ? `&start_cursor=${cursor}` : '');
    const res = await fetch(url, { headers: {
      Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' } });
    if (!res.ok) throw new Error(`notion ${res.status} for ${id}: ${await res.text()}`);
    const json = await res.json();
    blocks = blocks.concat(json.results);
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  if (depth < 3) for (const b of blocks)
    if (b.has_children) b.__children = await fetchAllBlocks(b.id, token, depth + 1);
  return blocks;
}

async function main() {
  const token = loadEnv().NOTION_TOKEN || process.env.NOTION_TOKEN;
  if (!token) { console.error('FATAL: NOTION_TOKEN missing from .env'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'notion-pages.json'), 'utf8'));
  const today = localDate();
  let failed = 0;
  for (const page of cfg.pages) {
    try {
      const blocks = await fetchAllBlocks(page.id, token, 0);
      const body = blocksToMarkdown(blocks);
      const title = page.title || page.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const dir = path.join(ROOT, 'wiki', page.department, 'notion');
      const outPath = path.join(dir, `${page.slug}.md`);
      const newBody = `\n${body}\n`;

      let existingBody = null;
      if (fs.existsSync(outPath)) {
        existingBody = parseFrontmatter(fs.readFileSync(outPath, 'utf8')).body;
      }
      if (existingBody !== null && existingBody === newBody) {
        console.log(`ok ${page.slug} (unchanged)`);
        continue;
      }

      const out = `---\ntitle: ${title}\ndepartment: ${page.department}\ntags: [notion-snapshot]\nbehaviors: []\nsource: notion:${page.id}\nupdated: ${today}\n---\n\n${body}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, out);
      console.log(`ok ${page.slug}`);
    } catch (err) {
      failed++; console.error(`FAIL ${page.slug}: ${err.message}`);
    }
  }
  console.log(failed ? `notion-snapshot: ${failed} failed` : 'notion-snapshot: all pages ok');
  process.exit(failed ? 1 : 0);
}

module.exports = { blocksToMarkdown };
if (require.main === module) main();
