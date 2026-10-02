/** Shared attachment orchestration for native desktop and development utilities. */
import type { CsvParseResult, CsvTask } from "./csv.js";
import type {
  EngineAttachment,
  EngineSnapshot,
  RawRecord,
} from "./image-api.js";
import type { ManifestGap } from "./manifest.js";
import type { ResolvedAttachment } from "./vault.js";
export interface EngineApi {
  loadSnapshot(): Promise<EngineSnapshot>;
  fetchProjectTasks?(
    snapshot: EngineSnapshot,
    projectId: string,
  ): Promise<RawRecord[]>;
  fetchCompletedTasksInWindow(
    snapshot: EngineSnapshot,
    projectId: string,
    centerIso: string,
    options?: { windowHours?: number; global?: boolean; status?: "Abandoned" },
  ): Promise<RawRecord[]>;
  attachmentsFromTaskRecord(
    snapshot: EngineSnapshot,
    task: RawRecord,
  ): EngineAttachment[];
  downloadAttachmentBytes(
    snapshot: EngineSnapshot,
    attachment: EngineAttachment,
  ): Promise<Uint8Array>;
  /** Desktop streams to native temporary files rather than keeping bytes in JS. */
  downloadAttachmentFile?(
    snapshot: EngineSnapshot,
    attachment: EngineAttachment,
  ): Promise<{ handle: string; size: number; type: string }>;
}
export interface EnrichOptions {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  previous?: EnrichResult;
}
export interface EnrichResult {
  attachmentsByTask: Map<string, ResolvedAttachment[]>;
  apiTaskIds: Map<string, string>;
  gaps: ManifestGap[];
}
function instant(value: unknown): number | null {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
function choose(
  task: CsvTask,
  records: RawRecord[],
  engine: EngineApi,
  snapshot: EngineSnapshot,
): RawRecord[] {
  const real = records.filter((r) => r.id === task.sourceTaskId);
  if (real.length) return real;
  const refs = task.attachmentRefs;
  if (refs.length) {
    const hits = records.filter((r) =>
      engine
        .attachmentsFromTaskRecord(snapshot, r)
        .some((a) => refs.some((ref) => ref.split(/[/?#]/).includes(a.id))),
    );
    if (hits.length) return hits;
  }
  let hits = records.filter(
    (r) => String(r.title ?? "").trim() === task.title.trim(),
  );
  for (const [csvTime, field] of [
    [task.createdTime, "createdTime"],
    [task.completedTime, "completedTime"],
  ] as const) {
    if (csvTime) {
      const time = instant(csvTime);
      hits = hits.filter(
        (r) => instant(r[field]) === null || instant(r[field]) === time,
      );
    }
  }
  return hits;
}
export async function enrichWithImages(
  csv: CsvParseResult,
  engine: EngineApi,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const log = options.onProgress ?? (() => {});
  const attachmentsByTask = new Map<string, ResolvedAttachment[]>(
    [...(options.previous?.attachmentsByTask ?? [])].map(([id, atts]) => [
      id,
      atts.filter((a) => a.bytes || a.diskHandle),
    ]),
  );
  const apiTaskIds = new Map<string, string>(options.previous?.apiTaskIds);
  const gaps: ManifestGap[] = [];
  const result = { attachmentsByTask, apiTaskIds, gaps };
  const canceled = () => {
    if (options.signal?.aborted) {
      if (!gaps.some((g) => g.code === "export_canceled"))
        gaps.push({
          code: "export_canceled",
          message: "已取消，附件扫描或下载未完成。",
        });
      return true;
    }
    return false;
  };
  log("正在连接账号、枚举项目…");
  let snapshot: EngineSnapshot;
  try {
    snapshot = await engine.loadSnapshot();
  } catch {
    gaps.push({
      code: "image_engine_failed",
      message: "无法连接附件接口。请检查登录状态并重试；附件覆盖尚未核实。",
    });
    return result;
  }
  const titles = new Map(csv.lists.map((l) => [l.id, l.title]));
  const pending: { task: CsvTask; meta: EngineAttachment }[] = [];
  const windows = new Map<string, Promise<RawRecord[]>>();
  const projectTasks = new Map<string, Promise<RawRecord[]>>();
  for (const task of csv.tasks) {
    if (canceled()) return result;
    const listName = task.listId ? titles.get(task.listId) : undefined;
    const inbox = !listName || /^(Inbox|收集箱)$/i.test(listName.trim());
    const projects = snapshot.projectIdByTaskId.has(task.sourceTaskId ?? "")
      ? [snapshot.projectIdByTaskId.get(task.sourceTaskId ?? "")!]
      : inbox && snapshot.inboxId
        ? [snapshot.inboxId]
        : snapshot.projects
            .filter((p) => p.name.trim() === listName?.trim())
            .map((p) => p.id);
    if (!projects.length) {
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: task.id,
        message: `无法对应任务「${task.title}」的清单，附件未核实。`,
      });
      continue;
    }
    const records = new Map<string, RawRecord>();
    for (const projectId of projects) {
      for (const r of snapshot.openTasksByProject.get(projectId) ?? [])
        if (
          typeof r.id === "string" &&
          task.status === "todo" &&
          Number(r.status ?? 0) === 0
        )
          records.set(r.id, r);
      // Always scan completed records for done/canceled tasks: an open same-name record is not evidence of identity.
      if (task.status !== "todo") {
        if (!task.completedTime) {
          gaps.push({
            code: "completed_scan_incomplete",
            taskId: task.id,
            message: `任务「${task.title}」缺少完成时间，无法证明历史附件覆盖。`,
          });
          continue;
        }
        const bucketWidth = 14 * 24 * 3600000;
        const bucket = Math.floor(Date.parse(task.completedTime) / bucketWidth);
        const center = new Date(
          bucket * bucketWidth + bucketWidth / 2,
        ).toISOString();
        const key = `${task.status === "canceled" ? "all" : projectId}:${task.status}:${bucket}`;
        if (!windows.has(key))
          windows.set(
            key,
            engine.fetchCompletedTasksInWindow(
              snapshot,
              projectId,
              center,
              task.status === "canceled"
                ? { status: "Abandoned", global: true }
                : {},
            ),
          );
        try {
          for (const r of await windows.get(key)!) {
            if (r.projectId === projectId && typeof r.id === "string")
              records.set(r.id, r);
          }
        } catch {
          gaps.push({
            code: "completed_scan_incomplete",
            taskId: task.id,
            message: `任务「${task.title}」的历史窗口扫描失败或未取全，请重试。`,
          });
        }
      }
    }
    let candidates = choose(task, [...records.values()], engine, snapshot);
    if (
      task.status === "todo" &&
      candidates.length === 0 &&
      engine.fetchProjectTasks
    ) {
      for (const projectId of projects) {
        if (!projectTasks.has(projectId))
          projectTasks.set(
            projectId,
            engine.fetchProjectTasks(snapshot, projectId),
          );
        try {
          for (const r of await projectTasks.get(projectId)!) {
            if (
              r.projectId === projectId &&
              typeof r.id === "string" &&
              Number(r.status ?? 0) === 0
            )
              records.set(r.id, r);
          }
        } catch {
          gaps.push({
            code: "task_attachment_unreachable",
            taskId: task.id,
            message: `任务「${task.title}」所在清单扫描失败，附件未核实。`,
          });
        }
      }
      candidates = choose(task, [...records.values()], engine, snapshot);
    }
    if (candidates.length !== 1) {
      gaps.push({
        code: candidates.length
          ? "task_match_ambiguous"
          : "task_attachment_unreachable",
        taskId: task.id,
        message: candidates.length
          ? `任务「${task.title}」有多个候选，未猜测附件归属。`
          : `未找到任务「${task.title}」，附件未核实。`,
      });
      continue;
    }
    const record = candidates[0]!;
    apiTaskIds.set(task.id, String(record.id));
    const metas = engine.attachmentsFromTaskRecord(snapshot, record);
    if (
      record.attachments != null &&
      (!Array.isArray(record.attachments) ||
        metas.length < record.attachments.length)
    )
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: task.id,
        message: `任务「${task.title}」的附件元数据不完整，无法证明全部附件覆盖。`,
      });
    if (!metas.length && task.attachmentRefs.length)
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: task.id,
        message: `任务「${task.title}」正文引用附件，但接口没有附件信息。`,
      });
    for (const meta of metas) pending.push({ task, meta });
    log(`扫描任务:${apiTaskIds.size}/${csv.tasks.length}`);
  }
  let downloaded = 0;
  for (const { task, meta } of pending) {
    if (canceled()) return result;
    const key = task.sourceTaskId ?? task.id;
    const list = (attachmentsByTask.get(key) ?? []).filter(
      (a) => a.id !== meta.id,
    );
    const previous = options.previous?.attachmentsByTask
      .get(key)
      ?.find((a) => a.id === meta.id && (a.bytes || a.diskHandle));
    if (previous) {
      list.push(previous);
      attachmentsByTask.set(key, list);
      downloaded++;
      continue;
    }
    const att: ResolvedAttachment = {
      id: meta.id,
      taskId: key,
      name: meta.name,
      type: meta.type,
      size: meta.size,
      bytes: null,
    };
    try {
      if (engine.downloadAttachmentFile) {
        const file = await engine.downloadAttachmentFile(snapshot, meta);
        if (file.size === 0) throw Error("empty");
        att.diskHandle = file.handle;
        att.size = file.size;
        att.type = file.type;
      } else {
        const bytes = await engine.downloadAttachmentBytes(snapshot, meta);
        if (!bytes.length) throw Error("empty");
        att.bytes = bytes;
        att.size = bytes.length;
      }
      if (meta.size != null && att.size !== meta.size)
        throw Error("size mismatch");
      downloaded++;
    } catch {
      att.bytes = null;
      delete att.diskHandle;
      gaps.push({
        code: "attachment_download_failed",
        taskId: task.id,
        attachmentId: meta.id,
        message: `附件「${meta.name}」下载失败或长度不符，可重试。`,
      });
    }
    list.push(att);
    attachmentsByTask.set(key, list);
    log(`已下载附件:${downloaded}/${pending.length}`);
  }
  return result;
}
