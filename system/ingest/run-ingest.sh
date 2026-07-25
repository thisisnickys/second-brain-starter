#!/bin/bash
# Second-brain ingest orchestrator. Deterministic — zero Claude cost.
# Repo root — derived from this script's own location, so the brain works
# wherever you cloned it (no hardcoded home directory).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/system/logs"
mkdir -p "$LOG_DIR"
TODAY=$(date +%Y-%m-%d)
declare -a NAMES=() STATUSES=()

step() { # step <name> <cmd...>
  local name="$1"; shift
  if "$@" >> "$LOG_DIR/ingest-$TODAY.log" 2>&1; then
    NAMES+=("$name"); STATUSES+=("green")
  else
    NAMES+=("$name"); STATUSES+=("red")
  fi
}

cd "$ROOT" || exit 1
step notion  node system/ingest/notion-snapshot.js
[ -f system/ingest/file-catalog.js ] && step catalog node system/ingest/file-catalog.js
[ -f system/ingest/kit-export.js ] && step kit node system/ingest/kit-export.js
[ -f system/ingest/substack-export.js ] && step substack node system/ingest/substack-export.js
[ -f system/ingest/content-catalog.js ] && step content node system/ingest/content-catalog.js
step health  node system/ingest/health-ingest.js
# Health backfill — re-ingests the last 7 days when a day's note is missing or
# its .hae synced late (iCloud/phone lag ate Jul 13 2026 permanently). Skips
# manually-corrected notes. Fail-soft per day inside the script.
step health-backfill node system/ingest/health-ingest.js --backfill 7
# Journal pull (only if you journal in Notion). Nightly run
# covers YESTERDAY (script default) to catch late-night entries; the evening
# report pulls today's separately. Fail-soft (no entry / Notion down => green).
step journal node system/ingest/notion-journal.js
# Limitless connect pass — nightly ~2:30am run covers YESTERDAY (script default is today).
# Fail-soft inside the script (no key / API down => exit 0); must never break the pipeline.
step connect node system/ingest/limitless-connect.js --date "$(date -v-1d +%Y-%m-%d)"
# Agent-fleet research → rolling weekly wiki note. Fail-soft inside the script
# (no token / Notion down / zero rows => exit 0); must never break the pipeline.
step research node system/ingest/research-snapshot.js
# Repurpose queue — regenerates wiki/content/repurpose/queue.md before lint/index so it gets indexed.
step repurpose node system/repurpose.js --write
step lint    node system/lint-frontmatter.js
step index   node system/build-index.js
step graph   node system/build-graph.js
step viz     node system/build-viz.js
step commit  bash -c 'git add -A && (git diff --cached --quiet || git commit -m "chore: ingest $(date +%Y-%m-%d)")'
# Git sync is OPTIONAL — it runs only once you have added a remote called
# "origin" (see SETUP.md step 9). No remote = these steps are skipped, not failed.
if git remote get-url origin > /dev/null 2>&1; then
  step pull    git pull --rebase origin main
  step push    git push origin main
else
  NAMES+=("pull"); STATUSES+=("skipped")
  NAMES+=("push"); STATUSES+=("skipped")
fi
if git remote get-url portable > /dev/null 2>&1 && [ -d "$(git remote get-url portable)" ]; then
  step portable git push portable main
else
  NAMES+=("portable"); STATUSES+=("skipped")
fi

OVERALL="green"; JSON="{\"date\":\"$TODAY\",\"steps\":{"
for i in "${!NAMES[@]}"; do
  [ "$i" -gt 0 ] && JSON+=","
  JSON+="\"${NAMES[$i]}\":\"${STATUSES[$i]}\""
  [ "${STATUSES[$i]}" = "red" ] && OVERALL="red"
done
JSON+="},\"overall\":\"$OVERALL\"}"
echo "$JSON" > "$LOG_DIR/last-run.json"

SUMMARY=""
for i in "${!NAMES[@]}"; do SUMMARY+="${NAMES[$i]}:${STATUSES[$i]} "; done
if [ "$OVERALL" = "green" ]; then
  echo "🧠 brain ingest: all green ($SUMMARY)"
else
  echo "⚠️ brain ingest: FAILURES — $SUMMARY(see $LOG_DIR/ingest-$TODAY.log)"
fi
[ "$OVERALL" = "green" ]
