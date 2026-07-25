#!/bin/bash
# One-shot corpus finish line (Jul 2026 backfill): whisper the remaining
# caption-less YouTube queue, then local-whisper the top-1000 reels Instagram
# has no transcript for, then rebuild + sync. Safe to re-run — every step
# skips what's already captured. Run DETACHED (nohup) so it survives the
# Claude session:
#   nohup bash ~/second-brain/system/ingest/finish-line.sh > ~/second-brain/system/logs/finish-line.log 2>&1 &
ROOT="$HOME/second-brain"
cd "$ROOT" || exit 1

echo "=== [$(date)] youtube whisper queue (lives + shorts) ==="
node system/ingest/youtube-transcripts.js --whisper --cookies

echo "=== [$(date)] instagram reel whisper (top-1000 residual) ==="
node system/ingest/instagram-reel-whisper.js

echo "=== [$(date)] final ingest ==="
bash system/ingest/run-ingest.sh
echo "=== [$(date)] FINISH LINE COMPLETE ==="