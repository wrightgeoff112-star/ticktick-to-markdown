# 滴答清单备份助手 · Markdown 导出 1.0.0

[中文](README.md) · [English](README.en.md)

> **滴答能导出 CSV，但任务里的图片和附件全丢了。这个工具把它们一起搬走。**

滴答清单 / TickTick 的官方导出只给一份 CSV——任务文字能带走，**图片、附件一律不导出**；官方 OpenAPI 同样拿不到附件。想迁到 Obsidian / Notion 或本地归档，图就没了。

本工具补上这一块：把任务**连同图片和普通文件附件**，导出成结构化的 Markdown 笔记库。

## ✨ 它能做什么

- 🖼️ **带走附件** —— 下载任务中的图片、CSV 等普通文件，并在 Markdown 中生成本地链接（官方 CSV 和 OpenAPI 不提供）
- 📝 **结构化笔记** —— 每个任务一个 `.md`，YAML 元信息（创建/开始/结束/完成时间、优先级、重复、标签、提醒、**父子任务**、**文件夹**）+ 原始正文
- 🗂️ **诚实清单** —— `manifest.json` 记录每一项的落盘路径，**并如实标注哪些没拿到**
- 🔌 **三种入口** —— 桌面版（官方网页登录后导出）+ 命令行（批量归档）+ Chrome 扩展，共用同一套核心逻辑

## 桌面一键导出（macOS / Windows）

桌面版不需要 Node、Chrome 扩展、手动找 CSV 或输入 cookie。打开「滴答清单备份助手」，选择账号站点和 ZIP 保存位置，点「开始备份」，在独立官方页面完成登录；随后自动取得官方备份（限频或服务器失败时改用任务接口）、扫描附件并生成 Markdown 笔记库。解压 ZIP 后，可在 Obsidian 等支持 Markdown 的工具中使用。保存失败可直接再次保存已有备份。

**当前处于开发验证阶段，桌面安装包尚未发布。** 此处没有可供普通用户下载的安装包链接；发布后应在本仓库 Releases 提供 macOS `.dmg` 和 Windows `.exe`。安装时，macOS 打开 DMG 后将应用拖入 Applications；Windows 运行安装程序。源码构建说明见下方。Windows 目前只有构建配置，实际登录与导出尚未验证；国际站已用 Chrome 已登录真实账号跑通共享桌面导出编排：16 条任务、4 个清单、1 个 CSV 附件，ZIP 实际保存、解压校验通过，附件与源文件逐字节一致。官方 CSV 生成器返回 `export_too_many_times`（HTTP 500），工具自动改用只读任务接口，保留 `api-snapshot.json` 原始记录，并明确标记官方 CSV 未取得。原生 Mac 桌面端也已实际保存完整账号的 Markdown 与附件 ZIP（16 条任务、1 个附件），CRC 和附件哈希校验通过；官方 CSV 缺口仍明确保留。

登录凭据只留在原生层；远程登录网页没有本地文件和高权限命令访问能力。官方登录要求的验证码或二次验证必须在官方页面完成。

导出有明确的「完整 / 部分完成 / 失败 / 取消」状态。缺口显示在界面与 manifest；重试保留本次会话中已下载的文件，重新扫描失败项。关闭应用后临时下载不作为可恢复会话。

| 入口 | 身份来源 | 输出 |
| --- | --- | --- |
| 桌面版 | 独立官方 WebView 登录 | 原始 CSV 或 API JSON + Markdown + 附件，单 ZIP |
| CLI | macOS 本地 Chrome 登录态，或仅 CSV | 本地 vault 文件夹 |
| Chrome 扩展 | Chrome 登录态，需手动选择官方 CSV | vault ZIP |

扩展源码保留在 [`extension/`](extension/)，需要开发者模式加载；现有 `v0.1.0` Release 提供旧版扩展 ZIP，当前 1.0.0 扩展可从源码加载。

## 快速开始（CLI）

源码运行需要 Bun 和 Node.js ≥ 18。CSV 怎么拿：滴答网页端 **设置 → 导出 / 备份**。

```bash
bun install

# 直接跑（无需 build）—— 只要文字（全平台、无图）
bun run dev -- ./TickTick.csv

# 文字 + 图片和文件附件（需 macOS + Chrome 登录对应站点）
bun run dev -- ./滴答清单.csv --with-images

# TickTick 国际站
bun run dev -- ./TickTick.csv --with-images --host ticktick

# 或编译后跑
bun run build && node dist/cli.js ./TickTick.csv --out ~/Obsidian/滴答
```

| 选项 | 说明 |
| --- | --- |
| `--out <dir>` | 输出目录，默认 `./vault` |
| `--with-images` | 额外获取图片和文件附件（macOS + Chrome 登录对应站点） |
| `--host <id>` | `dida365`（国内，默认，**已验证**）/ `ticktick`（国际站） |

## 产出长什么样

```
vault/
├── <清单名>/
│   └── <任务标题>.md      # 每个任务一个文件：YAML frontmatter + 正文
├── backup.csv             # 官方源数据；备用路径改为 api-snapshot.json
├── attachments/
│   └── <附件id>.<ext>     # 图片与普通文件的原始字节
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
![](../attachments/att-9.png)
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

⚠️ 这用的是**未公开的内部接口**，滴答随时可能改字段 / 改路径 / 加签名，**随时可能失效**。任何一步失败，工具会**明确报告部分完成或失败**，并把原因写进 manifest。详见下方免责声明。

## 支持矩阵

| 能力 | dida365（国内） | ticktick（海外） |
| --- | --- | --- |
| CSV → Markdown（默认档） | ✅ 全平台 | ✅ 全平台 |
| `--with-images`（macOS + Chrome） | ✅ 已验证 | ✅ 附件接口样本验证 |
| `--with-images`（Windows / Linux CLI） | ❌ 记缺口 | ❌ 记缺口 |
| 扩展取图（任意系统 + Chrome） | ✅ | ✅ 同一附件接口 |

没有已证实的「只能取半年内附件」限制：2026-10-02 的真实验证成功下载了 2026-01-12 完成任务中于 2025-03 / 04 上传的图片。收集箱使用 batch 返回的独立 inboxId，而非普通项目列表。

历史任务按 CSV 完成时间查询完整时间桶；接口满 100 条时递归拆分窗口。请求失败、最小窗口仍满页或缺少完成时间会标为未完成扫描。任务重名会按真实 ID、正文附件 ID、创建/完成时间消歧，仍不唯一时不会猜测归属。所有 CSV 条目仍保留。

原生单个附件最大 2 GiB，官方 JSON/CSV 响应最大 128 MiB；下载流写临时磁盘，ZIP 流式打包。解压后的 Markdown 笔记库可在 Obsidian 等工具中打开，不同工具对任务字段的支持可能不同。文件后缀不保证真实格式，桌面下载会检查字节类型。

## 免责声明

**本工具是独立的开源 Markdown 导出工具，与 TickTick / 滴答清单无任何隶属或关联，未获其授权。**

- **默认档**读取用户自行取得的官方 CSV，在本地生成 Markdown。
- **`--with-images`** 用你自己的登录态调滴答**未公开内部接口**，随时可能失效，届时明确记录缺口。
- **仅限导出本人数据**，严禁访问他人账号或抓取公开内容。
- 自动访问内部接口可能与滴答服务条款冲突，风险自负。
- 本工具供个人分享与本地归档使用；独立名称、原创标识与声明不构成授权或法律保证。
- 按 MIT 协议「按原样」提供，**不作任何担保**。

## License

MIT © ticktick-export contributors. See [LICENSE](LICENSE).

## 开发

```bash
bun install
bun run typecheck        # tsc --noEmit
bun run test             # 离线测试，无需登录 / 网络
bun run build            # 编译 CLI → dist/
bun run build:extension  # 打包浏览器扩展 → extension/popup.js
```

测试覆盖：CSV 解析、vault / manifest 构造、导出编排（注入 fetch + cookie loader，离线跑通取图链）、Chrome cookie 解密往返。

### 桌面源码构建

开发者需要 Bun、Rust stable 与 Tauri 2 平台依赖；macOS 需要 Xcode Command Line Tools，Windows 需要 Microsoft C++ Build Tools 和 WebView2。普通用户使用将来发布的安装包，不需要这些开发依赖。

```bash
bun install
bun run typecheck
bun run typecheck:desktop
bun run build:desktop
bun run dev:desktop        # 本地静态预览 127.0.0.1:1420 + Tauri
bun run desktop:mac        # 在 macOS 上构建 app + dmg
bun run desktop:windows    # 在 Windows 上构建 NSIS exe
```

产物位于 `desktop/src-tauri/target/release/bundle/`。Windows 必须在 Windows 构建与验证，不能把 macOS 构建通过视为 Windows 运行证据。`.github/workflows/desktop-build.yml` 按 Apple Silicon Mac、Intel Mac 和 Windows x64 分别提供手动构建产物，不自动发布。第一次发布的具体步骤见 [RELEASING.md](RELEASING.md)。

### ZIP 契约

`schemaVersion` 保持为 `1`。官方 CSV 路径的 `source.method` 为 `official-csv`，`source.csvFile` 指向 `backup.csv`；`tasks.sourceTaskId` 保持 CSV 的 taskId 序号，可选 `apiTaskId` 为后端真实 ID。备用路径的 `source.method` 为 `api`、`source.apiFile` 指向 `api-snapshot.json`，不生成伪造 CSV，此时 `sourceTaskId` 来自真实任务 ID。`tasks.attachmentIds` 关联 `attachments`，`file: null` 表示下载失败；`gaps` 明示未匹配、歧义、历史未覆盖、下载失败或取消。它是通用 Markdown 笔记库及源数据归档。
