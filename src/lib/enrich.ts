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
  /** Complete metadata already fetched in batches; never downloads attachment bytes. */
  loadHistory?(
    snapshot: EngineSnapshot,
    tasks: readonly CsvTask[],
  ): Promise<{ records: RawRecord[]; gaps: ManifestGap[] }>;
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
  selectedAttachmentKeys?: ReadonlySet<string>;
}
export interface EnrichResult {
  attachmentsByTask: Map<string, ResolvedAttachment[]>;
  apiTaskIds: Map<string, string>;
  gaps: ManifestGap[];
}
export interface AttachmentCandidate {
  key: string;
  task: CsvTask;
  meta: EngineAttachment;
}
export interface AttachmentScan {
  snapshot?: EngineSnapshot;
  entries: AttachmentCandidate[];
  apiTaskIds: Map<string, string>;
  gaps: ManifestGap[];
}
export function attachmentKey(task: CsvTask, meta: EngineAttachment): string {
  return JSON.stringify([task.id, meta.projectId, meta.taskId, meta.id]);
}
function instant(value: unknown): number | null {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
interface TitleRecords {
  records: RawRecord[];
  created: Map<number | null, RawRecord[]>;
  completed: Map<number | null, RawRecord[]>;
  both: Map<string, RawRecord[]>;
}
class RecordIndex {
  private ids = new Map<string, RawRecord>();
  private titles = new Map<string, TitleRecords>();
  private attachments = new Map<string, RawRecord[]>();
  constructor(
    records: RawRecord[],
    engine: EngineApi,
    snapshot: EngineSnapshot,
  ) {
    for (const record of records)
      if (typeof record.id === "string") this.ids.set(record.id, record);
    for (const record of this.ids.values()) {
      const title = String(record.title ?? "").trim();
      let bucket = this.titles.get(title);
      if (!bucket) {
        bucket = {
          records: [],
          created: new Map(),
          completed: new Map(),
          both: new Map(),
        };
        this.titles.set(title, bucket);
      }
      bucket.records.push(record);
      for (const [map, field] of [
        [bucket.created, "createdTime"],
        [bucket.completed, "completedTime"],
      ] as const) {
        const time = instant(record[field]),
          rows = map.get(time) ?? [];
        rows.push(record);
        map.set(time, rows);
      }
      const key = `${instant(record.createdTime)}/${instant(record.completedTime)}`;
      const sameTimes = bucket.both.get(key) ?? [];
      sameTimes.push(record);
      bucket.both.set(key, sameTimes);
      for (const attachment of engine.attachmentsFromTaskRecord(
        snapshot,
        record,
      )) {
        const rows = this.attachments.get(attachment.id) ?? [];
        rows.push(record);
        this.attachments.set(attachment.id, rows);
      }
    }
  }
  id(id: string | null) {
    return id ? this.ids.get(id) : undefined;
  }
  refs(refs: string[]) {
    return refs.flatMap((ref) =>
      ref.split(/[/?#]/).flatMap((id) => this.attachments.get(id) ?? []),
    );
  }
  title(task: CsvTask) {
    const bucket = this.titles.get(task.title.trim());
    if (!bucket) return [];
    const created = instant(task.createdTime),
      completed = instant(task.completedTime);
    // Two distinct candidates already prove ambiguity. Avoid quadratic same-title scans.
    if (created !== null && completed !== null)
      return [
        `${created}/${completed}`,
        `null/${completed}`,
        `${created}/null`,
        "null/null",
      ]
        .flatMap((key) => (bucket.both.get(key) ?? []).slice(0, 2))
        .slice(0, 2);
    if (created !== null)
      return [
        ...(bucket.created.get(created) ?? []).slice(0, 2),
        ...(bucket.created.get(null) ?? []).slice(0, 2),
      ].slice(0, 2);
    if (completed !== null)
      return [
        ...(bucket.completed.get(completed) ?? []).slice(0, 2),
        ...(bucket.completed.get(null) ?? []).slice(0, 2),
      ].slice(0, 2);
    return bucket.records.slice(0, 2);
  }
}
function choose(task: CsvTask, indexes: RecordIndex[]): RawRecord[] {
  const unique = (rows: RawRecord[]) => [
    ...new Map(rows.map((r) => [r.id, r])).values(),
  ];
  const exact = indexes.flatMap((i) => {
    const row = i.id(task.sourceTaskId);
    return row ? [row] : [];
  });
  if (exact.length) return unique(exact);
  const refs = indexes.flatMap((i) => i.refs(task.attachmentRefs));
  if (refs.length) return unique(refs);
  return unique(indexes.flatMap((i) => i.title(task)));
}
export async function scanAttachments(
  csv: CsvParseResult,
  engine: EngineApi,
  options: EnrichOptions = {},
): Promise<AttachmentScan> {
  const log = options.onProgress ?? (() => {});
  const apiTaskIds = new Map<string, string>(options.previous?.apiTaskIds);
  const gaps: ManifestGap[] = [],
    pending: AttachmentCandidate[] = [];
  const result: AttachmentScan = { entries: pending, apiTaskIds, gaps };
  const canceled = () => {
    if (!options.signal?.aborted) return false;
    if (!gaps.some((g) => g.code === "export_canceled"))
      gaps.push({
        code: "export_canceled",
        message: "附件扫描已取消，覆盖尚未核实。",
      });
    return true;
  };
  if (canceled()) return result;
  log("正在连接账号、枚举清单…");
  let snapshot: EngineSnapshot;
  try {
    snapshot = await engine.loadSnapshot();
  } catch {
    gaps.push({
      code: "image_engine_failed",
      message: "无法连接附件接口，请检查登录状态；附件覆盖尚未核实。",
    });
    return result;
  }
  result.snapshot = snapshot;
  const group = (rows: RawRecord[]) => {
    const grouped = new Map<string, RawRecord[]>();
    for (const row of rows)
      if (typeof row.projectId === "string") {
        const list = grouped.get(row.projectId) ?? [];
        list.push(row);
        grouped.set(row.projectId, list);
      }
    return new Map(
      [...grouped].map(([id, rows]) => [
        id,
        new RecordIndex(rows, engine, snapshot),
      ]),
    );
  };
  const open = group(
    [...snapshot.openTasksByProject.values()]
      .flat()
      .filter((r) => Number(r.status ?? 0) === 0),
  );
  const history = new Map<string, Map<string, RecordIndex>>();
  const historyProjects = new Map<string, string>();
  if (engine.loadHistory && csv.tasks.some((t) => t.status !== "todo")) {
    try {
      const loaded = await engine.loadHistory(snapshot, csv.tasks);
      gaps.push(...loaded.gaps);
      for (const row of loaded.records)
        if (typeof row.id === "string" && typeof row.projectId === "string")
          historyProjects.set(row.id, row.projectId);
      history.set(
        "done",
        group(loaded.records.filter((r) => Number(r.status) === 2)),
      );
      history.set(
        "canceled",
        group(loaded.records.filter((r) => Number(r.status) === -1)),
      );
    } catch (error) {
      if (canceled()) return result;
      gaps.push({
        code: "completed_scan_incomplete",
        message: `历史附件信息未完整读取：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const titles = new Map(csv.lists.map((l) => [l.id, l.title]));
  const projectsByName = new Map<string, string[]>();
  for (const project of snapshot.projects) {
    const name = project.name.trim(),
      ids = projectsByName.get(name) ?? [];
    ids.push(project.id);
    projectsByName.set(name, ids);
  }
  const windows = new Map<string, Promise<Map<string, RecordIndex>>>();
  const projectTasks = new Map<string, Promise<Map<string, RecordIndex>>>();
  for (let taskIndex = 0; taskIndex < csv.tasks.length; taskIndex++) {
    // Yield periodically so cancellation, progress rendering and the time budget can run.
    if (taskIndex && taskIndex % 250 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
    if (canceled()) return result;
    const task = csv.tasks[taskIndex]!;
    const listName = task.listId ? titles.get(task.listId) : undefined;
    const knownProject =
      snapshot.projectIdByTaskId.get(task.sourceTaskId ?? "") ??
      historyProjects.get(task.sourceTaskId ?? "");
    const projects = knownProject
      ? [knownProject]
      : (!listName || /^(Inbox|收集箱)$/i.test(listName.trim())) &&
          snapshot.inboxId
        ? [snapshot.inboxId]
        : (projectsByName.get(listName?.trim() ?? "") ?? []);
    if (!projects.length) {
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: task.id,
        message: `无法对应任务「${task.title}」的清单，附件未核实。`,
      });
      continue;
    }
    const indexes: RecordIndex[] = [];
    for (const projectId of projects) {
      if (task.status === "todo") {
        const index = open.get(projectId);
        if (index) indexes.push(index);
      } else if (engine.loadHistory) {
        const index = history.get(task.status)?.get(projectId);
        if (index) indexes.push(index);
      } else {
        if (
          !task.completedTime ||
          !Number.isFinite(Date.parse(task.completedTime))
        ) {
          gaps.push({
            code: "completed_scan_incomplete",
            taskId: task.id,
            message: `任务「${task.title}」缺少完成时间，历史附件未核实。`,
          });
          continue;
        }
        const width = 14 * 86400000,
          bucket = Math.floor(Date.parse(task.completedTime) / width);
        const key = `${task.status === "canceled" ? "all" : projectId}:${task.status}:${bucket}`;
        if (!windows.has(key))
          windows.set(
            key,
            engine
              .fetchCompletedTasksInWindow(
                snapshot,
                projectId,
                new Date(bucket * width + width / 2).toISOString(),
                task.status === "canceled"
                  ? { status: "Abandoned", global: true }
                  : {},
              )
              .then(group),
          );
        try {
          const index = (await windows.get(key)!).get(projectId);
          if (index) indexes.push(index);
        } catch {
          gaps.push({
            code: "completed_scan_incomplete",
            taskId: task.id,
            message: `任务「${task.title}」历史查询未完整完成。`,
          });
        }
      }
    }
    let candidates = choose(task, indexes);
    if (
      task.status === "todo" &&
      !candidates.length &&
      engine.fetchProjectTasks
    ) {
      const fallback: RecordIndex[] = [];
      for (const projectId of projects) {
        if (!projectTasks.has(projectId))
          projectTasks.set(
            projectId,
            engine
              .fetchProjectTasks(snapshot, projectId)
              .then((rows) =>
                group(rows.filter((r) => Number(r.status ?? 0) === 0)),
              ),
          );
        try {
          const index = (await projectTasks.get(projectId)!).get(projectId);
          if (index) fallback.push(index);
        } catch {
          gaps.push({
            code: "task_attachment_unreachable",
            taskId: task.id,
            message: `任务「${task.title}」所在清单读取失败，附件未核实。`,
          });
        }
      }
      candidates = choose(task, [...indexes, ...fallback]);
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
        message: `任务「${task.title}」的附件信息不完整。`,
      });
    if (!metas.length && task.attachmentRefs.length)
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: task.id,
        message: `任务「${task.title}」正文引用附件，但接口没有附件信息。`,
      });
    for (const meta of metas)
      pending.push({ task, meta, key: attachmentKey(task, meta) });
    if (taskIndex % 100 === 0 || taskIndex === csv.tasks.length - 1)
      log(`扫描任务:${apiTaskIds.size}/${csv.tasks.length}`);
  }
  return result;
}

export async function downloadScannedAttachments(
  scan: AttachmentScan,
  engine: EngineApi,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const log = options.onProgress ?? (() => {});
  const attachmentsByTask = new Map<string, ResolvedAttachment[]>();
  if (!options.selectedAttachmentKeys) {
    for (const [id, atts] of options.previous?.attachmentsByTask ?? [])
      attachmentsByTask.set(
        id,
        atts.filter((a) => a.bytes || a.diskHandle),
      );
  }
  const gaps = [...scan.gaps];
  const result = { attachmentsByTask, apiTaskIds: scan.apiTaskIds, gaps };
  const canceled = () => {
    if (!options.signal?.aborted) return false;
    if (!gaps.some((g) => g.code === "export_canceled"))
      gaps.push({
        code: "export_canceled",
        message: "已取消，附件下载未完成。",
      });
    return true;
  };
  if (canceled() || !scan.snapshot) return result;
  const snapshot = scan.snapshot;
  const pending = scan.entries;
  const selectedCount = pending.filter(
    (a) =>
      !options.selectedAttachmentKeys ||
      options.selectedAttachmentKeys.has(a.key),
  ).length;
  let downloaded = 0;
  for (const { task, meta, key: selectionKey } of pending) {
    if (canceled()) return result;
    const key = task.sourceTaskId ?? task.id;
    const list = (attachmentsByTask.get(key) ?? []).filter(
      (a) => a.id !== meta.id,
    );
    if (
      options.selectedAttachmentKeys &&
      !options.selectedAttachmentKeys.has(selectionKey)
    ) {
      list.push({
        id: meta.id,
        taskId: key,
        name: meta.name,
        type: meta.type,
        size: meta.size,
        bytes: null,
        skippedByUser: true,
      });
      attachmentsByTask.set(key, list);
      continue;
    }
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
    log(`正在下载：${meta.name}`);
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
    log(`已下载附件:${downloaded}/${selectedCount}`);
  }
  return result;
}

/** Existing CLI callers retain the full scan-and-download behavior. */
export async function enrichWithImages(
  csv: CsvParseResult,
  engine: EngineApi,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const scan = await scanAttachments(csv, engine, options);
  return downloadScannedAttachments(scan, engine, options);
}
