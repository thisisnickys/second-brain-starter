'use strict';
// Text → Telegram-ready voice note (OGG/Opus). Primary engine is ElevenLabs
// (the owner's Pro plan — API calls draw from the same monthly credit pool as the
// site, no separate billing). Fallback is the built-in macOS `say`, so the
// report still speaks (robotically) if the API errors or credits run out.
// Zero npm deps: https + ffmpeg (already required by the voice pipeline).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), 'second-brain-voice');

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ': ' + String(stderr).slice(0, 200) : ''}`));
      else resolve(stdout);
    });
  });
}

// POST the text to ElevenLabs, resolve with the mp3 buffer.
function elevenLabsMp3(text, apiKey, voiceId) {
  return new Promise((resolve, reject) => {
    // eleven_v3: most expressive model; supports inline audio tags like
    // [warm] [laughs]. Its stability only accepts 0.0 (Creative) / 0.5
    // (Natural) / 1.0 (Robust) — Creative, per the owner: v2 sounded "dead".
    const body = JSON.stringify({
      text: String(text || ''),
      model_id: 'eleven_v3',
      voice_settings: { stability: 0.0 }
    });
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 120000
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
            return;
          }
          resolve(buf);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('ElevenLabs request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Convert any audio file to Telegram voice-note format (OGG/Opus, mono 48k).
function toOgg(src, dest) {
  return execFileP('ffmpeg', ['-y', '-i', src, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', dest], { timeout: 60000 });
}

// speak(text, {apiKey, voiceId}) → { path, engine } for an .ogg voice note.
// Tries ElevenLabs first; on any failure falls back to macOS `say`.
// Caller is responsible for unlinking the returned file.
async function speak(text, opts) {
  const { apiKey, voiceId } = opts || {};
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const base = path.join(TMP_DIR, `tts-${process.pid}-${Date.now()}`);
  const ogg = `${base}.ogg`;

  if (apiKey && voiceId) {
    const mp3 = `${base}.mp3`;
    try {
      fs.writeFileSync(mp3, await elevenLabsMp3(text, apiKey, voiceId));
      await toOgg(mp3, ogg);
      return { path: ogg, engine: 'elevenlabs' };
    } catch (err) {
      console.error('ElevenLabs TTS failed, falling back to say:', err.message);
    } finally {
      try { fs.unlinkSync(mp3); } catch (e) { /* ignore */ }
    }
  }

  const aiff = `${base}.aiff`;
  try {
    await execFileP('say', ['-o', aiff, String(text || '')], { timeout: 120000 });
    await toOgg(aiff, ogg);
    return { path: ogg, engine: 'say' };
  } finally {
    try { fs.unlinkSync(aiff); } catch (e) { /* ignore */ }
  }
}

module.exports = { speak, elevenLabsMp3, toOgg };
