/**
 * 平台无关的图片编排：把「按清单匹配项目 → 按 ±168h 已完成窗口按标题找回任务
 * → 下载附件」这段逻辑抽出来，由调用方注入引擎操作（EngineApi）。
 *
 * Node（export.ts，注入 Chrome-cookie + Node fetch 引擎）和浏览器扩展
 *（extension/src/main.ts，注入 chrome.cookies + 浏览器 fetch 引擎）共用这一份。
 * 这里没有任何 Node 或 DOM 依赖。
 *
 * 分两阶段：先定位所有待下载附件（确定总数），再下载字节，进度才能显示 N/总数。
 */

import type { CsvParseResult, CsvTask } from "./csv.js";
import type {
  EngineAttachment,
  EngineSnapshot,
  RawRecord,
} from "./image-api.js";
import type { ManifestGap } from "./manifest.js";
import type { ResolvedAttachment } from "./vault.js";

/** 引擎操作接口：Node 与浏览器各自实现，编排逻辑通过它调用。 */
export interface EngineApi {
  loadSnapshot(): Promise<EngineSnapshot>;
  fetchCompletedTasksInWindow(
    snapshot: EngineSnapshot,
    projectId: string,
    centerIso: string,
    options?: { windowHours?: number; global?: boolean },
  ): Promise<RawRecord[]>;
  attachmentsFromTaskRecord(
    snapshot: EngineSnapshot,
    task: RawRecord,
  ): EngineAttachment[];
  downloadAttachmentBytes(
    snapshot: EngineSnapshot,
    attachment: EngineAttachment,
  ): Promise<Uint8Array>;
}

export interface EnrichOptions {
  onProgress?: (message: string) => void;
}

export interface EnrichResult {
  attachmentsByTask: Map<string, ResolvedAttachment[]>;
  gaps: ManifestGap[];
}

interface PendingDownload {
  /** CSV task id，用于 gap 关联 manifest task。 */
  taskId: string;
  /** 后端真实 task id，用于 ResolvedAttachment.taskId + attachmentsByTask key。 */
  sourceTaskId: string;
  meta: EngineAttachment;
}

/**
 * 取图主循环。引擎任何一步抛错都回退为无图（记录 gap），不让单个失败打断整盘导出。
 */
export async function enrichWithImages(
  csv: CsvParseResult,
  engine: EngineApi,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const log = options.onProgress ?? (() => {});
  const attachmentsByTask = new Map<string, ResolvedAttachment[]>();
  const gaps: ManifestGap[] = [];

  log("正在连接账号、枚举项目…");
  let snapshot: EngineSnapshot;
  try {
    snapshot = await engine.loadSnapshot();
  } catch (error) {
    gaps.push({
      code: "image_engine_failed",
      message: `图片引擎失败，已回退为无图导出：${error instanceof Error ? error.message : String(error)}`,
    });
    log(
      `图片引擎失败，回退为无图导出。原因：${error instanceof Error ? error.message : String(error)}`,
    );
    return { attachmentsByTask, gaps };
  }

  log(`已连接，发现 ${snapshot.projects.length} 个项目，开始定位附件…`);

  // 账号匹配预检：CSV 清单名 vs 当前账号项目名。重合度低多半是登错账号 / profile。
  const csvListTitles = new Set(
    csv.lists.map((l) => l.title.trim()).filter(Boolean),
  );
  if (csvListTitles.size > 0 && snapshot.projects.length > 0) {
    const projectNames = new Set(snapshot.projects.map((p) => p.name.trim()));
    let matched = 0;
    for (const t of csvListTitles) if (projectNames.has(t)) matched += 1;
    const overlap = matched / csvListTitles.size;
    if (overlap < 0.5) {
      const warn =
        `⚠️ 账号匹配预警：CSV 有 ${csvListTitles.size} 个清单，当前登录账号只对得上 ${matched} 个（${Math.round(overlap * 100)}%）。` +
        `可能登错账号或选错 Chrome——继续多半取不到图。`;
      gaps.push({ code: "account_mismatch", message: warn });
      log(warn);
    }
  }

  // CSV's `taskId` is an export-local index, not the backend id, so we can't
  // fetch tasks by it. Instead: resolve each image task's projectId from its
  // list name, then within each project match by TITLE against the project's
  // open + completed task records (which already carry their attachments).
  const projectIdByName = new Map<string, string>();
  for (const project of snapshot.projects) {
    projectIdByName.set(project.name.trim(), project.id);
  }
  const listTitleById = new Map(csv.lists.map((l) => [l.id, l.title]));
  const normTitle = (t: unknown) => String(t ?? "").trim();

  // Group image-bearing CSV tasks by resolved projectId.
  const imageTasksByProject = new Map<string, CsvTask[]>();
  for (const task of csv.tasks) {
    if (!task.sourceTaskId) continue;
    if (task.attachmentRefs.length === 0) continue;
    const listTitle = task.listId ? listTitleById.get(task.listId) : null;
    const projectId =
      snapshot.projectIdByTaskId.get(task.sourceTaskId) ??
      (listTitle ? projectIdByName.get(listTitle.trim()) : undefined);
    if (!projectId) {
      gaps.push({
        code: "task_attachment_unreachable",
        message: `无法把任务「${task.title}」的清单「${listTitle ?? "?"}」对应到账号里的项目，未取图。`,
        taskId: task.id,
      });
      continue;
    }
    const list = imageTasksByProject.get(projectId);
    if (list) list.push(task);
    else imageTasksByProject.set(projectId, [task]);
  }

  // 阶段 1：定位每个任务的附件元数据（不下载字节），收集成待下载列表。
  // 这一步要确定总数，下载阶段才能显示 N/总数。
  const pending: PendingDownload[] = [];
  for (const [projectId, tasks] of imageTasksByProject) {
    // Title -> task record index for this project. Seed with open tasks; then
    // lazily pull ±168h completed windows around each task's completion time
    // (cached per day), with a cross-project global-completed fallback.
    const recordByTitle = new Map<string, RawRecord>();
    const addRecord = (rec: RawRecord) => {
      const key = normTitle(rec.title);
      if (key && !recordByTitle.has(key)) recordByTitle.set(key, rec);
    };
    for (const rec of snapshot.openTasksByProject.get(projectId) ?? []) {
      addRecord(rec);
    }
    const fetchedWindows = new Set<string>();

    for (const task of tasks) {
      const sourceTaskId = task.sourceTaskId;
      if (!sourceTaskId) continue;
      const titleKey = normTitle(task.title);

      if (!recordByTitle.has(titleKey)) {
        const center =
          task.completedTime ?? task.dueDate ?? task.startDate ?? null;
        if (center) {
          const day = center.slice(0, 10);
          const projKey = `p:${day}`;
          if (!fetchedWindows.has(projKey)) {
            fetchedWindows.add(projKey);
            const win = await engine.fetchCompletedTasksInWindow(
              snapshot,
              projectId,
              center,
            );
            for (const rec of win) addRecord(rec);
          }
          if (!recordByTitle.has(titleKey)) {
            const globalKey = `g:${day}`;
            if (!fetchedWindows.has(globalKey)) {
              fetchedWindows.add(globalKey);
              const gwin = await engine.fetchCompletedTasksInWindow(
                snapshot,
                projectId,
                center,
                { global: true },
              );
              for (const rec of gwin) addRecord(rec);
            }
          }
        }
      }

      const rec = recordByTitle.get(titleKey);
      const metas = rec ? engine.attachmentsFromTaskRecord(snapshot, rec) : [];
      if (metas.length === 0) {
        gaps.push({
          code: "task_attachment_unreachable",
          message: rec
            ? `任务「${task.title}」在账号里没有可下载的附件（可能图片已删除）。`
            : `在项目里按标题没找到任务「${task.title}」，未取图。`,
          taskId: task.id,
        });
        continue;
      }
      for (const meta of metas) {
        pending.push({ taskId: task.id, sourceTaskId, meta });
      }
    }
  }

  // 阶段 2：下载字节。进度显示「已下载附件:N/总数」。
  const total = pending.length;
  if (total > 0) {
    log(`定位到 ${total} 个附件，开始下载…`);
  } else {
    log("没有可下载的附件。");
  }
  let downloaded = 0;
  for (const { taskId, sourceTaskId, meta } of pending) {
    try {
      const bytes = await engine.downloadAttachmentBytes(snapshot, meta);
      const list = attachmentsByTask.get(sourceTaskId) ?? [];
      list.push({
        id: meta.id,
        taskId: sourceTaskId,
        name: meta.name,
        type: meta.type,
        ...(meta.size != null ? { size: meta.size } : {}),
        bytes,
      });
      attachmentsByTask.set(sourceTaskId, list);
      downloaded += 1;
      log(`已下载附件:${downloaded}/${total}`);
    } catch (error) {
      gaps.push({
        code: "attachment_download_failed",
        message: `附件下载失败：${meta.name}（${error instanceof Error ? error.message : String(error)}）`,
        taskId,
        attachmentId: meta.id,
      });
      const list = attachmentsByTask.get(sourceTaskId) ?? [];
      list.push({
        id: meta.id,
        taskId: sourceTaskId,
        name: meta.name,
        type: meta.type,
        ...(meta.size != null ? { size: meta.size } : {}),
        bytes: null,
      });
      attachmentsByTask.set(sourceTaskId, list);
    }
  }

  if (total > 0) {
    log(`下载完成：${downloaded}/${total} 个附件`);
  }
  return { attachmentsByTask, gaps };
}
