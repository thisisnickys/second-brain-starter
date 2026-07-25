'use strict';
// Guards against the .env failure modes that have actually happened here:
// a value line fused with the next KEY=… (the silent TickTick-401 bug that
// cost a day), the missing trailing newline that causes fusion, duplicate
// keys, and missing required keys. Pure text-in/problems-out — callers
// (bot startup, system/doctor.js) read the file themselves.

// A fused line looks like `<value>NOTION_READWATCH_DB=…` — an uppercase run
// WITH an underscore followed by '='. Requiring the underscore keeps base64
// padding (`…ABCDEF=`) from false-positiving; every key in this .env has one.
const FUSED_RE = /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+=/;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function checkEnvText(text, requiredKeys = []) {
  const problems = [];
  const s = String(text == null ? '' : text);
  if (!s) {
    problems.push('.env is empty or unreadable');
    return problems;
  }
  if (!s.endsWith('\n')) {
    problems.push('no trailing newline — the next append will fuse with the last value');
  }
  const seen = new Map();
  s.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) {
      problems.push(`line ${i + 1}: no '=' — stray text`);
      return;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!KEY_RE.test(key)) problems.push(`line ${i + 1}: suspicious key "${key}"`);
    if (seen.has(key)) problems.push(`line ${i + 1}: duplicate key ${key} (also line ${seen.get(key)})`);
    seen.set(key, i + 1);
    const fused = value.match(FUSED_RE);
    if (fused) {
      problems.push(`line ${i + 1}: value of ${key} contains "${fused[0]}…" — fused lines (the TickTick-401 bug)`);
    }
  });
  for (const k of requiredKeys) {
    if (!seen.has(k)) problems.push(`missing required key ${k}`);
  }
  return problems;
}

module.exports = { checkEnvText };
