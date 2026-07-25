'use strict';
// Bulk YouTube transcript backfill → raw/corpus/youtube/ (Phase 2).
// Works through the channel inventory in raw/corpus/manifests/
// (youtube-long.txt + youtube-live.txt; shorts are Phase 5) and captures a
// transcript per video, reusing the Telegram capture machinery: YouTube
// captions via yt-dlp first (seconds), local Whisper as the fallback
// (minutes — deferred to a separate pass so the captions sweep stays fast).
// Resumable: videos whose id already exists in the corpus are skipped.
//
// Usage:
//   node system/ingest/youtube-transcripts.js               # captions pass
//   node system/ingest/youtube-transcripts.js --whisper     # work the no-captions queue
//   node system/ingest/youtube-transcripts.js --limit 5     # test run
//   node system/ingest/youtube-transcripts.js --cookies     # use Chrome cookies —
//     needed for members-only videos (and pairs with --ignore-no-formats-error
//     so the old yt-dlp's JS-challenge failures don't kill caption fetches)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { parseVtt } = require('../telegram/youtube.js');

let YTDLP_EXTRA = []; // set by --cookies in main()
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'youtube');
const MANIFESTS = path.join(ROOT, 'raw', 'corpus', 'manifests');
const QUEUE = path.join(ROOT, 'system', 'logs', 'yt-whisper-queue.txt');
const YTDLP_BIN = process.env.YTDLP_BIN || '/opt/homebrew/bin/yt-dlp';

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 300) : ''}`));
      else resolve(stdout);
    });
  });
}

function slugify(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'untitled';
}

// yt-dlp upload_date is YYYYMMDD (already the video's own date, no TZ math).
function uploadDateToIso(d) {
  const m = String(d || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function loadManifest(name, type) {
  const p = path.join(MANIFESTS, name);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(line => {
    const sep = line.indexOf('|');
    return { id: line.slice(0, sep).trim(), title: line.slice(sep + 1).trim(), type };
  }).filter(v => v.id);
}

function existingIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/-youtube-([A-Za-z0-9_-]{11})-/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function renderFile(v, meta, transcript, source) {
  const date = uploadDateToIso(meta.upload_date);
  const title = String(meta.title || v.title || 'Untitled').replace(/\s+/g, ' ').trim();
  return {
    name: `${date || 'undated'}-youtube-${v.id}-${slugify(title)}.md`,
    text: [
      '---',
      `id: youtube-${v.id}`,
      'platform: youtube',
      `type: ${v.type}`,
      `title: ${title}`,
      `date: ${date}`,
      `url: https://www.youtube.com/watch?v=${v.id}`,
      `duration_sec: ${Math.round(Number(meta.duration || 0))}`,
      `view_count: ${Number(meta.view_count || 0)}`,
      `transcript_source: ${source}`,
      `word_count: ${transcript.split(/\s+/).filter(Boolean).length}`,
      '---',
      '',
      transcript,
      '',
    ].join('\n'),
  };
}

async function fetchMetaFull(url) {
  const out = await execFileP(YTDLP_BIN,
    ['-J', '--no-warnings', '--no-playlist', '--skip-download', ...YTDLP_EXTRA, url],
    { timeout: 60000, maxBuffer: 64 << 20 });
  const j = JSON.parse(out);
  return { title: j.title, upload_date: j.upload_date, duration: j.duration, view_count: j.view_count };
}

// Same strategy as telegram/youtube.js fetchCaptions, but honours YTDLP_EXTRA
// (cookies / no-formats tolerance) which the bot's helper doesn't take.
async function fetchCaptions(url, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  try {
    await execFileP(YTDLP_BIN,
      ['--skip-download', '--no-warnings', '--no-playlist',
        '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*',
        '--sub-format', 'vtt', ...YTDLP_EXTRA,
        '-o', path.join(workDir, 'cap.%(ext)s'), url],
      { timeout: 120000, maxBuffer: 8 << 20 });
  } catch (err) {
    console.error('fetchCaptions failed (queueing for whisper):', err.message.slice(0, 200));
  }
  const vtt = fs.readdirSync(workDir).find(f => f.endsWith('.vtt'));
  if (!vtt) return null;
  const text = parseVtt(fs.readFileSync(path.join(workDir, vtt), 'utf8'));
  return text || null;
}

// Bulk-sized whisper fallback. The telegram helper's timeouts (5 min audio
// download, 30 min whisper) are tuned for short captures and silently kill
// multi-hour lives — this version allows 30 min per download/convert and 8 h
// of transcription, and honours YTDLP_EXTRA (cookies etc.).
async function transcribeAudioBulk(url, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const m4a = path.join(workDir, 'audio.m4a');
  const wav = path.join(workDir, 'audio.wav');
  const txt = path.join(workDir, 'audio.txt');
  await execFileP(YTDLP_BIN,
    ['-f', 'bestaudio', '--no-warnings', '--no-playlist', ...YTDLP_EXTRA, '-o', m4a, url],
    { timeout: 1800000, maxBuffer: 8 << 20 });
  await execFileP('ffmpeg', ['-y', '-i', m4a, '-ar', '16000', '-ac', '1', wav], { timeout: 1800000 });
  await execFileP(WHISPER_BIN, [wav, '--model', WHISPER_MODEL, '--language', 'en',
    '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False'],
    { timeout: 28800000, maxBuffer: 64 << 20 });
  return fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
}

function readQueue() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs.readFileSync(QUEUE, 'utf8').split('\n').filter(l => l.trim()).map(l => {
    const [id, type, ...rest] = l.split('|');
    return { id, type, title: rest.join('|') };
  });
}

function writeQueue(items) {
  fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
  fs.writeFileSync(QUEUE, items.map(v => `${v.id}|${v.type}|${v.title}`).join('\n') + (items.length ? '\n' : ''));
}

async function processVideo(v, useWhisper) {
  const url = `https://www.youtube.com/watch?v=${v.id}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `yt-${v.id}-`));
  try {
    const meta = await fetchMetaFull(url);
    let transcript = null;
    let source = 'captions';
    if (!useWhisper) transcript = await fetchCaptions(url, workDir);
    if (!transcript && useWhisper) {
      transcript = await transcribeAudioBulk(url, workDir);
      source = 'whisper';
    }
    if (!transcript) return { status: 'no-captions' };
    const { name, text } = renderFile(v, meta, transcript, source);
    fs.writeFileSync(path.join(OUT_DIR, name), text);
    return { status: 'ok', source };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const whisperMode = args.includes('--whisper');
  if (args.includes('--cookies')) {
    YTDLP_EXTRA = ['--cookies-from-browser', 'chrome', '--ignore-no-formats-error'];
  }
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingIds(OUT_DIR);

  let todo;
  if (whisperMode) {
    todo = readQueue().filter(v => !seen.has(v.id));
  } else {
    todo = loadManifest('youtube-long.txt', 'long')
      .concat(loadManifest('youtube-live.txt', 'live'))
      .concat(loadManifest('youtube-short.txt', 'short'))
      .filter(v => !seen.has(v.id));
  }
  todo = todo.slice(0, limit);
  console.log(`youtube-transcripts: ${whisperMode ? 'whisper' : 'captions'} pass — ${seen.size} in corpus, ${todo.length} to process`);

  let ok = 0, noCaptions = 0, failed = 0;
  const stillQueued = [];
  for (const [i, v] of todo.entries()) {
    try {
      const res = await processVideo(v, whisperMode);
      if (res.status === 'ok') { ok++; }
      else { noCaptions++; stillQueued.push(v); }
      console.log(`[${i + 1}/${todo.length}] ${v.id} ${res.status === 'ok' ? res.source : 'NO CAPTIONS → queued'} — ${v.title.slice(0, 70)}`);
    } catch (e) {
      failed++;
      stillQueued.push(v);
      console.error(`[${i + 1}/${todo.length}] ${v.id} FAILED: ${e.message.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 2000)); // polite pacing for YouTube
  }

  if (!whisperMode) {
    // Queue = previous queue + this run's misses, minus anything now captured.
    const captured = existingIds(OUT_DIR);
    const merged = new Map();
    for (const v of readQueue().concat(stillQueued)) {
      if (!captured.has(v.id)) merged.set(v.id, v);
    }
    writeQueue(Array.from(merged.values()));
    console.log(`youtube-transcripts: done — ${ok} captured, ${noCaptions} queued for whisper, ${failed} failed (whisper queue: ${merged.size})`);
  } else {
    writeQueue(stillQueued);
    console.log(`youtube-transcripts: whisper pass done — ${ok} captured, ${failed} failed, ${stillQueued.length} left in queue`);
  }
  if (failed && failed === todo.length && todo.length > 0) process.exitCode = 1; // total failure only
}

module.exports = { uploadDateToIso, slugify, renderFile, loadManifest, readQueue, writeQueue };

if (require.main === module) {
  main().catch(e => { console.error(`youtube-transcripts: fatal — ${e.message}`); process.exit(1); });
}
