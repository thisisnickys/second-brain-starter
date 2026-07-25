# What was removed from this copy

This repo is the working code from a live second brain, with everything
personal stripped out. So you know exactly what you did and did not receive:

## Removed entirely

- **All notes.** The original `wiki/` (150+ files: journals, health data, people,
  business decisions, client work). Replaced with three sample notes.
- **All secrets.** `.env` was never copied. You get `.env.example` with empty values.
- **All generated indexes and caches** — `indexes/`, `viz/data.js`, `system/logs/`,
  night-shift sparks and ledger. These rebuild from your own notes in one command.
- **All downloaded media** — transcripts, articles, published-content corpus.
- **Private design docs and build logs.**

## Replaced with neutral examples

- **Notion page IDs** — `system/ingest/notion-pages.json` is now empty, and the
  journal / research database ids read from your `.env`.
- **Drive and folder paths** — `catalog-folders.json` now points at `~/Documents`
  and `~/Desktop` instead of specific external drives.
- **The 4th galaxy lens** — a proprietary business framework became a generic
  12-element "Life Map" you can rename to anything.
- **Names in tests** — real people's names replaced with fictional ones.
- **Owner name and pronouns** — now read from `brain.config.json`. They were
  hardcoded into AI prompts; they are configuration now.
- **launchd labels** — personalized job labels became `com.secondbrain.*`.
- **Absolute home paths** — the `.plist` files are templates with placeholders
  that `install-launchd.sh` fills in with your real paths.

## What you did receive

Every line of working code: the linter, index and graph builders, the galaxy,
the workbench server, the retrieval engine, the doctor, the full Telegram bot
(captures, journaling, tasks, ideas, people, deal replies, intent routing), the
morning brief, evening and weekly reports, the night shift, the balance layer,
the repurpose queue, the entire ingest pipeline — and all 528 tests.

```bash
node --test "tests/**/*.test.js"
```

All 528 pass on this sanitized copy. If they don't, something is wrong with
your Node install, not with the code.
