'use strict';
// Merge reel spoken-word transcripts (apify/instagram-reel-scraper with
// includeTranscript) into existing raw/corpus/instagram/ reel files:
// appends a "## Spoken transcript" section and stamps transcript_source in
// the header. Idempotent — files already stamped are skipped.
//
// Usage: node system/ingest/instagram-reel-transcripts.js --file <dataset.json>
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'raw', 'corpus', 'instagram');

function shortCodeFromUrl(u) {
  const m = String(u || '').match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// shortcode -> corpus file path (from id: headers)
function corpusIndex() {
  const map = new Map();
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(OUT_DIR, f);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(200);
    const n = fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/^id: instagram-(\S+)$/m);
    if (m) map.set(m[1], p);
  }
  return map;
}

function mergeTranscript(filePath, transcript, source) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (/^transcript_source:/m.test(text)) return 'already';
  const t = String(transcript).trim();
  if (!t) return 'empty';
  const updated = text
    .replace(/^word_count:/m, `transcript_source: ${source || 'apify'}\nword_count:`)
    .trimEnd() + '\n\n## Spoken transcript\n\n' + t + '\n';
  fs.writeFileSync(filePath, updated);
  return 'merged';
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  if (fileArg === -1) { console.error('usage: --file <dataset.json>'); process.exit(1); }
  const items = JSON.parse(fs.readFileSync(args[fileArg + 1], 'utf8'));
  const index = corpusIndex();

  let merged = 0, already = 0, noMatch = 0, noTranscript = 0;
  for (const it of items) {
    if (it.error || !it.transcript) { noTranscript++; continue; }
    const code = shortCodeFromUrl(it.inputUrl) || shortCodeFromUrl(it.url) || it.shortCode;
    const file = code && index.get(code);
    if (!file) { noMatch++; continue; }
    const res = mergeTranscript(file, it.transcript);
    if (res === 'merged') merged++;
    else if (res === 'already') already++;
  }
  console.log(`reel-transcripts: ${merged} merged, ${already} already had one, ${noMatch} no corpus match, ${noTranscript} without transcript/errored`);
}

module.exports = { shortCodeFromUrl, mergeTranscript };

if (require.main === module) main();
