# TickTick → Markdown

[中文](README.md) · [English](README.en.md)

> **TickTick exports a CSV, but every image and attachment inside your tasks is left behind. This tool brings them along.**

TickTick / 滴答清单's official export gives you a single CSV — the task text comes out, but **images and attachments are not exported at all**, and the official OpenAPI offers no attachment access either. Move to Obsidian / Notion or archive locally, and the images are gone.

This tool fills that gap: it exports your tasks **together with their attachment images** into a structured Markdown vault.

## ✨ What it does

- 🖼️ **Saves images** — downloads every task's attachment images and files them alongside the task (neither the official export nor the API can do this)
- 📝 **Structured notes** — one `.md` per task, with YAML frontmatter (created / start / due / completed times, priority, repeat, tags, reminders, **parent task**, **folder**) + the original body
- 🗂️ **Honest manifest** — `manifest.json` records the on-disk path of every item and **plainly flags what couldn't be captured**
- 🔌 **Two entry points** — a CLI (batch) and a Chrome extension (one-click), sharing one core

## Two ways to use it

| | CLI | Chrome extension ([`extension/`](extension/)) |
| --- | --- | --- |
| Images | macOS + Chrome (reads local cookie) | Any OS + Chrome logged in |
| Output | Writes a local folder | Browser zip download |
| Best for | Batch, automation | No Node, one click |

> A **CSV-only mode** (no images) is also available — cross-platform, zero dependencies, fully compliant.

## Quick start (CLI)

Requires Node.js ≥ 18. Get the CSV from the web app's **Settings → Export / Backup**.

```bash
npm install

# Run directly (no build) — text only (cross-platform, no images)
npm run dev -- ./TickTick.csv

# Text + images (requires macOS + Chrome logged into dida365)
npm run dev -- ./TickTick.csv --with-images

# Or build, then run
npm run build && node dist/cli.js ./TickTick.csv --out ~/Obsidian/TickTick
```

| Option | Description |
| --- | --- |
| `--out <dir>` | Output directory, defaults to `./vault` |
| `--with-images` | Also fetch attachment images (macOS + Chrome + dida365 only) |
| `--host <id>` | `dida365` (China, default, **verified**) / `ticktick` (overseas, **experimental**) |

## What you get

```
vault/
├── <List>/
│   └── <Task title>.md      # One file per task: YAML frontmatter + body
├── attachments/
│   └── <attachmentId>.<ext>  # Image bytes (--with-images only)
└── manifest.json             # Machine-readable truth: path map + gap list
```

A single task file:

```markdown
---
id: dida-task-1
folder: Work
list: Roadmap
status: todo
priority: 3
start: 2026-06-10T01:00:00.000Z
due: 2026-06-12T10:00:00.000Z
created: 2026-06-01T00:00:00.000Z
allDay: false
timezone: Asia/Shanghai
tags: [release, urgent]
repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"
---

# Ship v1

This diagram came along too:
![](attachments/att-9.png)
```

> The example above is a top-level task. A **subtask** gets one extra line — `parent: <parent-task-id>` — pointing back to its parent, so the hierarchy isn't lost.

Image references in the body are rewritten to local relative paths — **only for images that were actually downloaded**; ones that weren't are left untouched and recorded in the manifest. Downstream tools (e.g. importing into another app) should read `manifest.json`, not reverse-parse the markdown.

## How images are fetched (and why it's risky)

`--with-images` replays what a logged-in browser does:

1. Read Chrome's encryption key from the **macOS Keychain**;
2. Decrypt Chrome's cookie store to recover your login session;
3. Use that cookie to call TickTick's **internal `/api/v2` endpoints**, enumerating tasks and reading attachment metadata;
4. Send an authenticated request to download each image's bytes.

> The Chrome extension hits the same endpoints but uses `chrome.cookies` for the session — so the extension isn't macOS-bound; being logged into the browser is enough.

⚠️ This uses **undocumented internal endpoints**. TickTick may change fields / paths / add signatures at any time, so **it can break at any moment**. If any step fails, the tool **silently falls back to a no-image export** and writes the reason into the manifest. See the disclaimer below.

## Support matrix

| Capability | dida365 (China) | ticktick (overseas) |
| --- | --- | --- |
| CSV → Markdown (default) | ✅ cross-platform | ✅ cross-platform |
| `--with-images` (macOS + Chrome) | ✅ verified | ⚠️ experimental, unverified |
| `--with-images` (Windows / Linux CLI) | ❌ records gap | ❌ records gap |
| Extension image fetch (any OS + Chrome) | ✅ | ⚠️ experimental |

Even on the verified path, **images for completed tasks may be incomplete**: the internal endpoint only returns tasks completed within a recent window (`limit=100` time window), so earlier ones can't be fetched — these gaps are all listed in the manifest, no pretending otherwise.

## Disclaimer

**This tool is independently developed. It has no affiliation with TickTick / 滴答清单 and is not endorsed by them.**

- The **default mode** uses only the official CSV — fully compliant.
- **`--with-images`** uses your own login session to call TickTick's **undocumented internal endpoints**, which may break at any time; on failure it silently falls back to no-image.
- **Export your own data only** — never access others' accounts or scrape public content.
- Automated access to internal endpoints may conflict with TickTick's Terms of Service; you assume the risk.
- **Do not commercialize** — keep it personal / open-source / free and the practical risk stays low; charging money raises the risk significantly.
- Provided "as is" under the MIT license, **without any warranty**.

## License

MIT © ticktick-export contributors. See [LICENSE](LICENSE).

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # offline tests, no login / network needed
npm run build            # compile CLI → dist/
npm run build:extension  # bundle the browser extension → extension/popup.js
```

Test coverage: CSV parsing, vault / manifest construction, export orchestration (fetch + cookie loader injected, image pipeline run offline), Chrome cookie decryption round-trip.
