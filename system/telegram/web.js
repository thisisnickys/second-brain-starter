'use strict';
// Generic web capture pipeline: any non-YouTube link (tweet, Threads post,
// blog, article) → fetched content → distilled wiki note (+ raw text copy)
// → Notion Read/Watch List row. Mirrors youtube.js; YouTube links keep
// their own richer pipeline (transcripts, Whisper fallback).
//
// Content strategy: x.com/twitter.com statuses go through the fxtwitter
// mirror API (x.com itself serves an empty JS shell to plain fetches);
// everything else is a plain HTTPS fetch with og-tag + stripped-body
// extraction. The pure pieces are unit-tested; the network layer is thin.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { writeNote } = require('../lib/note-write.js');
const { parseDistill } = require('./youtube.js');
const { mdToBlocks, imageBlock, findByLink, createReadWatchPage } = require('./notion.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const { DEPARTMENTS, OWNER, departmentMenu, ownerLine } = require('../lib/config.js');
const PROMPT_CONTENT_CAP = 60000; // chars of page text handed to the distiller
const FETCH_CAP = 2 * 1024 * 1024; // stop reading a page after 2MB

/* ------------------------------- pure ---------------------------------- */

const URL_RE = /https?:\/\/\S+/gi;
const YT_HOST_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i;

// First non-YouTube URL anywhere in a message (YouTube routes to its own
// pipeline before this is consulted, but skip it here too so a caller can
// use findWebUrl standalone). Trailing sentence punctuation is stripped.
function findWebUrl(text) {
  const s = String(text == null ? '' : text);
  for (const m of s.matchAll(URL_RE)) {
    const raw = m[0].replace(/[)\]}>.,;:!?'"]+$/, '');
    let u;
    try { u = new URL(raw); } catch (err) { continue; }
    if (YT_HOST_RE.test(u.hostname)) continue;
    return { url: raw };
  }
  return null;
}

// { user, id } for an x.com / twitter.com status link, else null.
function parseTweetUrl(url) {
  const m = String(url == null ? '' : url)
    .match(/^https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)/i);
  return m ? { user: m[1], id: m[2] } : null;
}

// { user, kind } for a LinkedIn post/article link, else null. Text posts
// fetch fine anonymously (full text is in the page for SEO); this only
// drives the Read/Watch List Type/icon. Profiles/company pages don't match.
function parseLinkedInUrl(url) {
  const m = String(url == null ? '' : url)
    .match(/^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(posts|pulse)\/([^/?#\s]+)/i);
  if (!m) return null;
  if (m[1].toLowerCase() === 'pulse') return { user: null, kind: 'pulse' };
  return { user: m[2].split('_')[0], kind: 'post' };
}

// Strip share-tracking query params so duplicate checks match the same page
// pasted from different share sheets. Tweet URLs drop the query entirely
// (s=/t= are pure tracking); elsewhere only known trackers are removed.
const TRACKER_RE = /^(utm_\w+|fbclid|gclid|igshid|ref_src|ref_url)$/i;
function canonicalUrl(url) {
  let u;
  try { u = new URL(String(url == null ? '' : url)); } catch (err) { return String(url == null ? '' : url); }
  u.hash = '';
  if (parseTweetUrl(u.href)) {
    u.search = '';
  } else {
    const keep = [];
    for (const [k, v] of u.searchParams) if (!TRACKER_RE.test(k)) keep.push([k, v]);
    u.search = keep.length ? '?' + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  }
  return u.href.replace(/\/$/, u.pathname === '/' ? '/' : '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”' };
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#?\w+);/g, (m, name) => {
    if (ENTITIES[name] !== undefined) return ENTITIES[name];
    if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    return m;
  });
}

function ogTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return '';
  const m = tag[0].match(/content=["']([^"']*)["']/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// { title, siteName, description, image, text } from raw page HTML.
// og tags first, <title> fallback; body text with script/style/nav/header/
// footer/aside removed and tags flattened to spaces.
function extractHtml(html) {
  const h = String(html == null ? '' : html);
  const titleTag = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = ogTag(h, 'og:title') || decodeEntities(titleTag).replace(/\s+/g, ' ').trim();
  const text = decodeEntities(
    h
      .replace(/<(script|style|noscript|nav|header|footer|aside|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
  return {
    title,
    siteName: ogTag(h, 'og:site_name'),
    description: ogTag(h, 'og:description') || ogTag(h, 'description'),
    image: ogTag(h, 'og:image') || null,
    text
  };
}

// One tweet's text, with its quoted tweet folded in when present.
function tweetText(t) {
  let text = String((t || {}).text || '').trim();
  const q = (t || {}).quote;
  if (q && q.text) {
    const qa = (q.author && q.author.screen_name) || 'unknown';
    text += `\n\nQuoting @${qa}: ${String(q.text).trim()}`;
  }
  return text;
}

// fxtwitter tweet JSON → the same content shape extractHtml produces.
function tweetToContent(tweet) {
  return buildThreadContent([tweet || {}]);
}

// An author's self-thread (root first) → capture content. A single tweet is
// left unnumbered; a thread becomes "Post 1: … Post 2: …" with the title
// taken from the ROOT tweet (that's what the thread is about).
function buildThreadContent(chain) {
  const tweets = (Array.isArray(chain) ? chain : []).filter(Boolean);
  const root = tweets[0] || {};
  const author = root.author || {};
  const firstLine = String(root.text || '').split('\n')[0].trim();
  let image = null;
  for (const t of tweets) {
    const photo = t.media && Array.isArray(t.media.photos) && t.media.photos[0] && t.media.photos[0].url;
    if (photo) { image = photo; break; }
  }
  const text = tweets.length > 1
    ? tweets.map((t, i) => `Post ${i + 1}: ${tweetText(t)}`).join('\n\n')
    : tweetText(root);
  return {
    title: firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine || 'Tweet',
    siteName: `X (@${author.screen_name || 'unknown'})` + (tweets.length > 1 ? `, thread of ${tweets.length} posts` : ''),
    description: '',
    image,
    text
  };
}

// Non-social links inside captured text (tweets carry their expanded URLs in
// the text) — these are the "article connected to it" cases worth pulling in.
const SOCIAL_HOST_RE = /^(?:www\.|mobile\.|m\.|vm\.|vt\.)?(?:x\.com|twitter\.com|t\.co|threads\.net|threads\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|pic\.x\.com)$/i;
function extractLinks(text) {
  const out = [];
  for (const m of String(text == null ? '' : text).matchAll(URL_RE)) {
    const raw = m[0].replace(/[)\]}>.,;:!?'"]+$/, '');
    let u;
    try { u = new URL(raw); } catch (err) { continue; }
    if (SOCIAL_HOST_RE.test(u.hostname)) continue;
    if (out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= 2) break;
  }
  return out;
}

function buildDistillPrompt(meta, content) {
  const c = String(content == null ? '' : content);
  const capped = c.length > PROMPT_CONTENT_CAP ? c.slice(0, PROMPT_CONTENT_CAP) + '\n[content truncated]' : c;
  return [
    "You are distilling something the owner just read online (a tweet, thread, post, or article) into a note for their second brain.",
    'The content may include a multi-post thread ("Post 1: …") and the full text of linked articles ("--- Linked article … ---") — cover the WHOLE scope, not just the first post.',
    '',
    `Source: "${meta.title}" — ${meta.siteName || 'the web'} (${meta.url})`,
    '',
    'Content:',
    '"""',
    capped,
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{',
    '  "title": short clean note title (the subject, not clickbait phrasing),',
    `  "department": one of ${DEPARTMENTS.join(' | ')} (${departmentMenu()}),`,
    '  "tags": 3-6 lowercase kebab-case topic tags,',
    '  "takeaway": ONE sentence — the single most useful idea, concrete,',
    '  "notes_md": markdown notes — "## Core ideas" with 2-8 specific bullets (keep numbers, names, steps; no fluff; for a short tweet 2-3 bullets is fine), then "## Quotes" with 1-2 short verbatim quotes as > blockquotes,',
    '  "apply": 1-2 sentences: how the owner should apply this, concretely.',
    '}'
  ].join('\n');
}

// The wiki note markdown — same shape as the YouTube capture notes.
function buildWikiNote({ meta, distill, dateStr, rawRelPath }) {
  const tags = distill.tags.length ? distill.tags.join(', ') : 'capture';
  return [
    '---',
    `title: ${distill.title}`,
    `department: ${distill.department}`,
    `tags: [${tags}]`,
    'behaviors: [learn]',
    `source: capture:${meta.url}`,
    `updated: ${dateStr}`,
    '---',
    '',
    `# ${distill.title}`,
    '',
    '## Source',
    `${meta.siteName || 'Web'}, "${meta.title}". Link: ${meta.url}${rawRelPath ? `. Saved copy: ${rawRelPath}` : ''}`,
    '',
    distill.notes_md.trim(),
    '',
    '## Apply',
    distill.apply || distill.takeaway,
    ''
  ].join('\n');
}

function buildRawDoc({ meta, dateStr, text }) {
  return [
    `# Saved copy — ${meta.title}`,
    '',
    `Source: ${meta.url} (${meta.siteName || 'web'}). Captured ${dateStr} via telegram web capture.`,
    '',
    text,
    ''
  ].join('\n');
}

// Has this link already been captured? Scans wiki frontmatter source: lines
// for the canonical URL (so share-tracking variants of the same link match).
function wikiHasUrl(url, wikiDir) {
  const dir = wikiDir || path.join(ROOT_DIR, 'wiki');
  const target = canonicalUrl(url);
  if (!target) return false;
  let stack;
  try { stack = [dir]; fs.statSync(dir); } catch (err) { return false; }
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const head = fs.readFileSync(p, 'utf8').slice(0, 2000);
      const m = head.match(/^source:\s*capture:(\S+)/m);
      if (m && canonicalUrl(m[1]) === target) return true;
    }
  }
  return false;
}

/* ----------------------------- network --------------------------------- */

async function fetchWithCap(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ 'user-agent': 'Mozilla/5.0 (Macintosh) second-brain-capture/1.0' }, headers || {}),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < FETCH_CAP) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

// One tweet's JSON via the fxtwitter mirror (no auth). The /i/ path works
// without knowing the author's handle.
async function fetchTweetJson(id) {
  const body = await fetchWithCap(`https://api.fxtwitter.com/i/status/${id}`, { accept: 'application/json' });
  const j = JSON.parse(body);
  if (!j || j.code !== 200 || !j.tweet) throw new Error(`fxtwitter: ${j && j.message ? j.message : 'no tweet in response'}`);
  return j.tweet;
}

const THREAD_WALK_CAP = 12;

// The shared tweet plus every parent by the SAME author (a self-thread),
// root first. fxtwitter only exposes parent pointers, so this recovers the
// thread from the shared tweet upward; posts below the shared one aren't
// reachable without auth. A broken hop fails soft to what was collected.
async function fetchTweetChain(id) {
  const chain = [await fetchTweetJson(id)];
  while (chain.length < THREAD_WALK_CAP) {
    const cur = chain[0];
    const author = (cur.author && cur.author.screen_name) || '';
    if (!cur.replying_to_status || !cur.replying_to) break;
    if (cur.replying_to.toLowerCase() !== author.toLowerCase()) break;
    let parent;
    try { parent = await fetchTweetJson(cur.replying_to_status); } catch (err) {
      console.error('thread walk stopped:', err.message);
      break;
    }
    chain.unshift(parent);
  }
  return chain;
}

// Tweet content via fxtwitter, whole self-thread included.
async function fetchTweet(user, id) {
  return buildThreadContent(await fetchTweetChain(id));
}

async function fetchArticle(url) {
  const c = extractHtml(await fetchWithCap(url));
  // JS-shell pages (Threads and friends) often carry the post text only in
  // og:description — fall back to it rather than failing on a thin body.
  if (c.text.length < 200 && c.description) {
    c.text = c.text.length ? `${c.description}\n\n${c.text}` : c.description;
  }
  return c;
}

// Distill via a tool-less claude -p call (same pattern as youtube.js).
function distill(meta, content, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildDistillPrompt(meta, content), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 240000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(parseDistill(stdout)); } catch (e) { reject(e); }
      });
  });
}

// The full pipeline. cfg needs { notionToken, readwatchDb }. Returns a
// summary for the Telegram reply; short-circuits with { duplicate: true }
// when the link is already in the wiki or the Read/Watch List.
async function runWebCapture(url, cfg) {
  const dateStr = localDate();
  const canonical = canonicalUrl(url);
  const tweet = parseTweetUrl(canonical);

  if (wikiHasUrl(canonical)) return { duplicate: true, where: 'brain', url: canonical };
  if (cfg && cfg.notionToken && cfg.readwatchDb) {
    try {
      const existing = await findByLink(cfg, canonical);
      if (existing) return { duplicate: true, where: 'read/watch list', url: canonical, notion: existing };
    } catch (err) {
      console.error('duplicate check (notion) failed, continuing:', err.message);
    }
  }

  let content;
  let fileUrl = canonical;
  if (tweet) {
    const chain = await fetchTweetChain(tweet.id);
    content = buildThreadContent(chain);
    // A mid-thread share files under the thread ROOT — that's "the thread" —
    // so sharing another post of the same thread later still dedupes.
    const rootUrl = chain[0] && chain[0].url ? canonicalUrl(chain[0].url) : canonical;
    if (rootUrl !== canonical) {
      fileUrl = rootUrl;
      if (wikiHasUrl(rootUrl)) return { duplicate: true, where: 'brain', url: rootUrl };
      if (cfg && cfg.notionToken && cfg.readwatchDb) {
        try {
          const existing = await findByLink(cfg, rootUrl);
          if (existing) return { duplicate: true, where: 'read/watch list', url: rootUrl, notion: existing };
        } catch (err) {
          console.error('duplicate check (notion) failed, continuing:', err.message);
        }
      }
    }
    // "Full scope": a tweet that links out to an article usually IS about
    // that article — pull the linked pages in before distilling.
    for (const link of extractLinks(content.text)) {
      try {
        const art = await fetchArticle(link);
        if (art.text && art.text.length >= 200) {
          content.text += `\n\n--- Linked article: ${art.title || link} (${link}) ---\n${art.text.slice(0, 30000)}`;
          if (!content.image && art.image) content.image = art.image;
        }
      } catch (err) {
        console.error('linked article fetch failed (skipping):', err.message);
      }
    }
  } else {
    content = await fetchArticle(canonical);
  }
  if (!content.text || content.text.length < 20) throw new Error('could not extract any readable content from that page');

  const meta = { title: content.title || fileUrl, siteName: content.siteName, url: fileUrl };
  const d = await distill(meta, content.text);
  const slug = slugify(d.title);

  // Raw saved copy only when there's real long-form body text; a short
  // tweet's full text already fits in the note.
  let rawRel = null;
  if (content.text.length > 1500) {
    rawRel = `raw/articles/${dateStr}-${slug}.md`;
    const rawAbs = path.join(ROOT_DIR, rawRel);
    fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
    fs.writeFileSync(rawAbs, buildRawDoc({ meta, dateStr, text: content.text }));
  }

  const noteAbs = writeNote(
    path.join(ROOT_DIR, 'wiki', d.department, 'learning', `${dateStr}-${slug}.md`),
    buildWikiNote({ meta, distill: d, dateStr, rawRelPath: rawRel })
  );

  let notion = null;
  let notionError = null;
  if (cfg && cfg.notionToken && cfg.readwatchDb) {
    const blocks = [
      ...(content.image ? [imageBlock(content.image)] : []),
      ...mdToBlocks(`${d.notes_md}\n## Apply\n${d.apply || d.takeaway}`)
    ];
    try {
      const li = parseLinkedInUrl(fileUrl);
      notion = await createReadWatchPage(cfg, {
        title: meta.title, channel: meta.siteName || new URL(fileUrl).hostname, url: fileUrl,
        thumbnail: content.image, dateStr, blocks,
        type: tweet ? 'Tweet' : li ? 'LinkedIn' : 'Article', icon: tweet ? '🐦' : li ? '💼' : '📄'
      });
    } catch (err) {
      notionError = err.message;
      console.error('notion write failed:', err.message);
    }
  }

  return {
    meta,
    distill: d,
    kind: tweet ? 'tweet' : 'article',
    wikiPath: path.relative(ROOT_DIR, noteAbs),
    rawPath: rawRel,
    notion,
    notionError
  };
}

module.exports = {
  findWebUrl,
  parseTweetUrl,
  parseLinkedInUrl,
  canonicalUrl,
  extractHtml,
  tweetToContent,
  buildThreadContent,
  extractLinks,
  fetchTweetChain,
  buildDistillPrompt,
  buildWikiNote,
  buildRawDoc,
  wikiHasUrl,
  fetchTweet,
  fetchArticle,
  distill,
  runWebCapture
};
