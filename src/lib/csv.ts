/**
 * TickTick / 滴答清单 official CSV export parser.
 *
 * Standalone reimplementation. We keep the parts that understand the export
 * format (CSV tokenizer, header detection, status / priority mapping,
 * list+folder grouping, tags, attachment refs, repeat & reminder rules) and
 * emit a neutral, self-describing task model.
 */

import {
  parseDidaRepeatRule,
  type DidaRepeatParsedResult,
} from "./recurrence.js";
import {
  parseDidaReminderRules,
  type DidaReminderRule,
} from "./reminder-rules.js";

export type TaskStatus = "todo" | "done" | "canceled";
export type TaskKind = "task" | "note";

export interface CsvList {
  /** Stable slug-ish id derived from folder + list name. */
  id: string;
  title: string;
  /** Folder id this list belongs to, if any. */
  folderId: string | null;
}

export interface CsvFolder {
  id: string;
  title: string;
}

export interface CsvTask {
  /** Stable id: `dida-<taskId>` or `dida-row-<n>` when the source id is empty. */
  id: string;
  /** Raw TickTick task id from the CSV, if present. */
  sourceTaskId: string | null;
  kind: TaskKind;
  title: string;
  /** Raw note/content as exported (multiline un-escaped), may contain image refs. */
  content: string | null;
  status: TaskStatus;
  /** App-scale priority: null | 1 (low) | 2 (mid) | 3 (high). */
  priority: number | null;
  /** Original TickTick priority number (0/1/3/5). */
  rawPriority: number | null;
  listId: string | null;
  folderId: string | null;
  /** Stable id of the parent task, resolved within this export. */
  parentId: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedTime: string | null;
  isAllDay: boolean;
  timezone: string;
  tags: string[];
  /** Markdown image/attachment refs found inside the note content. */
  attachmentRefs: string[];
  reminderRules: DidaReminderRule[];
  recurrence: DidaRepeatParsedResult | null;
}

export interface CsvParseSummary {
  totalRows: number;
  importedTasks: number;
  withRepeat: number;
  withReminder: number;
  withAttachmentRefs: number;
}

export interface CsvParseResult {
  tasks: CsvTask[];
  lists: CsvList[];
  folders: CsvFolder[];
  summary: CsvParseSummary;
  warnings: string[];
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

type CsvRowMap = Record<string, string>;

function toNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 滴答优先级刻度（0=无 / 1=低 / 3=中 / 5=高）→ 本应用刻度（null/1/2/3）。 */
function mapDidaPriorityToApp(raw: number | null): number | null {
  switch (raw) {
    case 1:
      return 1;
    case 3:
      return 2;
    case 5:
      return 3;
    default:
      return null;
  }
}

function normalizeOffsetTimezone(value: string): string {
  return value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

export function toIsoInstant(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = normalizeOffsetTimezone(trimmed);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** RFC-4180-ish CSV tokenizer that handles quoted cells and embedded newlines. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function trimValue(value: string | undefined): string {
  return String(value ?? "")
    .replace(/^﻿/, "")
    .trim();
}

function decodeDidaEscapedMultilineValue(value: string): string {
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

function findHeaderIndex(rows: string[][]): number {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]?.map(trimValue) ?? [];
    if (row.includes("taskId") && row.includes("Title")) {
      return i;
    }
  }
  return -1;
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[;,，；\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function extractAttachmentRefs(content: string): string[] {
  const refs: string[] = [];
  const regexp = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = regexp.exec(content);
  while (match) {
    const ref = match[1]?.trim();
    if (ref) refs.push(ref);
    match = regexp.exec(content);
  }
  return refs;
}

function buildSafeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeTaskStatus(input: {
  rawStatus: string;
  completedTime: string;
}): TaskStatus {
  const n = toNumber(input.rawStatus);
  if (n === -1) return "canceled";

  const hasCompletedTime = input.completedTime.trim().length > 0;
  if (hasCompletedTime) return "done";

  // TickTick CSV uses status=2 for completed tasks exported from done/history views.
  if (n === 1 || n === 2) return "done";
  return "todo";
}

function normalizeKind(rawKind: string): TaskKind {
  return rawKind.trim().toUpperCase() === "NOTE" ? "note" : "task";
}

function buildExternalId(taskId: string, rowIndex: number): string {
  if (taskId) return `dida-${taskId}`;
  return `dida-row-${rowIndex}`;
}

/** Groups rows into lists + folders, assigning stable ids. */
function buildListRegistry(rows: CsvRowMap[]) {
  const lists: CsvList[] = [];
  const folders: CsvFolder[] = [];
  const listIdBySourceKey = new Map<string, string>();
  const usedIds = new Map<string, string>();
  const folderIdByName = new Map<string, string>();

  const ensureFolder = (folderName: string): string => {
    const existing = folderIdByName.get(folderName);
    if (existing) return existing;

    const baseId = `dida-folder-${buildSafeId(folderName) || "folder"}`;
    let nextId = baseId;
    let suffix = 2;
    while (usedIds.has(nextId)) {
      nextId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    usedIds.set(nextId, folderName);
    folderIdByName.set(folderName, nextId);
    folders.push({ id: nextId, title: folderName });
    return nextId;
  };

  const ensureList = (
    row: CsvRowMap,
  ): { listId: string; folderId: string | null } | null => {
    const folderName = trimValue(row["Folder Name"]);
    const listName = trimValue(row["List Name"]);
    const sourceKey = `${folderName}::${listName}`;

    if (!folderName && !listName) return null;

    const existing = listIdBySourceKey.get(sourceKey);
    if (existing) {
      const fId = folderName ? (folderIdByName.get(folderName) ?? null) : null;
      return { listId: existing, folderId: fId };
    }

    const title = listName || folderName || "清单";
    const baseId = `dida-${buildSafeId(title) || "list"}`;

    let nextId = baseId;
    let suffix = 2;
    while (usedIds.has(nextId) && usedIds.get(nextId) !== sourceKey) {
      nextId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    usedIds.set(nextId, sourceKey);
    listIdBySourceKey.set(sourceKey, nextId);

    const folderId = folderName ? ensureFolder(folderName) : null;
    lists.push({ id: nextId, title, folderId });
    return { listId: nextId, folderId };
  };

  const resolvedByRowIndex = rows.map((row) => ensureList(row));

  return {
    lists,
    folders,
    resolveListId(rowIndex: number): string | null {
      return resolvedByRowIndex[rowIndex]?.listId ?? null;
    },
    resolveFolderId(rowIndex: number): string | null {
      return resolvedByRowIndex[rowIndex]?.folderId ?? null;
    },
  };
}

function emptyResult(warnings: string[]): CsvParseResult {
  return {
    tasks: [],
    lists: [],
    folders: [],
    summary: {
      totalRows: 0,
      importedTasks: 0,
      withRepeat: 0,
      withReminder: 0,
      withAttachmentRefs: 0,
    },
    warnings,
  };
}

export function parseDidaCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text);
  const headerIndex = findHeaderIndex(rows);

  if (headerIndex < 0) {
    throw new CsvFormatError(
      "未识别到有效的滴答/TickTick CSV 表头（缺少 taskId / Title 列）。" +
        "请确认这是从「设置 → 导出」下载的原始 CSV 文件，且未被改写。\n" +
        "Could not find a valid TickTick/滴答 CSV header (missing taskId / Title columns). " +
        "Make sure this is the raw CSV downloaded from Settings → Export.",
    );
  }

  const header = rows[headerIndex]?.map(trimValue) ?? [];
  const dataRows = rows.slice(headerIndex + 1);

  const mappedRows: CsvRowMap[] = dataRows
    .filter((row) => row.some((cell) => trimValue(cell) !== ""))
    .map((row) => {
      const obj: CsvRowMap = {};
      for (let i = 0; i < header.length; i += 1) {
        obj[header[i]!] = row[i] ?? "";
      }
      return obj;
    });

  // First pass: map source task ids to our stable ids for parent resolution.
  const idByTaskId = new Map<string, string>();
  mappedRows.forEach((row, index) => {
    const taskId = trimValue(row.taskId);
    if (!taskId) return;
    idByTaskId.set(taskId, buildExternalId(taskId, index));
  });

  const registry = buildListRegistry(mappedRows);
  const tasks: CsvTask[] = [];
  const warnings: string[] = [];

  let withRepeat = 0;
  let withReminder = 0;
  let withAttachmentRefs = 0;

  mappedRows.forEach((row, index) => {
    const title = trimValue(row.Title);
    const taskId = trimValue(row.taskId);
    if (!title && !taskId) return;

    const id = buildExternalId(taskId, index);
    const rawKind = trimValue(row.Kind) || "TEXT";
    const kind = normalizeKind(rawKind);

    const rawCompletedTime = trimValue(row["Completed Time"]);
    const status = normalizeTaskStatus({
      rawStatus: trimValue(row.Status),
      completedTime: rawCompletedTime,
    });

    const startDate = toIsoInstant(trimValue(row["Start Date"]));
    const dueDate = toIsoInstant(trimValue(row["Due Date"]));
    const completedTime =
      status === "done" ? toIsoInstant(rawCompletedTime) : null;

    const isAllDay = trimValue(row["Is All Day"]).toLowerCase() === "true";
    const timezone = trimValue(row.Timezone) || "Asia/Shanghai";
    const tags = splitTags(trimValue(row.Tags));

    const contentRaw = trimValue(row.Content);
    const content = contentRaw
      ? decodeDidaEscapedMultilineValue(contentRaw)
      : null;
    const attachmentRefs = content ? extractAttachmentRefs(content) : [];

    const reminderRules = parseDidaReminderRules(trimValue(row.Reminder), {
      isAllDay,
    });
    const repeatRaw = trimValue(row.Repeat);
    const recurrence = repeatRaw ? parseDidaRepeatRule(repeatRaw) : null;

    if (recurrence) withRepeat += 1;
    if (reminderRules.length > 0) withReminder += 1;
    if (attachmentRefs.length > 0) withAttachmentRefs += 1;

    const parentSourceId = trimValue(row.parentId);
    const parentId = parentSourceId
      ? (idByTaskId.get(parentSourceId) ?? null)
      : null;
    if (parentSourceId && !parentId) {
      warnings.push(
        `taskId=${taskId || `row-${index + 1}`} 的 parentId=${parentSourceId} 未找到，已忽略父子关系`,
      );
    }

    tasks.push({
      id,
      sourceTaskId: taskId || null,
      kind,
      title: title || "(无标题)",
      content,
      status,
      priority: mapDidaPriorityToApp(toNumber(trimValue(row.Priority))),
      rawPriority: toNumber(trimValue(row.Priority)),
      listId: registry.resolveListId(index),
      folderId: registry.resolveFolderId(index),
      parentId,
      startDate,
      dueDate,
      completedTime,
      isAllDay,
      timezone,
      tags,
      attachmentRefs,
      reminderRules,
      recurrence,
    });
  });

  return {
    tasks,
    lists: registry.lists,
    folders: registry.folders,
    summary: {
      totalRows: mappedRows.length,
      importedTasks: tasks.length,
      withRepeat,
      withReminder,
      withAttachmentRefs,
    },
    warnings,
  };
}
