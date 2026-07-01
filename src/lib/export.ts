/**
 * Export orchestrator: CSV -> (optional) image engine -> vault plan.
 *
 * Kept fs-free except for reading the CSV; writing is done by the caller via
 * writeVault. Image enrichment is delegated to the platform-agnostic
 * `enrichWithImages` (enrich.ts); this file only supplies the Node-side engine
 * (Chrome cookie decrypt + Node fetch) when running under macOS.
 */

import { readFile } from "node:fs/promises";
import { platform } from "node:os";

import { parseDidaCsv, type CsvParseResult } from "./csv.js";
import { enrichWithImages, type EngineApi } from "./enrich.js";
import type { HostConfig } from "./host.js";
import {
  attachmentsFromTaskRecord,
  downloadAttachmentBytes,
  fetchCompletedTasksInWindow,
  loadEngineSnapshot,
  type CookieMap,
} from "./image-engine.js";
import type { ManifestGap } from "./manifest.js";
import { buildVault, type ResolvedAttachment, type VaultPlan } from "./vault.js";

export interface ExportOptions {
  csvPath: string;
  host: HostConfig;
  withImages: boolean;
  toolVersion: string;
  /** Progress callback (optional). */
  onProgress?: (message: string) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  loadCookies?: (host: HostConfig) => Promise<CookieMap>;
  platformId?: string;
  now?: Date;
}

export interface ExportResult {
  plan: VaultPlan;
  csv: CsvParseResult;
  /** Downloaded attachments grouped by CsvTask.sourceTaskId (for the SDX bundle). */
  attachmentsByTask: Map<string, ResolvedAttachment[]>;
}

export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const log = options.onProgress ?? (() => {});
  const csvText = await readCsv(options.csvPath);
  const csv = parseDidaCsv(csvText);
  log(
    `CSV 解析完成：${csv.summary.importedTasks} 个任务 / ${csv.lists.length} 个清单。`,
  );

  const attachmentsByTask = new Map<string, ResolvedAttachment[]>();
  const gaps: ManifestGap[] = [];

  if (!options.withImages) {
    gaps.push({
      code: "images_disabled",
      message:
        "默认档：未启用 --with-images，本次导出不含任何附件图片（跨平台、仅基于官方 CSV）。",
    });
  } else {
    const currentPlatform = options.platformId ?? platform();

    if (currentPlatform !== "darwin") {
      gaps.push({
        code: "images_skipped_not_macos",
        message:
          "已请求 --with-images，但当前不是 macOS。图片引擎依赖 macOS Keychain + Chrome，跳过取图。",
      });
      log("当前不是 macOS，跳过图片引擎（仅产出无图结果）。");
    } else {
      if (!options.host.imagesVerified) {
        gaps.push({
          code: "images_skipped_overseas_unverified",
          message:
            `--host ${options.host.id} 的图片直连路径未经验证（实验性，海外接口/cookie 域可能不同），可能无法取到任何图片。`,
        });
        log(`警告：--host ${options.host.id} 取图为实验性，未验证。`);
      }

      log("正在从 Chrome 读取登录 cookie 并枚举项目…（可能弹出 Keychain 授权框）");

      // Node-side engine: Chrome-cookie snapshot + Node fetch. The cross-
      // platform orchestration lives in enrichWithImages.
      const engine: EngineApi = {
        loadSnapshot: () =>
          loadEngineSnapshot({
            host: options.host,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.loadCookies
              ? { loadCookies: options.loadCookies }
              : {}),
          }),
        fetchCompletedTasksInWindow,
        attachmentsFromTaskRecord,
        downloadAttachmentBytes,
      };

      const result = await enrichWithImages(csv, engine, { onProgress: log });
      for (const [taskId, atts] of result.attachmentsByTask) {
        attachmentsByTask.set(taskId, atts);
      }
      gaps.push(...result.gaps);
    }
  }

  const plan = buildVault({
    csv,
    host: options.host,
    csvPath: options.csvPath,
    withImages: options.withImages,
    toolVersion: options.toolVersion,
    attachmentsByTask,
    gaps,
    ...(options.now ? { now: options.now } : {}),
  });

  return { plan, csv, attachmentsByTask };
}

async function readCsv(csvPath: string): Promise<string> {
  try {
    return await readFile(csvPath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取 CSV 文件：${csvPath}\n` +
        `Could not read CSV file at ${csvPath}. ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
