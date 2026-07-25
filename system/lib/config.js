'use strict';
// One place decides what YOUR brain is called and how it is divided.
// Everything else (linter, prompts, galaxy, reports) reads from here, so
// renaming a department is a one-line edit in brain.config.json — not a
// grep-and-pray across 20 files.
//
// Zero dependencies, and it never throws: a missing or broken config falls
// back to the defaults below so a typo can't take the whole brain down.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const DEFAULTS = {
  owner: {
    name: 'Sam',
    pronouns: { subject: 'they', object: 'them', possessive: 'their' },
    voice: 'direct, warm, no-BS, coach-like — talking TO the owner, never about them',
  },
  departments: ['business', 'content', 'projects', 'personal'],
  departmentHints: {},
  departmentColors: {},
  behaviors: ['move', 'breathe', 'create', 'learn', 'connect'],
  behaviorsLabel: 'Five Behaviors',
  customLens: { label: 'Life Map', mapFile: 'viz/world-map.json' },
};

const PALETTE = ['#F95000', '#B980FF', '#79C753', '#4DC9FF', '#F9A825', '#ff7ab8'];

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'brain.config.json'), 'utf8'));
  } catch {
    // no config, or invalid JSON — defaults it is.
  }
  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.owner = Object.assign({}, DEFAULTS.owner, raw.owner);
  cfg.owner.pronouns = Object.assign({}, DEFAULTS.owner.pronouns, (raw.owner || {}).pronouns);
  cfg.customLens = Object.assign({}, DEFAULTS.customLens, raw.customLens);

  if (!Array.isArray(cfg.departments) || !cfg.departments.length) cfg.departments = DEFAULTS.departments;
  if (!Array.isArray(cfg.behaviors) || !cfg.behaviors.length) cfg.behaviors = DEFAULTS.behaviors;

  // Any department without an explicit color still gets a stable one.
  const colors = Object.assign({}, cfg.departmentColors);
  cfg.departments.forEach((d, i) => { if (!colors[d]) colors[d] = PALETTE[i % PALETTE.length]; });
  colors._none = colors._none || '#8a8a8a';
  cfg.departmentColors = colors;

  return cfg;
}

const CONFIG = load();

// "business = ventures…, content = …" — the line every distill prompt pastes in
// so the model picks a department that exists instead of inventing one.
function departmentMenu() {
  return CONFIG.departments
    .map(d => (CONFIG.departmentHints[d] ? `${d} = ${CONFIG.departmentHints[d]}` : d))
    .join(', ');
}

// Owner-facing prompt preamble. Pronouns are config, not guessed from a name.
function ownerLine() {
  const p = CONFIG.owner.pronouns;
  return `The owner of this brain is ${CONFIG.owner.name} (${p.subject}/${p.object}). `
    + `Refer to ${CONFIG.owner.object || p.object} only with those pronouns.`;
}

module.exports = {
  CONFIG,
  ROOT,
  OWNER: CONFIG.owner,
  DEPARTMENTS: CONFIG.departments,
  BEHAVIORS: CONFIG.behaviors,
  departmentMenu,
  ownerLine,
};
