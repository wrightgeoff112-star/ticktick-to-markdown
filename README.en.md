# 滴答清单备份助手 · Markdown Export 1.0.0

[中文](README.md) · [English](README.en.md)

> **TickTick exports a CSV, but every image and attachment inside your tasks is left behind. This tool brings them along.**

TickTick / 滴答清单's official export gives you a single CSV — the task text comes out, but **images and attachments are not exported at all**, and the official OpenAPI offers no attachment access either. Move to Obsidian / Notion or archive locally, and the images are gone.

This tool fills that gap: it exports your tasks **together with images and ordinary file attachments** into a structured Markdown vault.

## ✨ What it does

- 🖼️ **Saves attachments** — downloads available images and ordinary files, with local Markdown links (official CSV and OpenAPI omit them)
- 📝 **Structured notes** — one `.md` per task, with YAML frontmatter (created / start / end / completed times, priority, repeat, tags, reminders, **parent task**, **folder**) + the original body
- 🗂️ **Honest manifest** — `manifest.json` records the on-disk path of every item and **plainly flags what couldn't be captured**
- 🔌 **Three entry points** — a native desktop app, a CLI (batch), and a Chrome extension, sharing one core

## Desktop app (macOS / Windows)

Choose the account site and ZIP save location, click **开始备份** (Start backup), and complete login on the official site. No Node, Chrome extension, manually selected CSV, or cookie input is required. Credentials stay native; the remote login window cannot invoke local file commands.

**Desktop installers have not been released yet.** No download link is claimed here. Future releases should provide a macOS DMG (drag the app into Applications) and a Windows NSIS EXE. Windows runtime still requires device verification. The shared desktop orchestration ran against a real logged-in TickTick account in Chrome: 16 tasks, 4 lists and 1 CSV attachment. The ZIP was saved and passed CRC checks; the attachment matched the original bytes. The official CSV generator returned `export_too_many_times` (HTTP 500), so the app used read-only task endpoints and preserved `api-snapshot.json`, with an explicit gap for the unavailable official CSV. The native Mac app also saved a real-account ZIP with 16 tasks and 1 attachment, passing CRC and attachment hash checks. The unavailable official CSV remains an explicit gap.

The ZIP contains the original `backup.csv` (or `api-snapshot.json` on fallback), Markdown, attachments and `manifest.json`. Partial completion, failures, cancellation and retry are visible. Successful downloads are retained for retry during the current app session.

Native limits: 2 GiB per attachment, 128 MiB per API JSON response. Downloads and archive writes stream through temporary disk files. Extract the archive to open the Markdown vault in Obsidian or another compatible tool; metadata support varies by tool.

For developers: `bun run desktop:mac` on macOS or `bun run desktop:windows` on Windows. Rust and Tauri platform dependencies are required for source builds, but not for ordinary users installing the eventual packages. `bun run dev:desktop` serves the frontend at 127.0.0.1:1420. Manual CI builds are configured for Apple Silicon Mac, Intel Mac and Windows x64 in `.github/workflows/desktop-build.yml`; nothing is automatically published. See [RELEASING.md](RELEASING.md) for release steps.

## CLI and Chrome extension

| | CLI | Chrome extension ([`extension/`](extension/)) |
| --- | --- | --- |
| Images | macOS + Chrome (reads local cookie) | Any OS + Chrome logged in |
| Output | Writes a local folder | Browser zip download |
| Best for | Batch, automation | No Node, one click |

> A **CSV-only mode** (no images) is also available — cross-platform and local.

## Quick start (CLI)

Source usage requires Bun and Node.js ≥ 18. Get the CSV from the web app's **Settings → Export / Backup**.

```bash
bun install

# Run directly (no build) — text only (cross-platform, no images)
bun run dev -- ./TickTick.csv

# Text + images and files (requires macOS + Chrome logged into the selected site)
bun run dev -- ./TickTick.csv --with-images

# TickTick international site
bun run dev -- ./TickTick.csv --with-images --host ticktick

# Or build, then run
bun run build && node dist/cli.js ./TickTick.csv --out ~/Obsidian/TickTick
```

| Option | Description |
| --- | --- |
| `--out <dir>` | Output directory, defaults to `./vault` |
| `--with-images` | Also fetch images and files (macOS + Chrome logged into the selected site) |
| `--host <id>` | `dida365` (China, default, **verified**) / `ticktick` (international) |

## What you get

```
vault/
├── <List>/
│   └── <Task title>.md      # One file per task: YAML frontmatter + body
├── backup.csv              # Official source; api-snapshot.json on fallback
├── attachments/
│   └── <attachmentId>.<ext>  # Original image and file bytes
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
end: 2026-06-12T10:00:00.000Z
created: 2026-06-01T00:00:00.000Z
allDay: false
timezone: Asia/Shanghai
tags: [release, urgent]
repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"
---

# Ship v1

This diagram came along too:
![](../attachments/att-9.png)
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

⚠️ This uses **undocumented internal endpoints**. TickTick may change fields / paths / add signatures at any time, so **it can break at any moment**. If any step fails, the tool **reports partial completion and records the gaps** and writes the reason into the manifest. See the disclaimer below.

## Support matrix

| Capability | dida365 (China) | ticktick (overseas) |
| --- | --- | --- |
| CSV → Markdown (default) | ✅ cross-platform | ✅ cross-platform |
| `--with-images` (macOS + Chrome) | ✅ verified | ✅ real attachment API sample |
| `--with-images` (Windows / Linux CLI) | ❌ records gap | ❌ records gap |
| Extension image fetch (any OS + Chrome) | ✅ | ✅ same attachment API |

There is no demonstrated six-month cutoff. A real check on 2026-10-02 downloaded images uploaded in March/April 2025 from a task completed on 2026-01-12. Inbox is resolved from the batch inboxId. Full 100-row history pages are split recursively; failed/saturated scans and ambiguous task identities become explicit gaps. All CSV tasks are retained.

## Disclaimer

**This tool is independently developed. It has no affiliation with TickTick / 滴答清单 and is not endorsed by them.**

- The **default mode** converts a user-provided official CSV into local Markdown.
- **`--with-images`** uses your own login session to call TickTick's **undocumented internal endpoints**, which may break at any time; on failure it records explicit gaps.
- **Export your own data only** — never access others' accounts or scrape public content.
- Automated access to internal endpoints may conflict with TickTick's Terms of Service; you assume the risk.
- Shared for personal archiving. Independent naming, original artwork and this notice do not establish authorization or guarantee legal protection.
- Provided "as is" under the MIT license, **without any warranty**.

## License

MIT © ticktick-export contributors. See [LICENSE](LICENSE).

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit
bun run test             # offline tests, no login / network needed
bun run build            # compile CLI → dist/
bun run build:extension  # bundle the browser extension → extension/popup.js
```

Test coverage: CSV parsing, vault / manifest construction, export orchestration (fetch + cookie loader injected, image pipeline run offline), Chrome cookie decryption round-trip.
