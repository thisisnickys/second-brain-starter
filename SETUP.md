# Build Your Second Brain — the whole setup, step by step

Read this top to bottom the first time. Do not skip ahead to the Telegram part; it depends on everything before it.

**Time:** ~30 minutes to a working brain on your computer. ~20 more to have it on your phone. The automation and ingestion parts you can add over the following week.

**What you need:** a Mac, and the willingness to type things into a terminal window. That's it. You do not need to know how to code. You will copy and paste.

---

## Table of contents

- [Phase 0 — What this actually is, and why](#phase-0)
  - *includes: what to expect, week by week*
- [Phase 1 — Install the tools](#phase-1)
- [Phase 2 — Get the code and run setup](#phase-2)
- [Phase 3 — Make it yours (5 minutes, do not skip)](#phase-3)
- [Phase 4 — Your first notes, and the rules they follow](#phase-4)
- [Phase 5 — Ask your brain a question](#phase-5)
- [Phase 6 — See it: the galaxy and the workbench](#phase-6)
- [Phase 7 — Put it on your phone (Telegram)](#phase-7)
- [Phase 8 — Make it run itself (automation)](#phase-8)
- [Phase 9 — Feed it everything you already have](#phase-9)
- [Phase 10 — Back it up so you never lose it](#phase-10)
- [The MCPs — what connects to what](#mcps)
- [Mistakes that cost real days](#mistakes)
- [When something breaks](#troubleshooting)
- [The habit that makes it work](#habit)

---

<a name="phase-0"></a>
## Phase 0 — What this actually is, and why

### The goal

**A second brain is not a place to store things. It is a place to get things back.**

That distinction is the whole game. Saving is easy and feels productive — you bookmark, you screenshot, you star, you "save for later." Later never comes, and even if it did, you would not remember the thing existed to go looking for it.

This system is built around four commitments:

1. **You own the files.** Plain markdown on your own disk. No app can hold your thinking hostage, change its pricing, or shut down. If every tool in this guide disappeared tomorrow, you would still have a folder of readable text.
2. **Nothing gets saved without a decision attached.** Every captured note carries an **Apply** line: what this changes about what you do. A note without one is a bookmark wearing a costume.
3. **It comes to you.** A brain you have to remember to open is a brain you will stop opening. This one texts you in the morning, texts you at night, and answers when you text it back — so it lives where your attention already is.
4. **It connects, instead of piling up.** New captures get linked to related old notes automatically. Otherwise you end up with five separate notes about the same topic and no idea you already knew this.

### What you are actually building

```
   YOUR STUFF                THE BRAIN                    YOU
   ─────────                 ─────────                    ───
   desktop files ─┐                                   ┌─ galaxy (see it)
   Notion pages ──┤                                   │
   Google Drive ──┼──►  wiki/  ──►  index  ──►  graph ─┼─ ask it questions
   email/deals ───┤    (markdown,     (search)  (links)│
   videos/links ──┤     the truth)                     ├─ morning brief 8am
   your voice ────┘         ▲                          ├─ evening report 11:59pm
                            │                          └─ weekly report Sunday
                       Telegram bot
                       (capture from anywhere)
```

Left side: everything you already have, scattered. Middle: one folder of markdown, plus caches built from it. Right side: the ways it reaches you.

### An honest warning before you start

The building is the fun part. The habit is the hard part. A perfect system you use twice is worth less than an ugly one you use daily. Phase 4 is the smallest possible version that works — get there, live in it for a week, and only then come back for the automation.

### What to expect, realistically

Nobody does this in one sitting, and you shouldn't try. Here is the shape of it:

| When | What you do | What you have at the end | Feels like |
|---|---|---|---|
| **Day 1, ~30 min** | Phases 1–3: install, download, put your name and departments in | A brain that runs on your machine | Setup admin. Not exciting yet. |
| **Day 1, ~30 min** | Phases 4–6: write real notes, search them, open the galaxy | A working second brain you can see | The first "oh, this is actually mine" moment |
| **Days 2–7** | Nothing new. Just use it. Write a note a day. | Enough notes that search returns something useful | Slightly boring. This is the important week. |
| **Day 8, ~20 min** | Phase 7: the Telegram bot | Capture from your phone, from anywhere | This is where most people get hooked |
| **Day 9, ~15 min** | Phase 8: the schedules | Morning brief, evening report, nightly rebuild | It starts talking to you first |
| **Week 2–3** | Phase 9, one connection at a time | Your existing files, notes, and archives searchable | Your old stuff suddenly has a search box |
| **Whenever** | Phase 10: backups | Two copies. Sleep well. | Ten minutes, once |

**Where people actually quit:** somewhere in that boring week between Phase 6 and Phase 7. The system does not feel useful yet because there is nothing in it, and there is nothing in it because it does not feel useful yet. The only way out is to put a week of small, real notes in before you judge it.

**What it costs:** the code is free and has zero dependencies. The only paid thing is a Claude subscription for the distilling and answering — and if you are reading this you probably already have one. Everything else (Telegram, Node, Homebrew) is free.

### What "working" looks like after 90 days

So you know what you are aiming at, because it is not "a lot of notes":

- You stop screenshotting things, because you send them to the bot instead.
- You answer the evening question without experiencing it as a task.
- You search your own brain before you search the internet — at least sometimes.
- You find a decision note from four months ago and it saves you an entire argument.
- The galaxy shows you a department you have completely neglected, and you feel something about that.

None of that happens in week one. All of it happens if you keep the daily four minutes in the last section of this guide.

---

<a name="phase-1"></a>
## Phase 1 — Install the tools

### Open the terminal

Press `Cmd + Space`, type `Terminal`, press Enter. A window with text appears. This is where you will paste commands. After each one, press Enter and wait until the prompt comes back before doing the next.

### 1.1 — Install Homebrew (the thing that installs other things)

Paste this and press Enter. It will ask for your Mac password — that's normal, and your typing is invisible while you type it.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, it may print two lines starting with `echo` and tell you to run them. Do exactly what it says. Then close and reopen the terminal.

Check it worked:

```bash
brew --version
```

You should see a version number. If you see "command not found," Homebrew did not finish — re-read what it printed.

### 1.2 — Install Node.js

This is what runs the brain.

```bash
brew install node
```

Check:

```bash
node -v
```

You need **v18 or higher**. If you see v16 or lower, run `brew upgrade node`.

### 1.3 — Install Claude Code

This is the AI part. It is what turns a rambling voice note into a clean journal entry, and what answers your questions from your own notes.

```bash
npm install -g @anthropic-ai/claude-code
```

Then log in:

```bash
claude
```

Follow the login prompt in your browser, then type `/exit` to leave.

> **Cost note, and this one matters.** Use a Claude subscription, not API credits. See mistake #6 below — running on pay-per-token API billing can quietly cost more per day than the subscription costs per month, and nothing warns you.

### 1.4 — Install the media tools (optional, but you'll want them)

```bash
brew install ffmpeg yt-dlp
pip3 install -U openai-whisper
```

- **ffmpeg** — makes the voice notes your evening report sends.
- **yt-dlp** — downloads video captions when you send the bot a link.
- **whisper** — transcribes videos that have no captions (Instagram and TikTok never do).

> Install yt-dlp with **Homebrew**, not pip. The pip version gets blocked by YouTube. This is mistake #7.

---

<a name="phase-2"></a>
## Phase 2 — Get the code and run setup

### 2.1 — Download it

Copy these three lines one at a time:

```bash
cd ~
git clone https://github.com/thisisnickys/second-brain-starter.git second-brain
cd second-brain
```

What just happened: you moved into your home folder, downloaded the code into a folder called `second-brain`, and stepped inside it. Every command from here on assumes you are inside that folder. If you close the terminal and come back later, `cd ~/second-brain` puts you back.

(If you were given a `.zip` instead, unzip it, rename the folder to `second-brain`, drag it into your home folder, then run `cd ~/second-brain`.)

### 2.2 — Run setup

```bash
bash setup.sh
```

It checks what you have installed, creates your secrets file, builds your first index, and tells you what is missing. Green ✓ = good. Yellow ! = optional thing you skipped. Red ✗ = must fix before continuing.

If it says node is missing or too old, go back to Phase 1.2.

### 2.3 — Confirm it's alive

```bash
node system/doctor.js
```

Lots of red about "launchd not loaded" is **expected** right now — that is Phase 8, which you have not done yet. What matters is that the command runs at all.

---

<a name="phase-3"></a>
## Phase 3 — Make it yours (5 minutes, do not skip)

Open `brain.config.json` in any text editor (TextEdit is fine).

```json
{
  "owner": {
    "name": "Sam",
    "pronouns": { "subject": "they", "object": "them", "possessive": "their" }
  },
  "departments": ["business", "content", "projects", "personal"],
  ...
}
```

### Change your name and pronouns

Put your real first name in. Set the pronouns you actually use. **This is not cosmetic** — these strings are pasted into every AI prompt the system sends, which is how the evening report knows how to talk to you. Leave it as "Sam/they" and your brain will address you as a stranger.

### Change your four departments

Departments are the top-level buckets everything gets filed into. The defaults are `business, content, projects, personal`. Change them to the four areas of *your* life.

- A freelance designer: `clients, craft, business, personal`
- A student: `coursework, research, career, personal`
- Someone running a brand: `business, content, community, personal`

Rules: use lowercase, use hyphens instead of spaces (`side-hustle`, not `Side Hustle`), and **pick four and stop**. Every department you add is another decision you have to make on every single note. Four is enough. You can add a fifth in six months if you genuinely miss it.

Also fill in `departmentHints` — one line each saying what belongs there. The AI reads those hints when deciding where a capture goes, so a vague hint means badly filed notes.

### Rebuild after changing it

```bash
node system/lint-frontmatter.js
node system/build-index.js && node system/build-graph.js && node system/build-viz.js
```

If the linter complains that a department is invalid, it's because the sample notes still use the old names. Either edit those notes' `department:` lines, or just delete the samples.

---

<a name="phase-4"></a>
## Phase 4 — Your first notes, and the rules they follow

### The anatomy of a note

Every note in `wiki/` looks like this:

```markdown
---
title: What I learned about pricing from that call
department: business
tags: [pricing, sales, objections]
behaviors: [learn, connect]
type: file
source: conversation
updated: 2026-01-15
---

# What I learned about pricing from that call

## Core ideas

- People don't object to the price, they object to not seeing the value
- Naming the outcome before the number changes the entire conversation

## Apply

Rewrite the first slide of the proposal deck to lead with the outcome.
```

The block between the `---` lines is called **frontmatter**. It is what makes the note findable, colorable, and countable.

### The frontmatter rules (the linter enforces every one)

| Field | Required | Rules |
|---|---|---|
| `title` | **yes** | Any text. Write it as a sentence you'd actually search for. |
| `department` | **yes** | Exactly one of your four, spelled exactly right. |
| `updated` | **yes** | `YYYY-MM-DD`. Today's local date. |
| `tags` | practically | `[lowercase, kebab-case]`. 2–5 of them. |
| `behaviors` | optional | Any of `move`, `breathe`, `create`, `learn`, `connect`. |
| `type` | optional | `file`, `decision`, or `person`. |
| `source` | optional | Where it came from: `conversation`, `youtube`, `article`. |

Two hard rules that will bite you:

1. **Single-line values only.** No wrapping a title onto a second line. The parser is deliberately strict and simple.
2. **`updated` is your LOCAL date.** Not UTC. If you write a note at 8pm and it gets stamped with tomorrow's date, every "what did I do today" report will silently miss it.

### The Five Behaviors — the part most people skip

`behaviors` tags a note with what kind of *life activity* it represents:

- **move** — physical: workouts, walks, steps
- **breathe** — recovery: rest, prayer, meditation, journaling
- **create** — you made something
- **learn** — you took something in
- **connect** — you were with people

This looks like fluff. It isn't. Once these are tagged, the system can tell you *"you created five days straight and connected with nobody"* — which is the kind of thing you cannot see from the inside. If you skip these tags, the balance layer and the weekly report run blind. (That literally happened here: every task was untagged for two weeks and the whole balance feature was reporting on nothing. Mistake #8.)

**Connect is special: it cannot be detected automatically.** Calls and texts are invisible to any tracker. So the evening report just asks you: *"Who did you connect with today?"* Answer honestly, with names — the names become person pages.

### Write your first note

```bash
open -a TextEdit wiki/personal/2026-01-15-my-first-note.md
```

(Use today's date in the filename.) Copy the shape above, write something true, save. Then:

```bash
node system/lint-frontmatter.js
```

If it complains, it tells you the exact line and what's wrong. Fix it and run again. **When the linter is happy, run the rebuild:**

```bash
node system/build-index.js && node system/build-graph.js && node system/build-viz.js
```

### The note templates

`templates/` has three starting shapes — a general page, a capture note, and a decision note. Copy one when you're not sure how to structure something.

**Write decision notes.** They are the single highest-value thing in here. Six months from now you will not remember *why* you chose something, and without a note the argument restarts from zero. Shape: **Decision / Why / What I gave up.**

---

<a name="phase-5"></a>
## Phase 5 — Ask your brain a question

```bash
node system/brain.js "what did I decide about pricing"
```

This is deterministic index search — no AI, no cost, instant. It returns the notes most likely to hold your answer.

For a real conversational answer, use Claude Code from inside the folder:

```bash
cd ~/second-brain
claude
```

Then just ask: *"Search my brain and tell me what I've decided about pricing."*

> **Search before you save.** Every time you're about to capture something, search first. If a related note exists, add to it instead of starting a sixth one on the same topic. See mistake #4.

---

<a name="phase-6"></a>
## Phase 6 — See it: the galaxy and the workbench

### The galaxy (read-only)

```bash
open viz/index.html
```

Your brain as a force-directed galaxy. Four lenses across the top:

- **ARMS** — Applications / Routines / Memory / Skills, as rings
- **Departments** — your four buckets as clusters
- **Life Map** — a 12-element custom lens (see below)
- **Five Behaviors** — move / breathe / create / learn / connect as poles

Hover a node to light up its connections. Drag one and the whole web jiggles. Click one and the camera flies in and opens the note.

**Making the Life Map yours:** open `viz/world-map.json` and rename the twelve elements to whatever framework organizes your life or business. The `rules` list maps note paths to elements — edit those and rerun `node system/build-viz.js`. If you don't have a framework, leave it; it's the least important lens.

### The workbench (edit in the browser)

```bash
node system/viz-server.js --open
```

Same galaxy, plus an Edit button on every note and a Tasks drawer. Reach it at **http://localhost:4321**.

> Use `localhost`, **not** `127.0.0.1`. Browser extensions block `127.0.0.1` and `file://` and you'll get a blank page and no explanation.

Edits made here are linted before they save, and rolled back if they fail. You cannot corrupt a note through the workbench.

---

<a name="phase-7"></a>
## Phase 7 — Put it on your phone (Telegram)

This is the part that turns a folder of files into something you actually use. Take your time here.

### 7.1 — Create the bot

1. Install **Telegram** on your phone and computer. Make an account.
2. In Telegram, search for **@BotFather** (blue checkmark) and open the chat.
3. Send: `/newbot`
4. It asks for a display name. Anything: `My Brain`.
5. It asks for a username. Must end in `bot` and be globally unique: `sams_brain_2026_bot`.
6. It replies with a **token** that looks like `7823411234:AAH8x-vQ...`

**That token is a password.** Anyone with it controls your bot. Never paste it into a chat, a screenshot, a GitHub repo, or an AI conversation.

### 7.2 — Get your user id

In Telegram, search **@userinfobot**, open it, send any message. It replies with your numeric `Id` — something like `123456789`. Copy it.

This number is your allowlist. Only this user id will be able to talk to your brain, so a stranger who guesses your bot's name gets nothing.

### 7.3 — Put both into .env

```bash
open -a TextEdit ~/second-brain/.env
```

Fill in the two lines:

```
TELEGRAM_BOT_TOKEN=7823411234:AAH8x-vQ...
TELEGRAM_ALLOWED_USER_ID=123456789
```

**Four rules that have each cost someone a day:**

1. No quotes, no spaces around the `=`.
2. **Every line must end with a newline.** Put your cursor at the very end of the file and press Enter once. Without it, the next thing appended fuses onto your last value and everything silently fails auth. (Mistake #1.)
3. Never commit this file. It's already in `.gitignore` — leave it there.
4. **After ANY change to .env, restart the bot.** It reads .env once at startup and caches it. An un-restarted bot keeps happily running on the old broken value. (Also mistake #1.)

Verify the format:

```bash
cd ~/second-brain && node system/doctor.js | head -3
```

You want `🟢 .env — all keys present, no fused lines`.

### 7.4 — Start the bot

```bash
node system/telegram/bot.js
```

Leave that terminal window open. On your phone, open your bot's chat and send `hello`.

If it replies, you have a second brain in your pocket.

If nothing happens, check the terminal — the error is printed there. Most common: a typo in the token, or the wrong user id.

### 7.5 — What you can say to it

| Say this | It does this |
|---|---|
| `remind me to call the bank Friday` | Adds a task with a due date |
| paste any **YouTube** link | Downloads the transcript, distills it into a note, files it |
| paste an **Instagram/TikTok** link | Transcribes the audio locally, same treatment |
| paste any **article or tweet** | Fetches the text, distills, files |
| `remember: our renewal date is March 3` | Writes a small fact note |
| `person: Maya Chen — met at the workshop, runs a studio` | Creates or appends a person page |
| **`brain dump`** then talk for 3 minutes | A clean dated journal entry. No tasks extracted — this is for thinking out loud |
| `I have an idea: a course on...` | Appends to your idea bank |
| `idea bank` | Reads the latest ideas back |
| `what did I decide about pricing?` | Answers from your notes |
| `/tasks` | Lists what's open |
| `/evening` | Sends the evening report on demand |

**Voice notes work for all of it.** Record instead of typing; the system figures out from what you said whether it's a plan, a dump, a question, or a task.

> Instagram requires you to be logged into Instagram in **Chrome** on the same Mac — it borrows those cookies. TikTok usually works without.

---

<a name="phase-8"></a>
## Phase 8 — Make it run itself (automation)

Right now the bot dies when you close the terminal. `launchd` is macOS's way of keeping something running forever and starting it on a schedule.

### 8.1 — Install the schedules

```bash
cd ~/second-brain
bash install-launchd.sh
```

That script fills your real paths into the templates, copies them into `~/Library/LaunchAgents/`, and loads them. It prints exactly what it did.

### 8.2 — What you just turned on

| Job | When | What it does |
|---|---|---|
| `bot` | always running | The Telegram bot, restarted automatically if it crashes |
| `morning` | 8:00am daily | Morning brief: what's due, what's open |
| `evening` | 11:59pm Mon–Sat | Day summary + voice note + one coach question |
| `weekly` | 10:00pm Sunday | Week in review, blind-spot read, one focus for next week |
| `ingest` | 2:30am daily | Refresh files, Notion, health, journal, then rebuild everything |
| `nightshift` | 3:30am daily | Reads the day and surfaces 0–3 "sparks" — connections you missed |

Change any time by editing the `.plist` file in `~/Library/LaunchAgents/` and re-running the install script.

> **Evening report must fire before midnight.** Ours moved from 10pm to 11:59pm for a night owl — but not to 12:30am, because after midnight "today" is a different day and the whole report summarizes the wrong one.

### 8.3 — Restarting the bot after a code or .env change

```bash
launchctl kickstart -k gui/$(id -u)/com.secondbrain.second-brain-bot
```

**Never start a second copy by hand while launchd is running one.** Two bots polling Telegram fight over the same messages and you get random dropped replies. (Mistake #2.)

### 8.4 — Check on everything

```bash
node system/doctor.js
```

Read-only. Checks every scheduled job, every log, the .env format, index freshness, and whether anything is stale. Run it whenever something feels off.

---

<a name="phase-9"></a>
## Phase 9 — Feed it everything you already have

You now have a working brain with a handful of notes in it. This phase connects the piles you already own. **Do these one at a time, over a week.** Doing all of them in one night is how you end up with 10,000 files and no idea what's in there.

### 9.1 — Your desktop and drives (pointers, not copies)

Open `system/ingest/catalog-folders.json` and list the folders you want findable — Documents, Desktop, an external drive.

```bash
node system/ingest/file-catalog.js
```

This records **path, name, size, and date** for every file. **It does not copy, move, upload, or read the contents of anything.** The result is that you can ask "where is that keynote deck from the workshop" and get an answer, without duplicating a terabyte of video.

Those files appear as the faint dots in the galaxy.

### 9.2 — Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration** → copy the **Internal Integration Secret**.
2. Put it in `.env` as `NOTION_TOKEN=`.
3. **In Notion, open each page you want mirrored → `...` menu → Connections → add your integration.** Skipping this is the #1 reason the Notion pull 404s — the token is fine, the page just was never shared with it.
4. List the pages you want in `system/ingest/notion-pages.json` (the 32-character id from the page URL).

```bash
node system/ingest/notion-snapshot.js
```

Those pages now mirror into `wiki/` on every nightly run, so the brain can search them offline.

If you journal in Notion, set `NOTION_JOURNAL_DB` to that database's id and the evening report will read today's entry — and nudge you when you haven't written one.

### 9.3 — Google Drive, Gmail, Calendar

These connect through **MCP connectors** in Claude Code rather than through scripts in this repo, because they need OAuth logins that a script can't do safely.

In Claude Code, run `/mcp` and connect Google Drive, Gmail, and Google Calendar. Once connected, you can say things like *"read the strategy doc in my Drive and save the key decisions to my brain"* and Claude will do the fetching and the filing.

**Why email is not auto-ingested:** you do not want your entire inbox in your second brain. You want the four emails a month that actually matter. The pattern that works is a scan-and-score pass — look at inbound opportunities, score them, write one note per real one — which is what `system/telegram/deal.js` supports when you drive it from a Claude session.

### 9.4 — Your own published content

If you make things publicly — newsletters, posts, videos — pull that archive in. It turns the brain into an answer to *"have I already said this?"* which stops you repeating yourself and shows you what's worth resurfacing.

- Newsletter (Kit): set `KIT_API_KEY`, run `node system/ingest/kit-export.js`
- Substack: set `SUBSTACK_BASE=https://yourname.substack.com`, run `node system/ingest/substack-export.js`
- Then: `node system/corpus.js "your topic"` searches everything you've ever published.

### 9.5 — Health data (optional)

Install **Health Auto Export** on your iPhone and set it to write daily `.hae` JSON files to a folder. Point `health-ingest.js` at it. Sleep, steps, workouts, and heart data then show up in your evening report.

> If you put that folder in **iCloud Drive**, read mistake #3 first. It ate two weeks of data here.

---

<a name="phase-10"></a>
## Phase 10 — Back it up so you never lose it

`wiki/` is the only irreplaceable thing you have. Two backups, minimum.

### Backup 1 — a private GitHub repo

```bash
cd ~/second-brain
git init
git add -A
git commit -m "my brain"
```

Create a **private** repo on GitHub, then:

```bash
git remote add origin https://github.com/YOURNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```

**Before your first push, confirm your secrets are not in it:**

```bash
git status --porcelain | grep -E "\.env$" && echo "STOP — .env is staged" || echo "safe: .env is ignored"
```

If that says STOP, do not push. Run `git rm --cached .env` and check `.gitignore` still contains `.env`.

**Private, not public** — even sanitized, your notes are your notes.

### Backup 2 — a physical drive

```bash
git remote add portable "/Volumes/YOUR-DRIVE/second-brain"
git push portable main
```

The nightly ingest pushes to both automatically once the remotes exist.

> A cloud backup and a drive backup fail for different reasons. That's the point of having both.

---

<a name="mcps"></a>
## The MCPs — what connects to what

**MCP** (Model Context Protocol) is how Claude Code reaches other apps. In Claude Code, type `/mcp` to see and connect them.

**Worth connecting from day one:**

| MCP | What it unlocks |
|---|---|
| **Notion** | Read and write your Notion workspace from any session |
| **Google Drive** | Pull documents into notes |
| **Gmail** | Scan for real opportunities, draft replies |
| **Google Calendar** | Feed your actual schedule into the morning plan |

**Worth it later, depending on what you do:**

| MCP | For |
|---|---|
| **Stripe** | Revenue snapshots in your weekly review |
| **A community platform** | Member counts and engagement trends |
| **A newsletter tool** | Subscriber growth and open rates |
| **A wearable / meeting recorder** | Auto-detecting who you actually spoke with |

**Two rules about MCPs:**

1. **Connect one at a time and confirm each works before adding the next.** When five are half-configured, a failure gives you no idea which one broke.
2. **Anything that needs an interactive login will not work in a scheduled overnight job.** That's why the money and email work happen in sessions you start, and only the file/Notion/health work runs on a cron. Design around it instead of fighting it.

---

<a name="mistakes"></a>
## Mistakes that cost real days

These are not hypotheticals. Each one is a specific failure from building this system, with the date it happened and the rule it produced. Read them now; you will recognize them later at 1am.

### 1. The .env file that silently lied — cost: one full day

A token got repaired in `.env`, but the app kept returning 401 Unauthorized. The token was fine. Two things were wrong: the bot **caches .env at startup** and had never been restarted, and a line in the file was missing its final newline so the next value had **fused** onto the previous one.

**The rules:** after *any* `.env` edit, restart the bot. Always end the file with a newline. `system/lib/env-check.js` now checks for both, and `doctor.js` runs it.

### 2. Two bots fighting — cost: hours of "why did it ignore me?"

The bot was running under launchd, and a second copy got started by hand for testing. Two pollers hit Telegram's `getUpdates` and each one grabbed messages the other never saw. Replies vanished at random with no error anywhere.

**The rule:** exactly one bot. To restart it, use `launchctl kickstart -k`, never `node bot.js`.

### 3. iCloud silently deleted two weeks of imported data — cost: two weeks, permanently

Daily export files from a phone app were dropping into an iCloud Drive folder. iCloud "evicts" the contents of files it thinks are unused, leaving a placeholder. Every read failed with a cryptic `EDEADLK: resource deadlock avoided` — and the ingest script treated that error as "no data today" and moved on quietly. Two weeks were gone before anyone noticed the reports had gotten thin. There was no recovering it — that data existed nowhere else.

**The rules:** never store the source of truth in a folder that evicts files. And **never let an error path masquerade as an empty result** — "I couldn't read it" and "there was nothing there" must look different, loudly. A related late-sync bug permanently ate another day before a 7-day backfill was added.

### 4. The same thing captured five times — cost: the whole point of the system

An audit on July 22 found one topic saved as five separate notes, another as six, with **zero links between any of them.** The system was a pile, not a brain. It stored perfectly and connected nothing.

**The rule:** every new capture is checked against existing notes for topic overlap and stamped with a `**Related:** [[note]]` line. And the human habit that matters more: **search before you save.**

### 5. A question got filed as a to-do — cost: trust in the system

"Is that a skill that you can create and install for me?" got routed into the day-planning engine and turned into a to-do item. It read as a question but the router only recognized plans.

**The rule:** routing is deterministic and checked in a specific order — keywords first, then explicit requests, then questions, then everything else. When something lands in the wrong place, fix the router; do not just retrain yourself to phrase things the way the machine likes.

### 6. Paying per-token when a subscription already covered it — cost: real money, quietly

The whole engine was running on pay-per-token API billing instead of the subscription that was already being paid for. The daily burn was real money, and it accrued silently for weeks. The trap: **any `.env` that gets sourced and contains `ANTHROPIC_API_KEY` silently flips everything back to paid API billing**, even after you think you've switched.

**The rule:** delete unused API keys and verify they're actually dead. Keep exactly one live key if a product genuinely needs it, and know which one it is.

### 7. The wrong yt-dlp — cost: an evening of confusing failures

Video captures started failing. Two copies of `yt-dlp` were installed — one from pip, one from Homebrew — and the pip one was first in `PATH` and blocked by YouTube.

**The rule:** use the Homebrew build, and put explicit absolute paths in your scheduled jobs. A cron job has a different `PATH` than your terminal, which is a whole category of "works when I run it, fails at 3am."

### 8. Everything tagged "none" — cost: a feature that reported on nothing

The balance layer — the thing that tells you you've created five days straight and connected with no one — was running for weeks against tasks where every `behaviors` field was empty. It confidently displayed a picture of nothing.

**The rule:** if a feature depends on a field, make something *populate* that field automatically. A tag that requires human discipline on every entry will be empty within a month.

### 9. Connect looked broken, but was invisible

The system kept reporting zero social connection on days full of phone calls. Calls and texts leave no trace any tracker can see. Then the automatic pass over meeting transcripts over-corrected and started logging podcast hosts and preachers as "people I connected with."

**The rules:** when you cannot measure something, *ask* — the evening report asks "who did you connect with today?" and the names in your answer become person pages. And when you auto-detect people, gate it against a known-people list, or it will invent a social life for you.

### 10. Sunday had two reports

The daily evening report and a new weekly report both fired on Sunday night, duplicating and contradicting each other.

**The rule:** when you add a new scheduled job, explicitly remove the day it takes over. Overlapping automations are worse than either alone.

### The meta-lesson

Almost every one of these is the same shape: **a failure that looked like a success.** A 401 that looked like a bad token. An unreadable file that looked like an empty day. A pile of notes that looked like a knowledge base. Untagged data that looked like a balanced life.

Build things that fail *loudly*. Run `node system/doctor.js` weekly — that's the whole reason it exists.

---

<a name="troubleshooting"></a>
## When something breaks

**Always start here:**

```bash
cd ~/second-brain && node system/doctor.js
```

| Symptom | Almost always |
|---|---|
| Bot doesn't reply | Not running (`node system/doctor.js`), or a `.env` typo, or two copies fighting |
| Bot replies to *some* messages | Two copies running. Kill them all, kickstart once |
| Auth error after fixing a key | You didn't restart the bot. It cached the old value |
| "not in business\|content\|..." | A note has a department that isn't in `brain.config.json` |
| Galaxy is blank | `node system/build-viz.js` hasn't been run since your last change |
| Workbench blank at 127.0.0.1 | Use `http://localhost:4321` instead |
| Notion returns 404 | The page was never shared with your integration (Phase 9.2, step 3) |
| Video capture fails | Wrong `yt-dlp` (use Homebrew), or the video has no captions and whisper isn't installed |
| Report says "no data" | Check whether it *couldn't read* rather than *found nothing* — see mistake #3 |
| Scheduled job never ran | `PATH` in the plist. Cron-like jobs don't inherit your terminal's environment |

**Run the tests** if you've changed code:

```bash
node --test "tests/**/*.test.js"
```

528 tests. All should pass.

---

<a name="habit"></a>
## The habit that makes it work

The system is finished. You are not. Here is the smallest routine that keeps it alive:

**Daily (about 4 minutes)**
- Send the bot one thing you learned, saw, or decided. One.
- Answer the evening question honestly, out loud, as a voice note.

**Weekly (about 15 minutes)**
- Read the Sunday report.
- Run `node system/doctor.js` and clear anything red.
- Write **one decision note** about something you changed your mind on.

**Monthly (about 30 minutes)**
- Search your own brain for something from two months ago. If you can't find it, your tags need work — that's the real health check.
- Delete notes that turned out to be noise. A second brain that never forgets becomes a landfill.

**The single rule that matters most:** when you capture something, write the **Apply** line. Every time. A note without one is a bookmark, and you already have thousands of those.

---

*Built on a system running daily since July 2026. The code is the same code. The mistakes are real mistakes. Make it yours.*
