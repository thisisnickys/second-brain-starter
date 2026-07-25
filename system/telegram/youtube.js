'use strict';
const { DEPARTMENTS, OWNER, departmentMenu, ownerLine } = require('../lib/config.js');
// YouTube capture pipeline: link → metadata + transcript → distilled wiki
// note (+ raw transcript file) → Notion Read/Watch List row.
//
// Transcript strategy: YouTube auto-captions via yt-dlp first (seconds, no
// model), local Whisper on the downloaded audio as the fallback (minutes).
// The pure pieces (URL detection, VTT parsing, prompt/note builders, distill
// parsing) are unit-tested; the shell/network orchestration is thin.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { localDate } = require('../lib/date.js');
const { slugify } = require('../lib/text.js');
const { writeNote } = require('../lib/note-write.js');
const { mdToBlocks, transcriptBlocks, imageBlock, findByLink, createReadWatchPage } = require('./notion.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const TMP_DIR = path.join(os.tmpdir(), 'second-brain-youtube');
// Homebrew yt-dlp, NOT the stale pip 3.9 one in ~/Library/Python — YouTube's
// anti-bot checks reject old extractors ("The page needs to be reloaded").
const YTDLP_BIN = process.env.YTDLP_BIN || '/opt/homebrew/bin/yt-dlp';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';

const PROMPT_TRANSCRIPT_CAP = 80000; // chars of transcript handed to the distiller

/* ------------------------------- pure ---------------------------------- */

// Find the first YouTube video URL anywhere in a message. Returns
// { url, id } or null. Covers watch/shorts/live/youtu.be forms.
const YT_RE = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]*?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})[^\s]*/i;
function findYouTubeUrl(text) {
  const m = YT_RE.exec(String(text == null ? '' : text));
  if (!m) return null;
  return { url: m[0], id: m[1] };
}

// WEBVTT → plain text. Strips headers, timing lines, cue numbers, inline
// word-timing tags, and the consecutive duplicate lines that YouTube's
// rolling auto-captions produce.
function parseVtt(vtt) {
  const out = [];
  let prev = '';
  for (const rawLine of String(vtt == null ? '' : vtt).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^(Kind|Language|NOTE|STYLE)\b/i.test(line)) continue;
    if (line.includes('-->')) continue;
    if (/^\d+$/.test(line)) continue;
    line = line.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!line || line === prev) continue;
    prev = line;
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function buildDistillPrompt(meta, transcript) {
  const t = String(transcript == null ? '' : transcript);
  const capped = t.length > PROMPT_TRANSCRIPT_CAP
    ? t.slice(0, PROMPT_TRANSCRIPT_CAP) + '\n[transcript truncated]'
    : t;
  return [
    "You are distilling a YouTube video the owner just watched into a note for their second brain.",
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
    '  "notes_md": markdown notes — "## Core ideas" with 4-8 specific bullets (keep numbers, names, steps; no fluff), then "## Quotes" with 1-3 short verbatim quotes as > blockquotes,',
    '  "apply": 1-2 sentences: how the owner should apply this, concretely.',
    '}'
  ].join('\n');
}

// Parse the distiller's JSON (tolerating accidental code fences / prose
// around it). Throws when no usable object is found; falls back to a safe
// department when the model picks an invalid one.
function parseDistill(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('distill: no JSON in output');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!obj.title || !obj.notes_md) throw new Error('distill: missing title/notes_md');
  if (!DEPARTMENTS.includes(obj.department)) obj.department = 'content';
  if (!Array.isArray(obj.tags)) obj.tags = [];
  obj.tags = obj.tags.map(t => slugify(t)).filter(Boolean).slice(0, 6);
  obj.takeaway = String(obj.takeaway || '').trim();
  obj.apply = String(obj.apply || '').trim();
  return obj;
}

// The wiki note markdown — same shape as the hand-made learning notes.
function buildWikiNote({ meta, distill, dateStr, transcriptRelPath }) {
  const tags = distill.tags.length ? distill.tags.join(', ') : 'youtube';
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
    `YouTube, ${meta.channel}, "${meta.title}". Video: ${meta.url}. Full transcript: ${transcriptRelPath}`,
    '',
    distill.notes_md.trim(),
    '',
    '## Apply',
    distill.apply || distill.takeaway,
    ''
  ].join('\n');
}

function buildTranscriptDoc({ meta, dateStr, transcript }) {
  return [
    `# Transcript — ${meta.title}`,
    '',
    `Source: ${meta.url} (${meta.channel}). Captured ${dateStr} via telegram youtube capture.`,
    '',
    transcript,
    ''
  ].join('\n');
}

// Has this video already been captured into the wiki? Scans frontmatter
// `source:` lines for the 11-char video id, so both youtu.be and watch?v=
// forms of the same video match. Sync scan — the wiki is small.
function wikiHasVideoId(videoId, wikiDir) {
  const dir = wikiDir || path.join(ROOT_DIR, 'wiki');
  const id = String(videoId == null ? '' : videoId);
  if (!id) return false;
  let stack;
  try { stack = [dir]; fs.statSync(dir); } catch (err) { return false; }
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const head = fs.readFileSync(p, 'utf8').slice(0, 2000);
      const m = head.match(/^source:\s*(.*)$/m);
      if (m && m[1].includes(id)) return true;
    }
  }
  return false;
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

// yt-dlp metadata (no download). Returns { id, title, channel, url, thumbnail }.
async function fetchMeta(url) {
  const out = await execFileP(
    YTDLP_BIN,
    ['-J', '--no-warnings', '--no-playlist', '--skip-download', url],
    { timeout: 60000, maxBuffer: 64 << 20 }
  );
  const j = JSON.parse(out);
  const id = j.id;
  return {
    id,
    title: String(j.title || 'Untitled video').trim(),
    channel: String(j.channel || j.uploader || 'Unknown channel').trim(),
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    durationSec: Number(j.duration || 0)
  };
}

// Try YouTube captions (manual first, else auto). Returns plain text or null.
async function fetchCaptions(url, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  try {
    await execFileP(
      YTDLP_BIN,
      ['--skip-download', '--no-warnings', '--no-playlist',
        '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*',
        '--sub-format', 'vtt', '-o', path.join(workDir, 'cap.%(ext)s'), url],
      { timeout: 120000, maxBuffer: 8 << 20 }
    );
  } catch (err) {
    console.error('fetchCaptions failed (will fall back to whisper):', err.message);
  }
  const vtt = fs.readdirSync(workDir).find(f => f.endsWith('.vtt'));
  if (!vtt) return null;
  const text = parseVtt(fs.readFileSync(path.join(workDir, vtt), 'utf8'));
  return text || null;
}

// Whisper fallback: download bestaudio, downsample, transcribe locally.
async function transcribeAudio(url, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const m4a = path.join(workDir, 'audio.m4a');
  const wav = path.join(workDir, 'audio.wav');
  const txt = path.join(workDir, 'audio.txt');
  await execFileP(YTDLP_BIN,
    ['-f', 'bestaudio', '--no-warnings', '--no-playlist', '-o', m4a, url],
    { timeout: 300000, maxBuffer: 8 << 20 });
  await execFileP('ffmpeg', ['-y', '-i', m4a, '-ar', '16000', '-ac', '1', wav], { timeout: 300000 });
  await execFileP(WHISPER_BIN, [wav, '--model', WHISPER_MODEL, '--language', 'en',
    '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False'],
    { timeout: 1800000, maxBuffer: 32 << 20 });
  return fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
}

// Distill via a tool-less claude -p call (same pattern as the plan engine).
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

// The full pipeline. cfg needs { notionToken, readwatchDb }. `notify` is an
// optional async (text) => {} for mid-run progress messages. Returns a
// summary for the Telegram reply; short-circuits with { duplicate: true }
// when the video is already in the wiki or the Read/Watch List.
async function runYouTubeCapture(url, cfg, notify) {
  const tell = typeof notify === 'function' ? notify : async () => {};
  const dateStr = localDate();
  const meta = await fetchMeta(url);
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
  let transcriptSource = 'captions';
  try {
    transcript = await fetchCaptions(meta.url, workDir);
    if (!transcript) {
      transcriptSource = 'whisper';
      await tell('🎙 No captions on this one — transcribing the audio locally. This can take several minutes for a long video…');
      transcript = await transcribeAudio(meta.url, workDir);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (!transcript) throw new Error('no captions available and transcription failed');

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
    // Thumbnail first: the Read/Watch gallery previews page CONTENT, so the
    // body's first image is what shows on the card (the cover alone doesn't).
    const blocks = [
      imageBlock(meta.thumbnail),
      ...mdToBlocks(`${d.notes_md}\n## Apply\n${d.apply || d.takeaway}`),
      { object: 'block', type: 'divider', divider: {} },
      ...mdToBlocks('## Full transcript'),
      ...transcriptBlocks(transcript)
    ];
    try {
      notion = await createReadWatchPage(cfg, {
        title: meta.title, channel: meta.channel, url: meta.url,
        thumbnail: meta.thumbnail, dateStr, blocks
      });
    } catch (err) {
      notionError = err.message;
      console.error('notion write failed:', err.message);
    }
  }

  return {
    meta,
    distill: d,
    transcriptSource,
    wikiPath: path.relative(ROOT_DIR, noteAbs),
    transcriptPath: transcriptRel,
    notion,
    notionError
  };
}

module.exports = {
  findYouTubeUrl,
  parseVtt,
  wikiHasVideoId,
  buildDistillPrompt,
  parseDistill,
  buildWikiNote,
  buildTranscriptDoc,
  fetchMeta,
  fetchCaptions,
  transcribeAudio,
  distill,
  runYouTubeCapture
};
