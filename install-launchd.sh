#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the scheduled jobs (Phase 8 of SETUP.md).
#
#   bash install-launchd.sh            # install everything
#   bash install-launchd.sh bot        # install just one
#   bash install-launchd.sh --uninstall
#
# It fills YOUR real paths into the .plist templates, copies them into
# ~/Library/LaunchAgents, and loads them. Safe to re-run: it reloads rather
# than duplicating.
#
# No `set -e`: one job failing to load should not stop the rest from installing.
# ─────────────────────────────────────────────────────────────────────────────

BRAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
UID_NUM="$(id -u)"

GREEN="\033[0;32m"; RED="\033[0;31m"; YEL="\033[0;33m"; DIM="\033[2m"; OFF="\033[0m"
ok()   { printf "  ${GREEN}✓${OFF} %s\n" "$1"; }
bad()  { printf "  ${RED}✗${OFF} %s\n" "$1"; }
info() { printf "  ${DIM}%s${OFF}\n" "$1"; }

mkdir -p "$AGENTS" "$LOGS"

# label-suffix : path to template
TEMPLATES=(
  "bot:$BRAIN_DIR/system/telegram/com.secondbrain.second-brain-bot.plist.template"
  "morning:$BRAIN_DIR/system/telegram/com.secondbrain.second-brain-morning.plist.template"
  "evening:$BRAIN_DIR/system/telegram/com.secondbrain.second-brain-evening.plist.template"
  "weekly:$BRAIN_DIR/system/telegram/com.secondbrain.second-brain-weekly.plist.template"
  "ingest:$BRAIN_DIR/system/ingest/com.secondbrain.second-brain-ingest.plist.template"
  "nightshift:$BRAIN_DIR/system/nightshift/com.secondbrain.second-brain-nightshift.plist.template"
)

WANT="$1"

if [ "$WANT" = "--uninstall" ]; then
  echo "Removing scheduled jobs…"
  for entry in "${TEMPLATES[@]}"; do
    name="${entry%%:*}"
    label="com.secondbrain.second-brain-$name"
    launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null
    rm -f "$AGENTS/$label.plist" && ok "removed $label"
  done
  echo
  echo "Done. Your notes and code are untouched — only the schedules were removed."
  exit 0
fi

# node must be resolvable by an absolute path: launchd jobs do NOT inherit your
# shell's PATH. This is the classic "works in my terminal, dead at 3am" bug.
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  bad "node not found. Install it first (see SETUP.md Phase 1.2)."
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
info "node: $NODE_BIN"
info "brain: $BRAIN_DIR"
echo

INSTALLED=0
for entry in "${TEMPLATES[@]}"; do
  name="${entry%%:*}"
  tpl="${entry#*:}"
  [ -n "$WANT" ] && [ "$WANT" != "$name" ] && continue

  if [ ! -f "$tpl" ]; then
    bad "$name — template missing at $tpl"
    continue
  fi

  label="com.secondbrain.second-brain-$name"
  dest="$AGENTS/$label.plist"

  sed -e "s|__BRAIN_DIR__|$BRAIN_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|/usr/local/bin/node|$NODE_BIN|g" \
      -e "s|/opt/homebrew/bin:/usr/local/bin|$NODE_DIR:/opt/homebrew/bin:/usr/local/bin|g" \
      "$tpl" > "$dest"

  if ! plutil -lint "$dest" > /dev/null 2>&1; then
    bad "$name — generated plist is invalid, not loading it"
    continue
  fi

  # bootout first so a re-run reloads instead of erroring "already loaded"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null
  if launchctl bootstrap "gui/$UID_NUM" "$dest" 2>/dev/null; then
    ok "$label loaded"
    INSTALLED=$((INSTALLED + 1))
  else
    bad "$label failed to load — try: launchctl bootstrap gui/$UID_NUM $dest"
  fi
done

echo
if [ "$INSTALLED" -gt 0 ]; then
  printf "${GREEN}Installed %s job(s).${OFF}\n\n" "$INSTALLED"
  cat <<EOF
  Check them:      node system/doctor.js
  Restart the bot: launchctl kickstart -k gui/$UID_NUM/com.secondbrain.second-brain-bot
  Logs:            $LOGS/second-brain-*.log
  Remove all:      bash install-launchd.sh --uninstall

  Do NOT also run the bot by hand — two copies fight over Telegram messages.
EOF
else
  printf "${YEL}Nothing installed.${OFF}\n"
fi
