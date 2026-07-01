# 滴答清单导出 Markdown（浏览器扩展）

把滴答清单 / TickTick 任务一键导出成 Markdown 笔记库（Obsidian 等可用），可选同步附件图片。

与根目录的 Node CLI 共用同一套核心逻辑（`src/lib`：CSV 解析 / vault 构建 / 图片编排），只是入口和「取 cookie + 出口」不同：

| | Node CLI | 浏览器扩展（本目录） |
| --- | --- | --- |
| 入口 | `src/cli.ts` | `extension/src/main.ts` → popup |
| cookie 来源 | macOS Keychain + Chrome Cookies SQLite | `chrome.cookies` API |
| 产物出口 | 写本地目录 | 浏览器下载 zip |
| 平台 | 仅 macOS（取图）/ 全平台（无图） | Chrome 通用 |

## 构建

```bash
# 在项目根目录
npm install
npm run build:extension   # esbuild → extension/popup.js
```

改了 `extension/src/*` 或复用的 `src/lib/*` 后，**必须重新 build**，否则 popup 不更新。

## 本地加载（开发）

1. `npm run build:extension` 生成 `popup.js`。
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 「加载已解压的扩展程序」→ 选本 `extension/` 目录。
4. 点扩展图标 → 选站点 → 选 CSV →（可选）勾图片 → 下载。
5. 改代码后，扩展卡片上点「刷新」即可，不用重选目录。

> `file://` 直接打开 `popup.html` 只能验渲染与 CSS，无法验取图链（`chrome.*` 在扩展外不可用）。

## 取图前置

- 勾选「同步获取附件图片」前，**本浏览器要先登录对应站**（dida365.com 或 ticktick.com）。
- 扩展用 `chrome.cookies` 读登录态，需要 `permissions: cookies` + `host_permissions`（已配在 `manifest.json`）。
- 海外 ticktick 的图片路径**实验性、未实测**，可能抓不到（不崩，缺口记入 manifest 的 gaps）。

## 图标

当前未内置图标文件（Chrome 会用默认图标）。如需自定义，放 `icons/icon-16.png` / `32` / `48` / `128`，并在 `manifest.json` 加：

```json
"icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
```

## 已知限制

- 图片不是 100% 能抓全：完成超半年 / 单时间窗 >100 / 标题改过 / Inbox 特殊清单 → 抓不到，如实记入 `manifest.json` 的 `gaps`，完成文案提示「N 项没拿到」。
- 图片通道是滴答**非官方内部接口**，改版可能失效。详见根 README 的 Disclaimer。
