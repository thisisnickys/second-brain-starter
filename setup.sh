#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Second Brain — first-run setup.
#
#   bash setup.sh
#
# It checks what you have, creates your .env, builds your first index, and
# tells you exactly what to do next. It never overwrites an existing .env and
# never touches anything outside this folder.
#
# No `set -e` on purpose: a failed check should report and continue, not kill
# the whole run and leave you guessing which step died.
# ─────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

GREEN="\033[0;32m"; RED="\033[0;31m"; YEL="\033[0;33m"; DIM="\033[2m"; OFF="\033[0m"
ok()   { printf "  ${GREEN}✓${OFF} %s\n" "$1"; }
warn() { printf "  ${YEL}!${OFF} %s\n" "$1"; }
bad()  { printf "  ${RED}✗${OFF} %s\n" "$1"; }
head_() { printf "\n${DIM}────────────────────────────────────────────────${OFF}\n%s\n\n" "$1"; }

BLOCKERS=0

head_ "1. Checking what you have installed"

if command -v node > /dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $(node -v)"
  else
    bad "node $(node -v) is too old — you need v18 or newer. Install from nodejs.org"
    BLOCKERS=$((BLOCKERS + 1))
  fi
else
  bad "node is not installed. Get it from https://nodejs.org (pick the LTS button)"
  BLOCKERS=$((BLOCKERS + 1))
fi

command -v git > /dev/null 2>&1 && ok "git" || warn "git missing — fine for now, needed for backups (xcode-select --install)"
command -v claude > /dev/null 2>&1 && ok "claude (Claude Code)" \
  || warn "claude CLI missing — the brain still stores and searches, but cannot DISTILL captures or answer questions. Install: npm install -g @anthropic-ai/claude-code"
command -v ffmpeg > /dev/null 2>&1 && ok "ffmpeg" || warn "ffmpeg missing (needed for voice notes): brew install ffmpeg"
command -v yt-dlp > /dev/null 2>&1 && ok "yt-dlp" || warn "yt-dlp missing (needed to capture videos): brew install yt-dlp"
command -v whisper > /dev/null 2>&1 && ok "whisper" || warn "whisper missing (only needed for videos with no captions): pip3 install -U openai-whisper"

head_ "2. Your .env (where your secrets live)"

if [ -f .env ]; then
  ok ".env already exists — leaving it alone"
else
  cp .env.example .env && chmod 600 .env
  ok "created .env from .env.example (locked to your user only)"
  warn "open .env and fill in TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID when you get to the Telegram step"
fi

# The fused-line / missing-newline check that has cost real debugging days.
node -e '
const fs=require("fs");
const {checkEnvText}=require("./system/lib/env-check.js");
const p=checkEnvText(fs.readFileSync(".env","utf8"),[]);
if(!p.length){console.log("  \033[0;32m✓\033[0m .env format is clean");process.exit(0);}
for(const x of p) console.log("  \033[0;33m!\033[0m .env: "+x);
' 2>/dev/null || warn "could not read .env yet"

head_ "3. Your identity (brain.config.json)"

OWNER=$(node -p "require('./brain.config.json').owner.name" 2>/dev/null)
DEPTS=$(node -p "require('./brain.config.json').departments.join(', ')" 2>/dev/null)
if [ "$OWNER" = "Sam" ]; then
  warn "owner is still the default \"Sam\" — open brain.config.json and put YOUR name and pronouns in"
else
  ok "owner: $OWNER"
fi
ok "departments: $DEPTS"
printf "    ${DIM}(rename these to the 4 areas of YOUR life — everything else follows)${OFF}\n"

head_ "4. Building your brain for the first time"

if [ "$BLOCKERS" -gt 0 ]; then
  bad "skipping the build — install node first, then run this script again"
  exit 1
fi

node system/lint-frontmatter.js && ok "every note passes the linter" || { bad "a note failed the linter (see above) — fix it and re-run"; exit 1; }
node system/build-index.js  > /dev/null && ok "search index built"
node system/build-graph.js  > /dev/null && ok "graph built"
node system/build-viz.js    > /dev/null && ok "galaxy data built"

head_ "5. Try it right now"

cat <<'NEXT'
  Open your galaxy:
      open viz/index.html

  Ask your brain a question:
      node system/brain.js "what did I decide about markdown"

  Check the health of the whole system any time:
      node system/doctor.js

  Then open SETUP.md and keep going from Step 5 (Telegram).
NEXT

printf "\n${GREEN}Setup finished.${OFF} Your notes live in wiki/. Everything else is rebuildable.\n\n"
