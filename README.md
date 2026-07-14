# 滴答清单 → Markdown

[中文](README.md) · [English](README.en.md)

> **滴答能导出 CSV，但任务里的图片和附件全丢了。这个工具把它们一起搬走。**

滴答清单 / TickTick 的官方导出只给一份 CSV——任务文字能带走，**图片、附件一律不导出**；官方 OpenAPI 同样拿不到附件。想迁到 Obsidian / Notion 或本地归档，图就没了。

本工具补上这一块：把任务**连同附件图片**，导出成结构化的 Markdown 笔记库。

## ✨ 它能做什么

- 🖼️ **救回图片** —— 任务里的附件图片一并下载、按任务归档（官方导出和 API 都做不到）
- 📝 **结构化笔记** —— 每个任务一个 `.md`，YAML 元信息（创建/截止/完成时间、优先级、重复、标签、提醒、**父子任务**、**文件夹**）+ 原始正文
- 🗂️ **诚实清单** —— `manifest.json` 记录每一项的落盘路径，**并如实标注哪些没拿到**
- 🔌 **两种入口** —— 命令行（批量归档）+ Chrome 扩展（一键导出），共用同一套核心逻辑

## 两种用法

| | 命令行 CLI | Chrome 扩展 ([`extension/`](extension/)) |
| --- | --- | --- |
| 取图 | macOS + Chrome（读本地 cookie） | 任意系统 + Chrome 登录 |
| 出口 | 写本地文件夹 | 浏览器下载 zip |
| 适合 | 批量、自动化 | 不装 Node、一键搞定 |

> 也支持**纯 CSV 模式**（不带图）——全平台、零依赖、完全合规。

## 快速开始（Chrome 扩展）

不想装 Node、只想点几下就导出的，用 Chrome 扩展：

[![下载扩展](https://img.shields.io/badge/⬇%20下载扩展-ticktick--markdown.zip-18181b?style=for-the-badge)](https://github.com/wrightgeoff112-star/ticktick-to-markdown/releases/latest/download/ticktick-markdown-extension.zip)

1. 点上面按钮下载 zip，**解压**。
2. 打开 `chrome://extensions`，右上角开启**开发者模式**。
3. 点**「加载已解压的扩展程序」**，选解压出来的文件夹。
4. 登录滴答清单网页版，点工具栏的插件图标，按弹窗提示导出即可。

> Chrome 扩展目前需以"开发者模式"手动加载；上架应用商店后可一键安装。

## 快速开始（CLI）

需要 Node.js ≥ 18。CSV 怎么拿：滴答网页端 **设置 → 导出 / 备份**。

```bash
npm install

# 直接跑（无需 build）—— 只要文字（全平台、无图）
npm run dev -- ./TickTick.csv

# 文字 + 图片（需 macOS + Chrome 登录 dida365）
npm run dev -- ./滴答清单.csv --with-images

# 或编译后跑
npm run build && node dist/cli.js ./TickTick.csv --out ~/Obsidian/滴答
```

| 选项 | 说明 |
| --- | --- |
| `--out <dir>` | 输出目录，默认 `./vault` |
| `--with-images` | 额外取附件图片（仅 macOS + Chrome + dida365） |
| `--host <id>` | `dida365`（国内，默认，**已验证**）/ `ticktick`（海外，**实验性**） |

## 产出长什么样

```
vault/
├── <清单名>/
│   └── <任务标题>.md      # 每个任务一个文件：YAML frontmatter + 正文
├── attachments/
│   └── <附件id>.<ext>     # 图片字节（仅 --with-images）
└── manifest.json          # 机读真值：路径映射 + 缺口清单
```

单个任务文件：

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

下面这张图也一起搬过来了：
![](attachments/att-9.png)
```

> 上面是顶层任务的示例。**子任务**会额外多一行 `parent: <父任务id>`，指回父任务——父子层级不丢。

> **时间字段**：`start` = 滴答 Start Date，`end` = 滴答 Due Date。滴答的 “Due Date” 其实是这段时间的**结束点**（滴答只有一段时间、没有独立截止概念），所以这里写成 `start`/`end`（一段时间的头尾），**不产生 `due`**。`due` 这个字段名留给「真截止」——滴答没有，故不输出。别把 `end` 改回 `due`。

正文里的图片引用会被改写成本地相对路径——**只对真正下载到的图片改写**，没拿到的保持原样，并在 manifest 里记一笔。下游工具（比如导回另一个 App）应读 `manifest.json`，不要反向解析 markdown。

## 图片是怎么抓到的（以及为什么有风险）

`--with-images` 复刻了一个登录浏览器做的事：

1. 从 **macOS 钥匙串**读 Chrome 的加密密钥；
2. 解密 Chrome 的 cookie 库，恢复你的登录态；
3. 用这个 cookie 调滴答的**内部 `/api/v2` 接口**，枚举任务、读附件元信息；
4. 再发一个带认证的请求下载每张图的字节。

> Chrome 扩展走同样的接口，但用 `chrome.cookies` 拿登录态——所以扩展端不限 macOS，只要在浏览器里登过就行。

⚠️ 这用的是**未公开的内部接口**，滴答随时可能改字段 / 改路径 / 加签名，**随时可能失效**。任何一步失败，工具会**静默回退为无图导出**，并把原因写进 manifest。详见下方免责声明。

## 支持矩阵

| 能力 | dida365（国内） | ticktick（海外） |
| --- | --- | --- |
| CSV → Markdown（默认档） | ✅ 全平台 | ✅ 全平台 |
| `--with-images`（macOS + Chrome） | ✅ 已验证 | ⚠️ 实验性、未验证 |
| `--with-images`（Windows / Linux CLI） | ❌ 记缺口 | ❌ 记缺口 |
| 扩展取图（任意系统 + Chrome） | ✅ | ⚠️ 实验性 |

即便在已验证路径上，**已完成任务的图也可能不全**：内部接口只回最近一段时间完成的任务（`limit=100` 时间窗），更早的抓不到——这些缺口都会列在 manifest 里，不撒谎。

## 免责声明

**本工具独立开发，与 TickTick / 滴答清单无任何隶属或关联，未获其授权。**

- **默认档**只用官方 CSV，完全合规。
- **`--with-images`** 用你自己的登录态调滴答**未公开内部接口**，随时可能失效，届时静默回退为无图。
- **仅限导出本人数据**，严禁访问他人账号或抓取公开内容。
- 自动访问内部接口可能与滴答服务条款冲突，风险自负。
- **请勿商用**——保持个人 / 开源 / 免费，实际风险很低；一旦收费风险显著上升。
- 按 MIT 协议「按原样」提供，**不作任何担保**。

## License

MIT © ticktick-export contributors. See [LICENSE](LICENSE).

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 离线测试，无需登录 / 网络
npm run build            # 编译 CLI → dist/
npm run build:extension  # 打包浏览器扩展 → extension/popup.js
```

测试覆盖：CSV 解析、vault / manifest 构造、导出编排（注入 fetch + cookie loader，离线跑通取图链）、Chrome cookie 解密往返。
