'use strict';
// Local Whisper fallback for reels Instagram has no transcript for.
// Ranks corpus reels by views, takes the top N still lacking
// transcript_source, downloads audio via yt-dlp (Chrome cookies — IG needs
// login), transcribes locally, merges as transcript_source: whisper.
// Resumable: stamped files are skipped on rerun.
//
// Usage: node system/ingest/instagram-reel-whisper.js [--top 1000] [--limit 5]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { mergeTranscript } = require('./instagram-reel-transcripts.js');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'raw', 'corpus', 'instagram');
const YTDLP_BIN = process.env.YTDLP_BIN || '/opt/homebrew/bin/yt-dlp';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`));
      else resolve(stdout);
    });
  });
}

function targets(topN) {
  const reels = [];
  for (const f of fs.readdirSync(CORPUS)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(CORPUS, f);
    const head = fs.readFileSync(p, 'utf8').slice(0, 400);
    if (!/^type: reel$/m.test(head)) continue;
    const views = Number((head.match(/^views: (\d+)$/m) || [])[1] || 0);
    const url = (head.match(/^url: (\S+)$/m) || [])[1];
    const done = /^transcript_source:/m.test(head);
    reels.push({ file: p, views, url, done });
  }
  reels.sort((a, b) => b.views - a.views);
  return reels.slice(0, topN).filter(r => !r.done && r.url);
}

async function transcribeReel(url, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const m4a = path.join(workDir, 'audio.m4a');
  const wav = path.join(workDir, 'audio.wav');
  const txt = path.join(workDir, 'audio.txt');
  await execFileP(YTDLP_BIN,
    ['-f', 'ba/b', '--no-warnings', '--cookies-from-browser', 'chrome', '-o', m4a, url],
    { timeout: 180000, maxBuffer: 8 << 20 });
  await execFileP('ffmpeg', ['-y', '-i', m4a, '-ar', '16000', '-ac', '1', wav], { timeout: 180000 });
  await execFileP(WHISPER_BIN, [wav, '--model', WHISPER_MODEL, '--language', 'en',
    '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False'],
    { timeout: 1200000, maxBuffer: 16 << 20 });
  return fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const topArg = args.indexOf('--top');
  const topN = topArg !== -1 ? Number(args[topArg + 1]) : 1000;
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;

  const todo = targets(topN).slice(0, limit);
  console.log(`reel-whisper: ${todo.length} reels to transcribe (top ${topN} by views, unstamped)`);

  let ok = 0, failed = 0, empty = 0;
  for (const [i, r] of todo.entries()) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-w-'));
    try {
      const t = await transcribeReel(r.url, workDir);
      if (!t) { empty++; console.log(`[${i + 1}/${todo.length}] ${r.url} EMPTY (no speech)`); }
      else {
        const res = mergeTranscript(r.file, t, 'whisper');
        if (res === 'merged') ok++;
        console.log(`[${i + 1}/${todo.length}] ${r.url} ${res} (${t.split(/\s+/).length} words)`);
      }
    } catch (e) {
      failed++;
      console.error(`[${i + 1}/${todo.length}] ${r.url} FAILED: ${e.message.slice(0, 160)}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    await new Promise(res => setTimeout(res, 3000)); // polite pacing for IG
  }
  console.log(`reel-whisper: done — ${ok} merged, ${empty} empty, ${failed} failed`);
}

module.exports = { targets };

if (require.main === module) main();
