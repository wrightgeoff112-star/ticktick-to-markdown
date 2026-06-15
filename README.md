# ticktick-export

Export your **TickTick / 滴答清单** tasks into an **Obsidian / Markdown vault** — optionally enriched with attachment images.

- **Default mode** — uses only the official CSV export. Cross-platform, no images, fully compliant.
- **`--with-images` mode** — additionally pulls attachment images via a local cookie-direct engine. **macOS + Chrome + dida365 only**, and it talks to TickTick's **unofficial internal API**. Use at your own risk.

> 中文说明见下方 [中文文档](#中文文档)。

---

## What you get

Run it against your CSV and you get a vault directory:

```
vault/
├── <List Name>/
│   └── <Task Title>.md      # one file per task: YAML frontmatter + body
├── attachments/
│   └── <attachmentId>.<ext> # downloaded bytes (only with --with-images)
└── manifest.json            # machine-readable source of truth
```

Each task markdown file looks like:

```markdown
---
id: dida-task-1
sourceTaskId: task-1
kind: task
status: todo
list: Roadmap
priority: 3
start: 2026-06-10T01:00:00.000Z
due: 2026-06-12T10:00:00.000Z
allDay: false
timezone: Asia/Shanghai
tags: [release, urgent]
repeat: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"
repeatStatus: parsed
reminders: [-PT30M]
---

# Ship v1

Need to attach the diagram
![](attachments/att-9.png)
```

The body keeps your original note; image references are rewritten to relative
`attachments/...` paths **only** for images that were actually downloaded.

### `manifest.json` — the stable contract

`manifest.json` is the machine-readable source of truth. Downstream tools (for
example a re-import into another app) should **read the manifest and never
reverse-parse the markdown**. It contains:

- `schemaVersion` — bump-on-break version of the manifest format.
- `source` — host, csv path, whether images were requested, whether the host's
  image path is verified.
- `counts` — tasks / projects / attachments / attachments downloaded.
- `projects`, `tasks`, `attachments` — with their on-disk file paths.
- `gaps` — **an honest list of what could NOT be captured**, with stable
  machine codes, e.g.:
  - `images_disabled` — default mode, no images requested.
  - `images_skipped_not_macos` — `--with-images` requested off macOS.
  - `images_skipped_overseas_unverified` — `--host ticktick` image path unverified.
  - `image_engine_failed` — cookie/login/network failure; fell back to no-images.
  - `task_attachment_unreachable` — task not reachable via the internal API
    (commonly: a completed task outside the `limit=100` time window).
  - `attachment_download_failed` — metadata found but byte download failed.

---

## Install & run

Requires Node.js ≥ 18.

```bash
npm install
npm run build          # compiles to dist/

# or run directly without building:
npx tsx src/cli.ts <export.csv>
```

### Get your CSV

In the **TickTick / 滴答 web app**: **Settings → Export (设置 → 导出 / 备份)** and download the CSV. This is the official, supported, cross-platform data source.

### Usage

```bash
ticktick-export <export.csv> [options]
```

| Option | Description |
| --- | --- |
| `--out <dir>` | Output vault directory. Default `./vault`. |
| `--with-images` | Also fetch attachment images (macOS + Chrome + dida365 only). |
| `--host <id>` | `dida365` (国内, default, **verified**) or `ticktick` (海外, **experimental**). |
| `--format <fmt>` | `vault` (default, Obsidian/Markdown) · `sortday` (a single `<out>.sortday.zip`) · `both`. |
| `-h, --help` | Show help. |
| `-v, --version` | Show version. |

#### Import into Sortday

`--format sortday` writes a single `<out>.sortday.zip` (the Sortday SDX format —
fresh local ids, structured fields, and downloaded images as `<sd-attachment>`
nodes). In Sortday open **设置 → 导入数据 / Settings → Import data** and pick that
zip; everything (tasks, notes, lists, images) lands as plain local data — no
account link, no per-image lazy loading, no dependency on this tool afterwards.

```bash
ticktick-export ./滴答清单.csv --with-images --format sortday
# -> vault.sortday.zip   (open it in Sortday → 导入数据)
```

### Examples

```bash
# Default: cross-platform, no images
ticktick-export ./TickTick.csv

# Into an Obsidian vault folder
ticktick-export ./TickTick.csv --out ~/Obsidian/TickTick

# With images (macOS + Chrome, logged into dida365)
ticktick-export ./滴答清单.csv --with-images

# Overseas, experimental image path (may not work at all)
ticktick-export ./TickTick.csv --with-images --host ticktick
```

---

## Support matrix

| Capability | dida365 (国内) | ticktick (海外) |
| --- | --- | --- |
| CSV → markdown vault (default) | ✅ cross-platform | ✅ cross-platform |
| `--with-images` on macOS + Chrome | ✅ verified | ⚠️ **experimental, unverified** |
| `--with-images` on Windows / Linux | ❌ (gap recorded) | ❌ (gap recorded) |

- The **default (CSV-only) mode works everywhere** and needs nothing but the CSV.
- Images require **macOS + Google Chrome** with an active login, because the
  engine reads and decrypts Chrome's cookie via the macOS Keychain.
- The `ticktick` (overseas) image path is **untested**: domains, cookie domains,
  CSRF behaviour and attachment endpoints may differ. It may simply not work,
  in which case a gap is recorded and you still get the full no-image vault.
- Even on the supported path, **completed tasks may be incomplete**: the internal
  API only returns recent completed tasks (a `limit=100` time window), so older
  done tasks' images may be unreachable. These misses are listed in `manifest.json`.

---

## How the image engine works (and why it's risky)

`--with-images` reproduces what a logged-in browser does:

1. Reads the **Chrome Safe Storage** password from the **macOS Keychain**.
2. Decrypts Chrome's cookie database (`PBKDF2(saltysalt, 1003, sha1)` →
   `AES-128-CBC`) to recover your login cookie.
3. Calls TickTick's **internal `/api/v2` web endpoints** with that cookie to
   enumerate projects and tasks and read attachment metadata.
4. Performs a second authenticated `GET` to download each attachment's bytes.

This uses **undocumented, unofficial internal APIs** that are not endorsed by
TickTick / 滴答 and **may break or change at any time**. Nothing is sent
anywhere except to TickTick's own servers, but **you are solely responsible**
for any use. If anything fails, the tool degrades gracefully to a no-image vault
and records the reason in `manifest.json`.

---

## Disclaimer

This is an independent, unofficial tool. The default mode uses only the official
CSV export. The `--with-images` mode uses an unofficial internal API and reads
your local browser cookie. It is provided **as is**, without warranty, under the
MIT license. Use at your own risk.

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test (no images / network required)
npm run build       # emit dist/
```

Tests cover the CSV parser, the vault/manifest builder, the export orchestrator
(with an injected fetch + cookie loader, so the `--with-images` path is exercised
offline), and the Chrome cookie decryption round-trip.

---

## 中文文档

把 **滴答清单 / TickTick** 的任务导出成 **Obsidian / Markdown 知识库**，可选带图。

### 两档模式

- **默认档**：只用官方导出的 CSV。**跨平台、合规、无图**，任何系统都能跑。
- **`--with-images` 档**：在 CSV 之上，用 cookie 直连引擎补图。**仅 macOS + Chrome + dida365**，且使用的是滴答**非官方内部接口**，随时可能失效，**风险自负**。

### 怎么拿 CSV

滴答网页端 **设置 → 导出 / 备份**，下载 CSV。这是官方、合规、跨平台的数据来源。

### 用法

```bash
ticktick-export <导出的.csv> [选项]
```

- `--out <目录>`：输出目录，默认 `./vault`。
- `--with-images`：额外取图（仅 macOS + Chrome + dida365）。
- `--host dida365|ticktick`：`dida365` 国内（默认，**已验证**）；`ticktick` 海外（**实验性，未验证，可能直接不支持图片**）。

### 产出

- `vault/<清单名>/<任务标题>.md`：每个任务一个文件，YAML frontmatter 放结构化字段（id / 状态 / 时间 / 清单 / 优先级 / 重复 / 提醒 / tags），正文用相对路径 `![](attachments/<id>.<ext>)` 引图。
- `vault/attachments/<附件id>.<ext>`：附件字节（仅 `--with-images`）。
- `vault/manifest.json`：**机读真值**，含 `schemaVersion`、任务/项目/附件 → 本地文件的映射，并**如实标注缺口**（非 macOS、海外未验证、已完成任务超出 `limit=100` 时间窗拿不全等）。下游工具应认 manifest，不要反向解析 markdown。

### 风险与边界

- 默认档只依赖 CSV，哪里都能跑。
- 取图依赖 macOS Keychain + Chrome 登录态，仅 macOS 可用。
- `ticktick`（海外）取图分支**未经测试**，域名 / 接口 / cookie 域可能不同，可能完全不工作；失败会记录到 manifest 并回退为无图。
- 即便在支持路径上，**已完成任务可能取不全**（内部接口只回最近的已完成任务），缺口都会列在 manifest 里。

### 免责声明

独立的非官方工具。默认档只用官方 CSV；`--with-images` 用的是非官方内部接口并读取本地浏览器 cookie。按 MIT 协议「按原样」提供，不作任何担保，**风险自负**。
