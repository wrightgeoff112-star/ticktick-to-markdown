/**
 * 平台无关的图片接口逻辑：滴答非官方 v2 API 的类型 + 附件解析 + 已完成窗口路径。
 *
 * Node 引擎（`image-engine.ts`）和浏览器扩展引擎（`extension/src/engine.ts`）
 * 共用这一份，保证两边对接口返回的解析完全一致。这里没有任何 Node 或 DOM 依赖。
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
  options: { windowHours?: number; global?: boolean } = {},
): string | null {
  const center = new Date(centerIso);
  if (Number.isNaN(center.getTime())) return null;
  const windowMs = (options.windowHours ?? COMPLETED_WINDOW_HOURS) * 3600 * 1000;
  const from = formatCompletedWindowPart(new Date(center.getTime() - windowMs));
  const to = formatCompletedWindowPart(new Date(center.getTime() + windowMs));
  return options.global
    ? `/api/v2/project/all/completed?from=${from}&to=${to}&limit=100`
    : `/api/v2/project/${projectId}/completed/?from=${from}&to=${to}&limit=100`;
}

function pickAttachmentUrl(input: RawRecord): string | null {
  const candidates = [
    input.url,
    input.downloadUrl,
    input.viewUrl,
    input.previewUrl,
    input.fileUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return null;
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
      const url =
        pickAttachmentUrl(raw) ??
        buildAttachmentDownloadUrl(raw, host, taskId, projectId);
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
        id: typeof raw.id === "string" ? raw.id : `attachment-${index}`,
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
  return normalizeAttachments(task.attachments, snapshot.host, taskId, projectId);
}
