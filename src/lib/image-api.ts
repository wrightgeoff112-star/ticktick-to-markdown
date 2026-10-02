/**
 * 平台无关的图片接口逻辑：滴答非官方 v2 API 的类型 + 附件解析 + 已完成窗口路径。
 *
 * 原生桌面端和 Node 开发工具共用这一份，保证接口返回的解析一致。
 * 这里没有任何 Node 或 DOM 依赖。
 */

import type { HostConfig } from "./host.js";

export type RawRecord = Record<string, unknown>;
export type CookieMap = Record<string, string>;

export interface EngineAttachment {
  id: string;
  taskId: string;
  projectId: string;
  name: string;
  /** MIME / content type as reported by the API, best-effort. */
  type: string;
  size?: number;
  /** Download URL we will GET for bytes. */
  url: string;
}

export interface EngineProject {
  id: string;
  name: string;
}

export interface EngineSnapshot {
  inboxId?: string;
  cookies: CookieMap;
  host: HostConfig;
  fetchImpl: typeof fetch;
  projects: EngineProject[];
  /** taskId -> projectId, for open tasks present in the initial batch sync. */
  projectIdByTaskId: Map<string, string>;
  /** projectId -> full open-task records (with title + attachments) from the batch. */
  openTasksByProject: Map<string, RawRecord[]>;
}

export const COMPLETED_WINDOW_HOURS = 168;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Dida's /completed/ endpoint wants `from`/`to` as `YYYY-MM-DD HH:MM:SS` in UTC
 * (space pre-encoded as %20, NO timezone). Using a raw ISO string here is
 * silently ignored by the server (which is why descending-cursor pagination
 * looked stuck and only returned the most recent page).
 */
function formatCompletedWindowPart(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    `%20${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}

/**
 * Build the /completed/ path for a ±windowHours window around `centerIso`.
 * Returns null if centerIso is not a valid date. Set `global` to query
 * /project/all/completed (cross-project fallback).
 */
export function buildCompletedWindowPath(
  projectId: string,
  centerIso: string,
  options: {
    windowHours?: number;
    global?: boolean;
    status?: "Abandoned";
  } = {},
): string | null {
  const center = new Date(centerIso);
  if (Number.isNaN(center.getTime())) return null;
  const windowMs =
    (options.windowHours ?? COMPLETED_WINDOW_HOURS) * 3600 * 1000;
  const from = formatCompletedWindowPart(new Date(center.getTime() - windowMs));
  const to = formatCompletedWindowPart(new Date(center.getTime() + windowMs));
  if (options.status)
    return `/api/v2/project/all/closed?from=${from}&to=${to}&limit=100&status=Abandoned`;
  return options.global
    ? `/api/v2/project/all/completed?from=${from}&to=${to}&limit=100`
    : `/api/v2/project/${projectId}/completed/?from=${from}&to=${to}&limit=100`;
}

function buildAttachmentDownloadUrl(
  input: RawRecord,
  host: HostConfig,
  taskId: string,
  projectId: string,
): string | null {
  const attachmentId =
    typeof input.id === "string"
      ? input.id
      : typeof input.refId === "string"
        ? input.refId
        : null;
  if (!attachmentId) return null;
  return `${host.apiUrl}/api/v1/attachment/${projectId}/${taskId}/${attachmentId}?action=download`;
}

export function normalizeAttachments(
  value: unknown,
  host: HostConfig,
  taskId: string,
  projectId: string,
): EngineAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map<EngineAttachment | null>((item, index) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as RawRecord;
      const name =
        typeof raw.fileName === "string"
          ? raw.fileName
          : typeof raw.name === "string"
            ? raw.name
            : "attachment";
      const url = buildAttachmentDownloadUrl(raw, host, taskId, projectId);
      if (!url) return null;

      const type =
        typeof raw.contentType === "string"
          ? raw.contentType
          : typeof raw.type === "string"
            ? raw.type
            : typeof raw.fileType === "string"
              ? raw.fileType
              : "application/octet-stream";
      const size =
        typeof raw.size === "number"
          ? raw.size
          : typeof raw.fileSize === "number"
            ? raw.fileSize
            : undefined;

      const att: EngineAttachment = {
        id: typeof raw.id === "string" ? raw.id : String(raw.refId),
        taskId,
        projectId,
        name,
        type,
        url,
      };
      if (typeof size === "number") att.size = size;
      return att;
    })
    .filter((item): item is EngineAttachment => item !== null);
}

/** Extract downloadable attachments from a raw task record (open or completed). */
export function attachmentsFromTaskRecord(
  snapshot: EngineSnapshot,
  task: RawRecord,
): EngineAttachment[] {
  const taskId = typeof task.id === "string" ? task.id : "";
  const projectId = typeof task.projectId === "string" ? task.projectId : "";
  if (!taskId || !projectId) return [];
  return normalizeAttachments(
    task.attachments,
    snapshot.host,
    taskId,
    projectId,
  );
}

/** Reject malformed responses and recursively partition saturated history windows.
 * There is no verified pagination cursor; splitting time ranges avoids pretending a 100-row page is complete.
 */
export async function fetchCompletedWindowComplete(
  projectId: string,
  centerIso: string,
  options: { windowHours?: number; global?: boolean; status?: "Abandoned" },
  request: (path: string) => Promise<unknown>,
): Promise<RawRecord[]> {
  const center = Date.parse(centerIso);
  if (!Number.isFinite(center)) throw Error("Invalid completion date");
  const span = (options.windowHours ?? COMPLETED_WINDOW_HOURS) * 3600000;
  let calls = 0;
  async function scan(from: number, to: number): Promise<RawRecord[]> {
    if (++calls > 4096) throw Error("History scan limit exceeded");
    const target = options.global ? "all" : encodeURIComponent(projectId);
    const route = options.status
      ? "/api/v2/project/all/closed"
      : `/api/v2/project/${target}/completed${options.global ? "" : "/"}`;
    const path = `${route}?from=${formatCompletedWindowPart(new Date(from))}&to=${formatCompletedWindowPart(new Date(to))}&limit=100${options.status ? "&status=Abandoned" : ""}`;
    const response = await request(path);
    const rows = Array.isArray(response)
      ? response
      : response &&
          typeof response === "object" &&
          Array.isArray((response as RawRecord).tasks)
        ? ((response as RawRecord).tasks as unknown[])
        : null;
    if (
      !rows ||
      rows.some(
        (r) =>
          !r ||
          typeof r !== "object" ||
          typeof (r as RawRecord).id !== "string",
      )
    )
      throw Error("Invalid history response");
    if (rows.length < 100) return rows as RawRecord[];
    if (to - from <= 1000)
      throw Error("History window saturated; coverage unproven");
    const middle = Math.floor((from + to) / 2000) * 1000;
    const left = await scan(from, middle);
    const right = await scan(middle, to);
    return [...new Map([...left, ...right].map((r) => [r.id, r])).values()];
  }
  return scan(center - span, center + span);
}

/** Parse the batch once in all platforms; inbox is outside projectProfiles. */
export function snapshotFromBatch(
  batch: unknown,
  base: Pick<EngineSnapshot, "host" | "cookies" | "fetchImpl">,
): EngineSnapshot {
  if (!batch || typeof batch !== "object")
    throw Error("Invalid batch response");
  const record = batch as RawRecord;
  if (
    !Array.isArray(record.projectProfiles) ||
    !record.syncTaskBean ||
    typeof record.syncTaskBean !== "object"
  )
    throw Error("Incomplete batch response");
  const bean = record.syncTaskBean as RawRecord;
  if (!Array.isArray(bean.update)) throw Error("Missing task sync data");
  const projects = record.projectProfiles.flatMap((p: RawRecord) =>
    typeof p.id === "string" && typeof p.name === "string"
      ? [{ id: p.id, name: p.name }]
      : [],
  );
  const projectIdByTaskId = new Map<string, string>();
  const openTasksByProject = new Map<string, RawRecord[]>();
  for (const task of bean.update as RawRecord[]) {
    if (typeof task.id === "string" && typeof task.projectId === "string") {
      projectIdByTaskId.set(task.id, task.projectId);
      const list = openTasksByProject.get(task.projectId) ?? [];
      list.push(task);
      openTasksByProject.set(task.projectId, list);
    }
  }
  return {
    ...base,
    projects,
    projectIdByTaskId,
    openTasksByProject,
    ...(typeof record.inboxId === "string" ? { inboxId: record.inboxId } : {}),
  };
}

/** Full project records include archived todo tasks absent from batch; status filtering stays in orchestration. */
export function parseProjectTasksResponse(response: unknown): RawRecord[] {
  if (
    !Array.isArray(response) ||
    response.some(
      (r) =>
        !r || typeof r !== "object" || typeof (r as RawRecord).id !== "string",
    )
  )
    throw Error("Invalid project tasks response");
  return response as RawRecord[];
}
