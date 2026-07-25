# Second Brain — Starter

A second brain you actually own: **plain markdown files on your own computer**, searchable by an AI, visible as a living galaxy, and reachable from your phone over Telegram.

No database. No subscription. No vendor who can shut it down. Every file here is text you will still be able to open in twenty years.

> This is the sanitized, shareable version of a system that has been running daily since July 2026 — morning brief, evening report, nightly ingest, and all. The code is the same. The content, the keys, and the personal details are not included.

---

## What it does

| You do this | And this happens |
|---|---|
| Text your bot a YouTube link | It pulls the transcript, distills it into a note with an **Apply** line, and files it |
| Say "brain dump" and talk for 3 minutes | Your rambling becomes a clean dated journal entry |
| Say "remind me to call the accountant Friday" | A task lands in `tasks/tasks.md` with a due date |
| Ask "what did I decide about pricing?" | It answers from *your own notes*, not the internet |
| Nothing, at 8am | A morning brief arrives: what's due, what's open |
| Nothing, at 11:59pm | An evening report arrives — text plus a spoken voice note — with one coach question |
| Open `viz/index.html` | Your whole brain as a force-directed galaxy you can drag around |

## The one idea

**The markdown files are the truth. Everything else is a cache.**

The search index, the graph, the galaxy — all of it is rebuilt from `wiki/` by one command. Delete every index and you lose nothing. Delete `wiki/` and your brain is gone. Back up accordingly.

## Start here

```bash
bash setup.sh
```

Then open **[SETUP.md](SETUP.md)** and follow it in order. It assumes you have never opened a terminal before. About 30 minutes to a working brain, plus another 20 for the phone.

## What's in the box

```
wiki/                  your notes. THE ONLY IRREPLACEABLE FOLDER.
tasks/tasks.md         your to-do list, as plain text
inbox/inbox.md         raw captures you haven't filed yet
indexes/               generated search index (rebuildable)
viz/                   the galaxy — index.html + world-map.json
brain.config.json      your name, your pronouns, your 4 departments
templates/             the shapes a good note comes in
system/
  lint-frontmatter.js  the gatekeeper — bad notes never land
  build-index.js       wiki -> searchable index
  build-graph.js       index + your Claude skills + your apps -> graph
  build-viz.js         graph -> galaxy
  brain.js             ask the brain a question (deterministic, no AI cost)
  doctor.js            read-only health check of the whole system
  viz-server.js        the workbench: edit notes in the browser
  ingest/              nightly refresh — files, Notion, health, journal
  telegram/            the bot, morning brief, evening + weekly report
  nightshift/          overnight synthesis -> "sparks"
tests/                 528 tests. Run: node --test "tests/**/*.test.js"
```

## Requirements

- **A Mac.** Scheduling uses `launchd`, which is macOS-only. Everything else is portable; on Linux you would swap `launchd` for `cron`.
- **Node.js 18+** — [nodejs.org](https://nodejs.org), the LTS button.
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`) — this is the part that distills and answers. Without it, storage and search still work; understanding does not.
- Optional: `ffmpeg`, `yt-dlp`, `whisper` for media capture and voice notes.

**Zero runtime npm dependencies.** Nothing in `system/` installs a package. That is deliberate: a dependency you don't have can't break, get abandoned, or get compromised.

## Safety rules baked in

- `.env` is gitignored and never committed. `setup.sh` `chmod 600`s it.
- The workbench server binds to `127.0.0.1` only, serves only `viz/`, `wiki/`, and `raw/`, checks the Host header, and requires a JSON content-type on writes.
- The Telegram bot has a hard allowlist — one user id, yours.
- The AI is called with a narrow `--allowedTools` list: read + your own brain search. Nothing that writes, deletes, or reaches another service.
- Every write to `wiki/` passes the linter first, and rolls back if it fails.

## License

MIT. Take it, rename it, make it yours.
