'use strict';
// Social video capture pipeline (Instagram reels/posts, TikTok): link →
// yt-dlp metadata + audio → local Whisper transcript → distilled wiki note
// (+ raw transcript file) → Notion Read/Watch List row. Mirrors youtube.js.
//
// Auth strategy: Instagram login-walls anonymous fetches, so every Instagram
// yt-dlp call rides the owner's Chrome cookies (--cookies-from-browser). TikTok
// usually works anonymously; cookies are only the retry. Neither platform
// has usable captions via yt-dlp, so transcription is always local Whisper —
// fine, because these videos are short.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { writeNote } = require('../lib/note-write.js');
const { parseDistill, wikiHasVideoId } = require('./youtube.js');
const { mdToBlocks, transcriptBlocks, imageBlock, findByLink, createReadWatchPage } = require('./notion.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const TMP_DIR = path.join(os.tmpdir(), 'second-brain-social');
const YTDLP_BIN = process.env.YTDLP_BIN || '/opt/homebrew/bin/yt-dlp';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';
const COOKIES_BROWSER = process.env.SOCIAL_COOKIES_BROWSER || 'chrome';

const { DEPARTMENTS, OWNER, departmentMenu, ownerLine } = require('../lib/config.js');
const PROMPT_TRANSCRIPT_CAP = 80000; // chars of transcript handed to the distiller

const PLATFORMS = {
  instagram: { label: 'Instagram', notionType: 'Reel', icon: '🎬', cookies: 'always' },
  tiktok: { label: 'TikTok', notionType: 'TikTok', icon: '🎵', cookies: 'retry' }
};

/* ------------------------------- pure ---------------------------------- */

// Instagram post/reel/tv links carry the shortcode; TikTok full links carry
// the numeric video id; TikTok share short-links (vm./vt./tiktok.com/t/)
// hide the id until yt-dlp resolves them, so they match with id: null.
const IG_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i;
const TT_RE = /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/\s]+\/video\/(\d+)/i;
const TT_SHORT_RE = /https?:\/\/(?:(?:vm|vt)\.tiktok\.com|(?:www\.)?tiktok\.com\/t)\/[A-Za-z0-9]+/i;

// First Instagram/TikTok video URL anywhere in a message. Returns
// { url, platform, id } or null. Profile pages don't match.
function findSocialUrl(text) {
  const s = String(text == null ? '' : text);
  let m = IG_RE.exec(s);
  if (m) return { url: m[0], platform: 'instagram', id: m[1] };
  m = TT_RE.exec(s);
  if (m) return { url: m[0], platform: 'tiktok', id: m[1] };
  m = TT_SHORT_RE.exec(s);
  if (m) return { url: m[0], platform: 'tiktok', id: null };
  return null;
}

// Stable clean URL for filing/dedup — no share-tracking params. TikTok uses
// the @user form when the uploader is known (it always is after a meta
// fetch); the user-less /video/ form is only a pre-meta identifier.
function canonicalSocialUrl({ platform, id, user }) {
  if (platform === 'instagram') return `https://www.instagram.com/reel/${id}/`;
  if (platform === 'tiktok') {
    return user
      ? `https://www.tiktok.com/@${user}/video/${id}`
      : `https://www.tiktok.com/video/${id}`;
  }
  return '';
}

// yt-dlp -J output → { id, title, channel, url, thumbnail, durationSec,
// platform }. Instagram titles are often the generic "Video by <handle>" —
// when the caption (description) exists, its first line is the real title.
function buildSocialMeta(j, platform) {
  const src = j || {};
  const id = String(src.id || '');
  let title = String(src.title || 'Untitled video').trim();
  const caption = String(src.description || '').trim();
  if (/^video by /i.test(title) && caption) {
    const first = caption.split('\n')[0].trim();
    if (first) title = first.length > 80 ? first.slice(0, 77) + '…' : first;
  }
  const user = platform === 'tiktok'
    ? String(src.uploader || src.uploader_id || '').replace(/^@/, '')
    : '';
  return {
    id,
    title,
    channel: String(src.uploader || src.channel || 'Unknown creator').trim(),
    url: canonicalSocialUrl({ platform, id, user: user || undefined }),
    thumbnail: src.thumbnail || null,
    durationSec: Number(src.duration || 0),
    platform
  };
}

function buildDistillPrompt(meta, transcript) {
  const label = (PLATFORMS[meta.platform] || {}).label || 'social media';
  const t = String(transcript == null ? '' : transcript);
  const capped = t.length > PROMPT_TRANSCRIPT_CAP
    ? t.slice(0, PROMPT_TRANSCRIPT_CAP) + '\n[transcript truncated]'
    : t;
  return [
    `You are distilling a short ${label} video the owner just watched into a note for her second brain.`,
    '',
    `Video: "${meta.title}" by ${meta.channel} (${meta.url})`,
    '',
    'Transcript:',
    '"""',
    capped,
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{',
    '  "title": short clean note title (video subject, not clickbait phrasing),',
    `  "department": one of ${DEPARTMENTS.join(' | ')} (${departmentMenu()}),`,
    '  "tags": 3-6 lowercase kebab-case topic tags,',
    '  "takeaway": ONE sentence — the single most useful idea, concrete,',
    '  "notes_md": markdown notes — "## Core ideas" with 2-6 specific bullets (keep numbers, names, steps; no fluff; short videos carry fewer ideas — do not pad), then "## Quotes" with 1-2 short verbatim quotes as > blockquotes,',
    '  "apply": 1-2 sentences: how the owner should apply this, concretely.',
    '}'
  ].join('\n');
}

// The wiki note markdown — same shape as the YouTube capture notes.
function buildWikiNote({ meta, distill, dateStr, transcriptRelPath }) {
  const label = (PLATFORMS[meta.platform] || {}).label || 'Social';
  const tags = distill.tags.length ? distill.tags.join(', ') : meta.platform || 'social';
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
    `${label}, ${meta.channel}, "${meta.title}". Video: ${meta.url}. Full transcript: ${transcriptRelPath}`,
    '',
    distill.notes_md.trim(),
    '',
    '## Apply',
    distill.apply || distill.takeaway,
    ''
  ].join('\n');
}

function buildTranscriptDoc({ meta, dateStr, transcript }) {
  const label = (PLATFORMS[meta.platform] || {}).label || 'Social';
  return [
    `# Transcript — ${meta.title}`,
    '',
    `Source: ${meta.url} (${label}, ${meta.channel}). Captured ${dateStr} via telegram social capture.`,
    '',
    transcript,
    ''
  ].join('\n');
}

/* ----------------------------- shell/network --------------------------- */

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 300) : ''}`));
      else resolve(stdout);
    });
  });
}

const COOKIE_ARGS = ['--cookies-from-browser', COOKIES_BROWSER];

// Run yt-dlp with the platform's auth strategy: Instagram always sends
// cookies; TikTok tries anonymously and retries WITH cookies on failure —
// so TikTok keeps working even if Chrome/keychain is unavailable.
async function ytdlp(args, platform, opts) {
  const mode = (PLATFORMS[platform] || {}).cookies;
  if (mode === 'always') return execFileP(YTDLP_BIN, [...COOKIE_ARGS, ...args], opts);
  try {
    return await execFileP(YTDLP_BIN, args, opts);
  } catch (err) {
    if (mode !== 'retry') throw err;
    console.error(`yt-dlp anonymous fetch failed (retrying with ${COOKIES_BROWSER} cookies):`, err.message);
    return execFileP(YTDLP_BIN, [...COOKIE_ARGS, ...args], opts);
  }
}

// yt-dlp metadata (no download) → normalized meta.
async function fetchMeta(url, platform) {
  const out = await ytdlp(
    ['-J', '--no-warnings', '--no-playlist', '--skip-download', url],
    platform,
    { timeout: 90000, maxBuffer: 64 << 20 }
  );
  return buildSocialMeta(JSON.parse(out), platform);
}

// Download the audio (audio-only when the platform offers it, else the
// smallest combined file — Instagram often serves only merged mp4s and
// ffmpeg extracts the audio track either way), downsample, transcribe
// locally with Whisper.
async function transcribeAudio(url, platform, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const m4a = path.join(workDir, 'audio.m4a');
  const wav = path.join(workDir, 'audio.wav');
  const txt = path.join(workDir, 'audio.txt');
  await ytdlp(['-f', 'bestaudio/worst[acodec!=none]/best', '--no-warnings', '--no-playlist', '-o', m4a, url],
    platform, { timeout: 300000, maxBuffer: 8 << 20 });
  await execFileP('ffmpeg', ['-y', '-i', m4a, '-ar', '16000', '-ac', '1', wav], { timeout: 300000 });
  await execFileP(WHISPER_BIN, [wav, '--model', WHISPER_MODEL, '--language', 'en',
    '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False'],
    { timeout: 1800000, maxBuffer: 32 << 20 });
  return fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
}

// Distill via a tool-less claude -p call (same pattern as youtube.js).
function distill(meta, transcript, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFile('claude',
      ['-p', buildDistillPrompt(meta, transcript), '--max-turns', '4', '--allowedTools', ''],
      { cwd: opts.cwd || ROOT_DIR, env, timeout: opts.timeout || 240000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(parseDistill(stdout)); } catch (e) { reject(e); }
      });
  });
}

// The full pipeline. `social` is findSocialUrl's { url, platform }; cfg needs
// { notionToken, readwatchDb }; `notify` is an optional async (text) => {}.
// Returns a summary for the Telegram reply; short-circuits with
// { duplicate: true } when the video is already filed.
async function runSocialCapture(social, cfg, notify) {
  const tell = typeof notify === 'function' ? notify : async () => {};
  const dateStr = localDate();
  const platform = social.platform;
  const p = PLATFORMS[platform] || { label: 'Social', notionType: 'Video', icon: '🎬' };
  const meta = await fetchMeta(social.url, platform);
  if (!meta.id) throw new Error('could not resolve the video id');
  const workDir = path.join(TMP_DIR, meta.id.replace(/[^A-Za-z0-9_-]/g, ''));

  // Duplicate protection: same video id in a wiki source line, or same
  // canonical URL already in the Read/Watch List → don't log it twice.
  if (wikiHasVideoId(meta.id)) return { duplicate: true, where: 'brain', meta };
  if (cfg && cfg.notionToken && cfg.readwatchDb) {
    try {
      const existing = await findByLink(cfg, meta.url);
      if (existing) return { duplicate: true, where: 'read/watch list', meta, notion: existing };
    } catch (err) {
      console.error('duplicate check (notion) failed, continuing:', err.message);
    }
  }

  let transcript = null;
  try {
    if (meta.durationSec > 180) {
      await tell('🎙 Transcribing the audio locally — longer video, this can take a few minutes…');
    }
    transcript = await transcribeAudio(social.url, platform, workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (!transcript) throw new Error('transcription came back empty');

  const d = await distill(meta, transcript);
  const slug = slugify(d.title);

  const transcriptRel = `raw/transcripts/${dateStr}-${slug}.md`;
  const transcriptAbs = path.join(ROOT_DIR, transcriptRel);
  fs.mkdirSync(path.dirname(transcriptAbs), { recursive: true });
  fs.writeFileSync(transcriptAbs, buildTranscriptDoc({ meta, dateStr, transcript }));

  const noteAbs = writeNote(
    path.join(ROOT_DIR, 'wiki', d.department, 'learning', `${dateStr}-${slug}.md`),
    buildWikiNote({ meta, distill: d, dateStr, transcriptRelPath: transcriptRel })
  );

  let notion = null;
  let notionError = null;
  if (cfg && cfg.notionToken && cfg.readwatchDb) {
    const blocks = [
      ...(meta.thumbnail ? [imageBlock(meta.thumbnail)] : []),
      ...mdToBlocks(`${d.notes_md}\n## Apply\n${d.apply || d.takeaway}`),
      { object: 'block', type: 'divider', divider: {} },
      ...mdToBlocks('## Full transcript'),
      ...transcriptBlocks(transcript)
    ];
    try {
      notion = await createReadWatchPage(cfg, {
        title: meta.title, channel: meta.channel, url: meta.url,
        thumbnail: meta.thumbnail, dateStr, blocks,
        type: p.notionType, icon: p.icon
      });
    } catch (err) {
      notionError = err.message;
      console.error('notion write failed:', err.message);
    }
  }

  return {
    meta,
    distill: d,
    transcriptSource: 'whisper',
    wikiPath: path.relative(ROOT_DIR, noteAbs),
    transcriptPath: transcriptRel,
    notion,
    notionError
  };
}

module.exports = {
  findSocialUrl,
  canonicalSocialUrl,
  buildSocialMeta,
  buildDistillPrompt,
  buildWikiNote,
  buildTranscriptDoc,
  fetchMeta,
  transcribeAudio,
  distill,
  runSocialCapture
};
