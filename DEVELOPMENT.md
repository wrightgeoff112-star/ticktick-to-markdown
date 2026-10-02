# 开发滴答清单备份助手

面向开发者的源码构建与数据格式说明。用户下载、安装和备份操作见 [README.md](README.md)，发布安装包见 [RELEASING.md](RELEASING.md)。

## 源码构建

需要 Bun、Node.js ≥ 18、Rust stable 与 Tauri 2 平台依赖。macOS 使用 Xcode Command Line Tools；Windows 使用 Microsoft C++ Build Tools 和 WebView2。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:desktop
bun run test
cargo test --manifest-path desktop/src-tauri/Cargo.toml
bun run build:desktop
bun run dev:desktop
```

桌面开发预览使用 `127.0.0.1:1420`。纯浏览器预览没有原生登录、文件选择或保存能力；真实导出使用 Tauri 应用。

```bash
# 在对应操作系统构建安装包
bun run desktop:mac        # app + dmg
bun run desktop:windows    # NSIS exe
```

产物位于 `desktop/src-tauri/target/release/bundle/`。GitHub Actions 的 **Desktop installers** 分别生成 Apple Silicon Mac、Intel Mac 和 Windows x64 产物，由维护者手动发布。

## 代码结构

- `desktop/`：桌面界面与 Tauri 原生层，负责官方登录、文件选择、下载与 ZIP 保存。
- `src/lib/desktop-export.ts`：桌面导出编排、取消、重试及保存已有备份。
- `src/lib/api-backup.ts`：官方 CSV 限频或服务器失败时的只读 API 备用路径。
- `src/lib/csv.ts`、`enrich.ts`、`image-api.ts`、`vault.ts`：解析、附件关联与 Markdown 生成。
- `src/test/`：离线导出、历史覆盖、身份消歧、附件链接与保存行为测试。

登录会话在原生层处理；远程官方登录窗口不能调用本地文件命令。附件流写临时磁盘，ZIP 写入临时文件后提交到所选路径。单个附件最大 2 GiB，JSON/CSV 响应最大 128 MiB。

## ZIP 数据格式

`schemaVersion` 为 `1`。官方 CSV 路径的 `source.method` 为 `official-csv`，`source.csvFile` 指向 `backup.csv`；备用路径为 `api`，`source.apiFile` 指向 `api-snapshot.json`，不生成伪造 CSV。

CSV 路径下，`tasks.sourceTaskId` 保持导出文件的任务序号，可选 `apiTaskId` 是后端真实 ID。API 备用路径下，`sourceTaskId` 来自后端真实任务 ID。`tasks.attachmentIds` 关联 `attachments`；附件 `file: null` 表示未下载。`gaps` 记录未匹配、身份歧义、历史未覆盖、下载失败、取消或官方 CSV 不可用。

任务的 Markdown frontmatter 保留创建、开始、结束、完成时间、状态、优先级、标签、提醒、重复、父任务和文件夹。时间字段沿用 `start` / `end`，其中 `end` 对应源数据的 Due Date，不另输出 `due`。子任务用 `parent` 指向父任务 ID。

下载成功的图片引用改写为相对于 Markdown 文件的路径；普通附件生成本地链接。下载失败的远程引用保留，并记录缺口。读取结构化数据时使用 `manifest.json`，不要反向解析 Markdown。

## 本地开发辅助工具

保留 CSV 转换命令用于调试共享核心，不作为用户安装入口：

```bash
bun run dev -- ./TickTick.csv --out ./vault
bun run build
```

开发辅助命令的 `--with-images` 依赖 macOS 本地 Chrome 会话；这与桌面应用的原生官方登录是不同路径。桌面端不读取 Chrome 的 Cookie 库。
