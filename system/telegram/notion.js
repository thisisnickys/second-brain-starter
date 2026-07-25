'use strict';
// Notion writer for the Read/Watch List database. Zero npm deps — raw REST
// via https. The pure builders (markdown→blocks, chunking, page payload) are
// unit-tested; the network calls are thin and deliberately not.
const https = require('https');

const NOTION_VERSION = '2022-06-28';
const TEXT_LIMIT = 2000; // Notion rich_text content limit per item
const BLOCK_BATCH = 100; // max children per create/append request

/* ------------------------------- pure ---------------------------------- */

// Split a string into <=2000-char chunks (Notion's rich_text limit).
function textChunks(str, max = TEXT_LIMIT) {
  const s = String(str == null ? '' : str);
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out.length ? out : [''];
}

function richText(str) {
  return textChunks(str).map(c => ({ type: 'text', text: { content: c } }));
}

// Inline-markdown rich text: **bold** becomes a bold annotation instead of
// literal asterisks. Each segment still respects the 2000-char chunk limit.
function mdRichText(str) {
  const items = [];
  const parts = String(str == null ? '' : str).split(/\*\*([^*]+)\*\*/g); // odd indices were bold
  parts.forEach((part, i) => {
    if (!part) return;
    for (const chunk of textChunks(part)) {
      if (!chunk) continue;
      const item = { type: 'text', text: { content: chunk } };
      if (i % 2 === 1) item.annotations = { bold: true };
      items.push(item);
    }
  });
  return items.length ? items : [{ type: 'text', text: { content: '' } }];
}

function imageBlock(url) {
  return { object: 'block', type: 'image', image: { type: 'external', external: { url } } };
}

// Convert the distilled-notes markdown (headings, bullets, quotes, plain
// paragraphs) into Notion blocks. Intentionally simple — mirrors what the
// distiller is asked to produce, not a general markdown parser.
function mdToBlocks(md) {
  const blocks = [];
  for (const rawLine of String(md == null ? '' : md).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^###\s+(.*)$/))) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: mdRichText(m[1]) } });
    } else if ((m = line.match(/^##\s+(.*)$/))) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: mdRichText(m[1]) } });
    } else if ((m = line.match(/^#\s+(.*)$/))) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: mdRichText(m[1]) } });
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: mdRichText(m[1]) } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: mdRichText(m[1]) } });
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: mdRichText(line) } });
    }
  }
  return blocks;
}

// Full transcript → paragraph blocks, one per 2000-char slice.
function transcriptBlocks(text) {
  return textChunks(text).filter(c => c.trim()).map(c => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: c } }] }
  }));
}

function chunkArray(arr, size = BLOCK_BATCH) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Page payload for a Read/Watch List row. Property names/options match the
// live DB schema (Name/Type/Status/Link/Completed/Author/Score).
function buildPagePayload({ dbId, title, channel, url, thumbnail, dateStr, type, icon }) {
  const payload = {
    parent: { database_id: dbId },
    icon: { type: 'emoji', emoji: icon || '📺' },
    properties: {
      Name: { title: richText(title || 'Untitled video') },
      Type: { select: { name: type || 'Youtube' } },
      Status: { status: { name: 'Done' } },
      Score: { select: { name: 'TBD' } },
      Link: { url: url || null },
      Completed: { date: { start: dateStr } },
      Author: { rich_text: richText(channel || '') }
    }
  };
  if (thumbnail) payload.cover = { type: 'external', external: { url: thumbnail } };
  return payload;
}

/* ------------------------------ network -------------------------------- */

function notionApi(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request(
      {
        hostname: 'api.notion.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 30000
      },
      res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(out); } catch (err) { return reject(new Error('bad notion response')); }
          if (res.statusCode >= 400) {
            return reject(new Error(`notion ${res.statusCode}: ${parsed.message || out.slice(0, 200)}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('notion request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Does a row with this Link already exist? Returns the first match's
// { id, url } or null. Used for duplicate protection before creating.
async function findByLink(cfg, url) {
  const res = await notionApi(cfg.notionToken, 'POST', `/v1/databases/${cfg.readwatchDb}/query`, {
    filter: { property: 'Link', url: { equals: url } },
    page_size: 1
  });
  const hit = res.results && res.results[0];
  return hit ? { id: hit.id, url: hit.url } : null;
}

// Create the row (first <=100 blocks inline), append the rest in batches.
// Returns { id, url } of the created page.
async function createReadWatchPage(cfg, { title, channel, url, thumbnail, dateStr, blocks, type, icon }) {
  const payload = buildPagePayload({ dbId: cfg.readwatchDb, title, channel, url, thumbnail, dateStr, type, icon });
  const batches = chunkArray(blocks || []);
  if (batches.length) payload.children = batches[0];
  const page = await notionApi(cfg.notionToken, 'POST', '/v1/pages', payload);
  for (const batch of batches.slice(1)) {
    await notionApi(cfg.notionToken, 'PATCH', `/v1/blocks/${page.id}/children`, { children: batch });
  }
  return { id: page.id, url: page.url };
}

module.exports = {
  textChunks,
  mdRichText,
  imageBlock,
  mdToBlocks,
  transcriptBlocks,
  chunkArray,
  buildPagePayload,
  notionApi,
  findByLink,
  createReadWatchPage
};
