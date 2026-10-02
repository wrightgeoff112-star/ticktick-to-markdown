# 滴答清单备份助手（浏览器扩展）

把滴答清单 / TickTick 任务一键导出成 Markdown 笔记库（Obsidian 等可用），可选同步图片和普通文件附件。

本目录仍是可独立加载的 Chrome 扩展，没有被桌面版替换或删除。与根目录的 Node CLI、新增桌面助手共用核心逻辑（`src/lib`：CSV 解析 / vault 构建 / 附件编排），入口和认证、文件保存方式不同。桌面版自动获取官方 CSV，官方生成器限频或服务器失败时可改用任务接口备份；本扩展仍要求手动选择 CSV。

| | Node CLI | 浏览器扩展（本目录） |
| --- | --- | --- |
| 入口 | `src/cli.ts` | `extension/src/main.ts` → popup |
| cookie 来源 | macOS Keychain + Chrome Cookies SQLite | `chrome.cookies` API |
| 产物出口 | 写本地目录 | 浏览器下载 zip |
| 平台 | 仅 macOS（取图）/ 全平台（无图） | Chrome 通用 |

## 构建

```bash
# 在项目根目录
bun install
bun run build:extension   # esbuild → extension/popup.js
```

改了 `extension/src/*` 或复用的 `src/lib/*` 后，**必须重新 build**，否则 popup 不更新。

## 本地加载（开发）

1. `bun run build:extension` 生成 `popup.js`。
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 「加载已解压的扩展程序」→ 选本 `extension/` 目录。
4. 点扩展图标 → 选站点 → 选 CSV →（可选）勾图片 → 下载。
5. 改代码后，扩展卡片上点「刷新」即可，不用重选目录。

> `file://` 直接打开 `popup.html` 只能验渲染与 CSS，无法验取图链（`chrome.*` 在扩展外不可用）。

## 取图前置

- 勾选「同步获取图片和文件附件」前，**本浏览器要先登录对应站**（dida365.com 或 ticktick.com）。
- 扩展用 `chrome.cookies` 读登录态，需要 `permissions: cookies` + `host_permissions`（已配在 `manifest.json`）。
- TickTick 国际站附件接口已用真实 CSV 文件验证完整下载；本次未重新验收扩展全流程，实际失败会记入 manifest 的 gaps。

## 图标

已内置 `icons/icon-16.png`、`icon-32.png`、`icon-48.png` 和 `icon-128.png`，并在 `manifest.json` 中注册。

## 已知限制

- 没有已证实的“完成超过半年就抓不到附件”硬限制。2026-10-02 已通过真实接口取回超过半年完成任务的历史图片；收集箱使用独立 `inboxId` 定位，满 100 条的历史窗口会继续拆分。旧限制说明作废。
- 仍不保证所有附件都能取回：任务身份有歧义、扫描未覆盖或下载失败时，如实记录到 `manifest.json` 的 `gaps`。不能把请求失败解释为空结果，也不能按同名任务猜附件归属。
- 本次更新了共享核心及扩展打包产物；真实账号一键导出已通过 Chrome 验证共享桌面编排；Mac 原生独立登录与导出也已实测；扩展全流程仍需单独人工回归。扩展源码保留不等于 Chrome 商店或安装包已经发布。
- 图片通道是滴答**非官方内部接口**，改版可能失效。详见根 README 的 Disclaimer。
