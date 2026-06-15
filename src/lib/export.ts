/**
 * Export orchestrator: CSV -> (optional) image engine -> vault plan.
 *
 * Kept fs-free except for reading the CSV; writing is done by the caller via
 * writeVault. This makes the whole pipeline (including the --with-images branch,
 * with an injected fetch + cookie loader) unit-testable.
 */

import { readFile } from "node:fs/promises";
import { platform } from "node:os";

import { parseDidaCsv, type CsvParseResult } from "./csv.js";
import type { HostConfig } from "./host.js";
import {
  downloadAttachmentBytes,
  fetchTaskAttachments,
  loadEngineSnapshot,
  ImageEngineError,
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
    await enrichWithImages(options, csv, attachmentsByTask, gaps, log);
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

async function enrichWithImages(
  options: ExportOptions,
  csv: CsvParseResult,
  attachmentsByTask: Map<string, ResolvedAttachment[]>,
  gaps: ManifestGap[],
  log: (m: string) => void,
): Promise<void> {
  const currentPlatform = options.platformId ?? platform();

  if (currentPlatform !== "darwin") {
    gaps.push({
      code: "images_skipped_not_macos",
      message:
        "已请求 --with-images，但当前不是 macOS。图片引擎依赖 macOS Keychain + Chrome，跳过取图。",
    });
    log("当前不是 macOS，跳过图片引擎（仅产出无图结果）。");
    return;
  }

  if (!options.host.imagesVerified) {
    gaps.push({
      code: "images_skipped_overseas_unverified",
      message:
        `--host ${options.host.id} 的图片直连路径未经验证（实验性，海外接口/cookie 域可能不同），可能无法取到任何图片。`,
    });
    log(`警告：--host ${options.host.id} 取图为实验性，未验证。`);
  }

  log("正在从 Chrome 读取登录 cookie 并枚举项目…（可能弹出 Keychain 授权框）");

  try {
    const snapshot = await loadEngineSnapshot({
      host: options.host,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.loadCookies ? { loadCookies: options.loadCookies } : {}),
    });

    log(`已连接，发现 ${snapshot.projects.length} 个项目，开始逐任务取图…`);

    let downloaded = 0;
    for (const task of csv.tasks) {
      if (!task.sourceTaskId) continue;
      // Only spend network on tasks whose note actually references an image.
      if (task.attachmentRefs.length === 0) continue;

      const metas = await fetchTaskAttachments(snapshot, task.sourceTaskId);
      if (metas.length === 0) {
        gaps.push({
          code: "task_attachment_unreachable",
          message:
            "任务在内部接口中不可达（常见原因：已完成任务超出时间窗 limit=100，或不在初始同步批次中），未能取到其附件。",
          taskId: task.id,
        });
        continue;
      }

      const resolved: ResolvedAttachment[] = [];
      for (const meta of metas) {
        try {
          const bytes = await downloadAttachmentBytes(snapshot, meta);
          resolved.push({
            id: meta.id,
            taskId: task.sourceTaskId,
            name: meta.name,
            type: meta.type,
            ...(meta.size != null ? { size: meta.size } : {}),
            bytes,
          });
          downloaded += 1;
        } catch (error) {
          gaps.push({
            code: "attachment_download_failed",
            message: `附件下载失败：${meta.name}（${error instanceof Error ? error.message : String(error)}）`,
            taskId: task.id,
            attachmentId: meta.id,
          });
          resolved.push({
            id: meta.id,
            taskId: task.sourceTaskId,
            name: meta.name,
            type: meta.type,
            ...(meta.size != null ? { size: meta.size } : {}),
            bytes: null,
          });
        }
      }
      if (resolved.length > 0) {
        attachmentsByTask.set(task.sourceTaskId, resolved);
      }
    }

    log(`图片引擎完成：成功下载 ${downloaded} 个附件。`);
  } catch (error) {
    if (error instanceof ImageEngineError) {
      gaps.push({
        code: "image_engine_failed",
        message: `图片引擎失败，已回退为无图导出：${error.message}`,
      });
      log(`图片引擎失败，回退为无图导出。原因：${error.message}`);
      return;
    }
    throw error;
  }
}
