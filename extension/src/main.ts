/**
 * 扩展 popup 入口：站点选择 → CSV 选择 →（可选）图片 → 下载 vault zip。
 *
 * 编排逻辑复用根 src/lib（parseDidaCsv / buildVault / enrichWithImages），
 * 浏览器引擎由 engine.ts 的 createBrowserEngine 提供。这层只负责：
 * 双语切换、UI 交互、把 runExport 那套编排搬到「zip 下载」出口。
 */

import { parseDidaCsv } from "../../src/lib/csv.js";
import { enrichWithImages } from "../../src/lib/enrich.js";
import { resolveHost, type HostId } from "../../src/lib/host.js";
import { buildVault, type ResolvedAttachment } from "../../src/lib/vault.js";
import type { ManifestGap } from "../../src/lib/manifest.js";
import { createBrowserEngine } from "./engine.js";
import { zipVaultPlan, triggerDownload } from "./zip.js";

const TOOL_VERSION = "0.1.0";

type Lang = "zh" | "en";

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    title: "滴答清单导出 Markdown",
    subtitle: "任务数据 → Markdown，可用于 Obsidian 等笔记软件",
    hostCn: "中国站",
    hostEn: "全球站",
    step1Title: "① 从滴答清单导出数据",
    step1Login: "登录网页版（dida365.com）",
    step1Settings: "左上角头像 → 设置 → 账号与安全",
    step1Backup: "导入与备份 → 数据备份 → 生成备份",
    step1Download: "下载得到 CSV 文件",
    step2Title: "② 导出成 Markdown",
    csvHint:
      "选择上一步得到的 CSV 文件，即可生成一套带 YAML frontmatter 的 Markdown 笔记，可直接用于 Obsidian 等软件。如需连同附件图片一并导出，请勾选下方选项。",
    csvLabel: "选择 CSV 文件",
    withImages: "同步获取附件图片（需本浏览器已登录滴答清单网页版）",
    download: "下载",
    processing: "处理中…",
    selectCsvWarn: "请先选择 CSV 文件",
    parsed: "CSV 解析完成：{tasks} 个任务 / {lists} 个清单",
    fetching: "正在获取图片…",
    done: "完成：{tasks} 个任务{gapClause}",
    doneGap: "，{gaps} 项没拿到",
    error: "出错了：{msg}",
  },
  en: {
    title: "TickTick to Markdown",
    subtitle: "Task data → Markdown, works with Obsidian & co.",
    hostCn: "China",
    hostEn: "Global",
    step1Title: "① Export from TickTick",
    step1Login: "Log in to the web app (ticktick.com)",
    step1Settings: "Avatar (top-left) → Settings → Account & Security",
    step1Backup: "Import & Backup → Data Backup → Generate backup",
    step1Download: "Download the CSV file",
    step2Title: "② Export to Markdown",
    csvHint:
      "Choose the CSV file from the previous step to generate a set of Markdown notes with YAML frontmatter, ready for Obsidian & co. To export attachment images as well, tick the option below.",
    csvLabel: "Choose CSV file",
    withImages: "Also fetch attachment images (requires being logged in to TickTick web in this browser)",
    download: "Download",
    processing: "Processing…",
    selectCsvWarn: "Please choose a CSV file first",
    parsed: "CSV parsed: {tasks} tasks / {lists} lists",
    fetching: "Fetching images…",
    done: "Done: {tasks} tasks{gapClause}",
    doneGap: ", {gaps} missed",
    error: "Error: {msg}",
  },
};

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function getHostId(): HostId {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="host"]:checked',
  );
  return (checked?.value as HostId) ?? "dida365";
}

/** 站点 ↔ 语言一一对应：dida365 → zh，ticktick → en。 */
function langForHost(hostId: HostId): Lang {
  return hostId === "dida365" ? "zh" : "en";
}

/** 动态状态文案模板。 */
function t(key: string, vars?: Record<string, string | number>): string {
  const lang = langForHost(getHostId());
  let s = I18N[lang][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

/** 切换所有静态文案，并翻转地区按钮顺序（本站靠前）。 */
function applyLang(lang: Lang): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n!;
    el.textContent = I18N[lang][key] ?? key;
  }
  const seg = document.querySelector<HTMLElement>(".segmented");
  if (seg) seg.dataset.activeLang = lang;
}

type StatusKind = "info" | "ok" | "warn" | "error";

function setStatus(message: string, kind: StatusKind = "info"): void {
  const el = $("status");
  el.textContent = message;
  el.dataset.kind = kind;
}

function setBusy(busy: boolean): void {
  const btn = $("download-btn") as HTMLButtonElement;
  btn.disabled = busy;
  btn.textContent = busy ? t("processing") : t("download");
}

/** 主流程：CSV →（可选）图片 → vault → zip → 下载。任何抛错都友好提示。 */
async function run(): Promise<void> {
  const file = ($("csv-file") as HTMLInputElement).files?.[0];
  if (!file) {
    setStatus(t("selectCsvWarn"), "warn");
    return;
  }
  const withImages = ($("with-images") as HTMLInputElement).checked;
  const hostId = getHostId();
  const host = resolveHost(hostId);

  setBusy(true);
  try {
    const csv = parseDidaCsv(await file.text());
    setStatus(
      t("parsed", {
        tasks: csv.summary.importedTasks,
        lists: csv.lists.length,
      }),
    );

    const attachmentsByTask = new Map<string, ResolvedAttachment[]>();
    const gaps: ManifestGap[] = [];

    if (withImages) {
      setStatus(t("fetching"));
      const result = await enrichWithImages(csv, createBrowserEngine(host), {
        onProgress: (m) => setStatus(m),
      });
      for (const [id, atts] of result.attachmentsByTask) {
        attachmentsByTask.set(id, atts);
      }
      gaps.push(...result.gaps);
    } else {
      gaps.push({
        code: "images_disabled",
        message: "未启用图片 / images not enabled",
      });
    }

    const plan = buildVault({
      csv,
      host,
      csvPath: file.name,
      withImages,
      toolVersion: TOOL_VERSION,
      attachmentsByTask,
      gaps,
    });

    const blob = await zipVaultPlan(plan);
    const base = file.name.replace(/\.csv$/i, "");
    triggerDownload(blob, `${base}.vault.zip`);

    const gapCount = plan.manifest.gaps.length;
    const gapClause = gapCount > 0 ? t("doneGap", { gaps: gapCount }) : "";
    setStatus(t("done", { tasks: plan.manifest.counts.tasks, gapClause }), "ok");
  } catch (error) {
    setStatus(
      t("error", {
        msg: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  } finally {
    setBusy(false);
  }
}

function init(): void {
  // 初始语言按默认选中站点。
  applyLang(langForHost(getHostId()));

  // 站点切换 → 整体语言切换（tab 位置保持不变）。
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="host"]',
  )) {
    input.addEventListener("change", () => applyLang(langForHost(getHostId())));
  }

  // 文件选中 → 绿字显示文件名；未选不显示任何占位。
  $("csv-file").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const picked = $("csv-picked");
    if (input.files?.[0]) {
      picked.textContent = `✓ ${input.files[0].name}`;
      picked.dataset.on = "true";
    } else {
      picked.textContent = "";
      delete picked.dataset.on;
    }
  });

  $("download-btn").addEventListener("click", run);
}

init();
