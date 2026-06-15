/**
 * Sortday SDX bundle builder.
 *
 * Produces an in-memory plan for a `.sortday.zip` (SDX, schemaVersion
 * "sortday-export-v1") that sortday can import one-click via its built-in
 * "导入数据 / Import" flow — no sortday-side code required.
 *
 * Target format (read-only reference, do NOT change sortday):
 *   - apps/web/src/lib/export/sdx-format.ts   (SdxManifest / SdxAttachmentEntry)
 *   - apps/web/src/lib/export/sdx-import.ts    (how the zip is parsed + merged)
 *   - apps/web/src/atoms/local-sdthings.ts     (LocalSdThingStorage)
 *   - apps/web/src/atoms/sidebar-lists.ts      (SidebarList)
 *
 * Design / invariants:
 * - We emit brand-new, purely-local ids (crypto.randomUUID), NOT `dida-` ids.
 *   id = `sd:local:local::<externalId>`, source = { type:"local", externalId }.
 *   This makes the imported data indistinguishable from data the user created
 *   in sortday (importMeta:null), so it never hits the "legacy dida import"
 *   code paths.
 * - All cross-references (parentId / listId / folderId) are rewritten through
 *   id-mapping tables. A reference that can't be resolved is set to null —
 *   never a dangling id.
 * - Dates are already ISO instants (…Z) from csv.ts's `toIsoInstant`, which is
 *   exactly what sortday's `Temporal.Instant.from` accepts. Unparseable dates
 *   are dropped to null with a recorded gap so import never crashes.
 * - Attachments are inlined into noteMd as `<sd-attachment>` nodes whose
 *   `data-attachment-id` equals the attachment's id (the proven sortday render
 *   path), and the blob is keyed by storageKey `thing-attachment://<thingId>/<attId>`.
 *
 * This module is pure and filesystem-free so it can be unit-tested. The CLI
 * flushes the plan via `buildSortdayZip` (zip.ts) + fs writeFile.
 */

import { randomUUID } from "node:crypto";

import type { CsvParseResult, CsvTask } from "./csv.js";
import type { DidaReminderRule } from "./reminder-rules.js";
import type { ResolvedAttachment } from "./vault.js";

export const SDX_SCHEMA_VERSION = "sortday-export-v1" as const;
export const SDX_MANIFEST_FILENAME = "sortday-export.json" as const;
export const SDX_ATTACHMENTS_DIR = "attachments" as const;

// ---------------------------------------------------------------------------
// Mirror of sortday's storage shapes (only the fields we populate / the import
// validator checks). Kept structurally compatible with LocalSdThingStorage /
// SidebarList / SdxManifest — see the reference files listed above.
// ---------------------------------------------------------------------------

/** Mirror of sortday's LocalReminderRule (DidaReminderRule + engineEnabled). */
export interface SortdayReminderRule {
  triggerRaw: string;
  triggerCanonical: string;
  triggerSeconds: number | null;
  triggerMode: "relative" | "day_clock" | "unknown";
  parseStatus: "parsed" | "fallback_raw" | "invalid";
  engineEnabled: false;
}

/** Mirror of sortday's LocalRecurrenceImport. */
export interface SortdayRecurrenceImport {
  repeatRuleRaw: string;
  repeatRuleCanonical: string;
  /** We never synthesize a typed Recurrence here; always null (raw is lossless). */
  parsedRuleJson: null;
  parseStatus: "parsed" | "fallback_raw" | "invalid";
  engineEnabled: boolean;
  timezone: string;
}

/** Mirror of sortday's SdThingAttachment (the subset import reads). */
export interface SortdayThingAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size?: number;
  source: "local-upload";
  storageKey: string;
}

/** Mirror of sortday's LocalSdThingStorage. */
export interface SortdayThing {
  id: string;
  kind: "task" | "note";
  role: "task" | null;
  title: string;
  description: null;
  status: "todo" | "done" | "na" | "canceled";
  completedAt: string | null;
  priority: number | null;
  dueTime: string | null;
  doTime: {
    startAt: string;
    endAt: string | null;
    allDay: boolean;
    timezone: string;
  } | null;
  parentId: string | null;
  listId: string | null;
  noteMd: string | null;
  tags: string[] | null;
  attachments: SortdayThingAttachment[] | null;
  reminderRules: SortdayReminderRule[] | null;
  recurrence: null;
  recurrenceImport: SortdayRecurrenceImport | null;
  importMeta: null;
  sortAt: string;
  source: { type: "local"; externalId: string };
  createdAt: string;
  updatedAt: string;
}

/** Mirror of sortday's SidebarList (manual list / folder). */
export interface SortdayList {
  id: string;
  title: string;
  iconKey: string;
  note: null;
  createdAtUnix: number;
  role: "list" | "folder";
  folderId: string | null;
  kind: "manual";
}

/** Mirror of sortday's SdxAttachmentEntry. */
export interface SortdayAttachmentEntry {
  id: string;
  thingId: string;
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  file: string | null;
  missing?: boolean;
}

/** Mirror of sortday's SdxManifest. */
export interface SortdayManifest {
  schemaVersion: typeof SDX_SCHEMA_VERSION;
  app: "sortday";
  exportedAt: string;
  counts: {
    things: number;
    lists: number;
    attachments: number;
    attachmentsMissing: number;
  };
  things: SortdayThing[];
  lists: SortdayList[];
  attachments: SortdayAttachmentEntry[];
}

export interface SortdayBundleBinary {
  /** Path inside the zip, e.g. "attachments/<id>.png". */
  path: string;
  bytes: Buffer;
}

export interface SortdayBundleGap {
  code: string;
  message: string;
  taskId?: string;
  attachmentId?: string;
}

export interface SortdayBundle {
  manifest: SortdayManifest;
  /** attachments/<id>.<ext> binaries to write into the zip. */
  binaries: SortdayBundleBinary[];
  /** Non-fatal data-loss notes (e.g. unparseable dates, undownloaded images). */
  gaps: SortdayBundleGap[];
}

export interface BuildSortdayBundleInput {
  csv: CsvParseResult;
  /** Downloaded attachments grouped by CsvTask.sourceTaskId (same map as vault). */
  attachmentsByTask?: Map<string, ResolvedAttachment[]>;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Injectable id generator for deterministic tests. Defaults to crypto.randomUUID. */
  idFactory?: () => string;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

const IMAGE_REF_PATTERN =
  /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const MARKDOWN_IMAGE_REGEXP = /!\[[^\]]*\]\(([^)]+)\)/g;
const LEGACY_IMPORT_META_REGEXP =
  /<!--\s*sortday-import-meta\s+[\s\S]*?\s*-->/g;

function inferExtension(mimeType: string, name: string): string {
  const byMime = MIME_EXTENSION[mimeType.toLowerCase()];
  if (byMime) return byMime;
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "bin";
}

function isImageAttachment(att: ResolvedAttachment): boolean {
  if (att.type.toLowerCase().startsWith("image/")) return true;
  return IMAGE_REF_PATTERN.test(`${att.name} ${att.id}`);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `<sd-attachment>` node identical in shape to sortday's renderer output. */
function buildAttachmentNodeHtml(input: {
  kind: "image" | "file";
  attachmentId: string;
  fileName?: string;
}): string {
  const attrs = [
    `data-kind="${input.kind}"`,
    `data-state="ready"`,
    `data-display="block"`,
    `data-attachment-id="${escapeHtmlAttribute(input.attachmentId)}"`,
  ];
  if (input.kind === "file" && input.fileName) {
    attrs.push(`data-file-name="${escapeHtmlAttribute(input.fileName)}"`);
  }
  return `<sd-attachment ${attrs.join(" ")}></sd-attachment>`;
}

function buildStorageKey(thingId: string, attachmentId: string): string {
  return `thing-attachment://${thingId}/${attachmentId}`;
}

function mapReminderRules(rules: DidaReminderRule[]): SortdayReminderRule[] {
  return rules.map((rule) => ({
    triggerRaw: rule.triggerRaw,
    triggerCanonical: rule.triggerCanonical,
    triggerSeconds: rule.triggerSeconds,
    triggerMode: rule.triggerMode,
    parseStatus: rule.parseStatus,
    engineEnabled: false,
  }));
}

function mapRecurrenceImport(
  task: CsvTask,
): SortdayRecurrenceImport | null {
  if (!task.recurrence) return null;
  // Conservative: keep the raw/canonical RRULE (lossless) but never synthesize
  // a typed Recurrence; engineEnabled stays false so it can't break import.
  return {
    repeatRuleRaw: task.recurrence.raw,
    repeatRuleCanonical: task.recurrence.canonical,
    parsedRuleJson: null,
    parseStatus: task.recurrence.parseStatus,
    engineEnabled: false,
    timezone: task.timezone || "UTC",
  };
}

type AttachmentPlanEntry = {
  thingId: string;
  attachment: SortdayThingAttachment;
  manifestEntry: SortdayAttachmentEntry;
  isImage: boolean;
};

export function buildSortdayBundle(
  input: BuildSortdayBundleInput,
): SortdayBundle {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const newId = input.idFactory ?? randomUUID;
  const attachmentsByTask = input.attachmentsByTask ?? new Map();
  const gaps: SortdayBundleGap[] = [];

  // --- id mapping tables (source id -> new sortday id) ---------------------
  const taskExternalIdByCsvId = new Map<string, string>();
  const taskIdByCsvId = new Map<string, string>();
  for (const task of input.csv.tasks) {
    const externalId = newId();
    taskExternalIdByCsvId.set(task.id, externalId);
    taskIdByCsvId.set(task.id, `sd:local:local::${externalId}`);
  }

  const folderIdByCsvId = new Map<string, string>();
  for (const folder of input.csv.folders) {
    folderIdByCsvId.set(folder.id, `sd:local:local::${newId()}`);
  }

  const listIdByCsvId = new Map<string, string>();
  for (const list of input.csv.lists) {
    listIdByCsvId.set(list.id, `sd:local:local::list-${newId()}`);
  }

  // --- lists + folders -----------------------------------------------------
  const lists: SortdayList[] = [];
  for (const folder of input.csv.folders) {
    const id = folderIdByCsvId.get(folder.id);
    if (!id) continue;
    lists.push({
      id,
      title: folder.title,
      iconKey: "Folder",
      note: null,
      createdAtUnix: 0,
      role: "folder",
      folderId: null,
      kind: "manual",
    });
  }
  for (const list of input.csv.lists) {
    const id = listIdByCsvId.get(list.id);
    if (!id) continue;
    lists.push({
      id,
      title: list.title,
      iconKey: "ListTodo",
      note: null,
      createdAtUnix: 0,
      role: "list",
      folderId: list.folderId
        ? (folderIdByCsvId.get(list.folderId) ?? null)
        : null,
      kind: "manual",
    });
  }

  // --- attachments (per CsvTask.sourceTaskId) ------------------------------
  // Pre-plan all downloaded attachments so noteMd inlining + manifest agree.
  const attachmentPlanByCsvTaskId = new Map<string, AttachmentPlanEntry[]>();
  const binaries: SortdayBundleBinary[] = [];
  const manifestAttachments: SortdayAttachmentEntry[] = [];
  let attachmentsTotal = 0;
  let attachmentsMissing = 0;
  const usedFilePaths = new Set<string>();

  for (const task of input.csv.tasks) {
    const sourceKey = task.sourceTaskId ?? "";
    const resolved = attachmentsByTask.get(sourceKey) ?? [];
    if (resolved.length === 0) continue;

    const thingId = taskIdByCsvId.get(task.id);
    if (!thingId) continue;

    const planEntries: AttachmentPlanEntry[] = [];
    for (const att of resolved) {
      attachmentsTotal += 1;
      const attId = newId();
      const storageKey = buildStorageKey(thingId, attId);
      const isImage = isImageAttachment(att);

      let filePath: string | null = null;
      if (att.bytes) {
        const ext = inferExtension(att.type, att.name);
        let candidate = `${SDX_ATTACHMENTS_DIR}/${attId}.${ext}`;
        let suffix = 2;
        while (usedFilePaths.has(candidate)) {
          candidate = `${SDX_ATTACHMENTS_DIR}/${attId}-${suffix}.${ext}`;
          suffix += 1;
        }
        usedFilePaths.add(candidate);
        filePath = candidate;
        binaries.push({ path: candidate, bytes: att.bytes });
      } else {
        attachmentsMissing += 1;
        gaps.push({
          code: "attachment_no_bytes",
          message: `附件「${att.name}」没有下载到二进制，未打包（thing.attachments 仍保留索引）。`,
          taskId: task.id,
          attachmentId: attId,
        });
      }

      const size = att.size ?? att.bytes?.length ?? 0;
      const thingAttachment: SortdayThingAttachment = {
        id: attId,
        name: att.name,
        type: att.type,
        url: "",
        size,
        source: "local-upload",
        storageKey,
      };
      const manifestEntry: SortdayAttachmentEntry = {
        id: attId,
        thingId,
        storageKey,
        name: att.name,
        mimeType: att.type,
        size,
        file: filePath,
        ...(filePath ? {} : { missing: true }),
      };
      manifestAttachments.push(manifestEntry);
      planEntries.push({
        thingId,
        attachment: thingAttachment,
        manifestEntry,
        isImage,
      });
    }
    if (planEntries.length > 0) {
      attachmentPlanByCsvTaskId.set(task.id, planEntries);
    }
  }

  // --- things --------------------------------------------------------------
  const things: SortdayThing[] = [];
  for (const task of input.csv.tasks) {
    const externalId = taskExternalIdByCsvId.get(task.id);
    const id = taskIdByCsvId.get(task.id);
    if (!externalId || !id) continue;

    const isNote = task.kind === "note";
    const status: SortdayThing["status"] = isNote ? "na" : task.status;

    const doTime =
      !isNote && task.startDate
        ? {
            startAt: task.startDate,
            endAt: null,
            allDay: task.isAllDay,
            timezone: task.timezone || "UTC",
          }
        : null;
    const dueTime = isNote ? null : task.dueDate;
    const completedAt = isNote ? null : task.completedTime;
    const sortAt = doTime?.startAt ?? dueTime ?? task.startDate ?? nowIso;

    const planEntries = attachmentPlanByCsvTaskId.get(task.id) ?? [];
    const attachments =
      planEntries.length > 0
        ? planEntries.map((entry) => entry.attachment)
        : null;
    const noteMd = buildNoteMd(task, planEntries, gaps);

    const parentId = task.parentId
      ? (taskIdByCsvId.get(task.parentId) ?? null)
      : null;
    const listId = task.listId
      ? (listIdByCsvId.get(task.listId) ?? null)
      : null;

    things.push({
      id,
      kind: isNote ? "note" : "task",
      role: "task",
      title: task.title,
      description: null,
      status,
      completedAt,
      priority: task.priority,
      dueTime,
      doTime,
      parentId,
      listId,
      noteMd,
      tags: task.tags.length > 0 ? task.tags : null,
      attachments,
      reminderRules:
        task.reminderRules.length > 0
          ? mapReminderRules(task.reminderRules)
          : null,
      recurrence: null,
      recurrenceImport: mapRecurrenceImport(task),
      importMeta: null,
      sortAt,
      source: { type: "local", externalId },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  const manifest: SortdayManifest = {
    schemaVersion: SDX_SCHEMA_VERSION,
    app: "sortday",
    exportedAt: nowIso,
    counts: {
      things: things.length,
      lists: lists.length,
      attachments: attachmentsTotal,
      attachmentsMissing,
    },
    things,
    lists,
    attachments: manifestAttachments,
  };

  return { manifest, binaries, gaps };
}

/**
 * Build a clean noteMd: strip legacy import-meta comments, then replace each
 * markdown image ref (in document order) with an `<sd-attachment>` node whose
 * data-attachment-id matches a downloaded image attachment. Refs without a
 * downloaded image are dropped (with a gap) so no broken `![](...)` remains.
 * Downloaded attachments that had no markdown ref are appended as nodes.
 */
function buildNoteMd(
  task: CsvTask,
  planEntries: AttachmentPlanEntry[],
  gaps: SortdayBundleGap[],
): string | null {
  const raw = (task.content ?? "").replace(LEGACY_IMPORT_META_REGEXP, "");

  const imageEntries = planEntries.filter((entry) => entry.isImage);
  const fileEntries = planEntries.filter((entry) => !entry.isImage);
  const usedAttachmentIds = new Set<string>();

  let imageIndex = -1;
  let body = raw.replace(MARKDOWN_IMAGE_REGEXP, (_full, _ref: string) => {
    imageIndex += 1;
    const entry = imageEntries[imageIndex];
    if (!entry) {
      gaps.push({
        code: "image_ref_not_downloaded",
        message: `任务「${task.title}」的内联图片未下载到二进制，已移除占位。`,
        taskId: task.id,
      });
      return "";
    }
    usedAttachmentIds.add(entry.attachment.id);
    return buildAttachmentNodeHtml({
      kind: "image",
      attachmentId: entry.attachment.id,
    });
  });

  body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // Append any downloaded attachment not already placed via a markdown ref
  // (e.g. images with no ref in the note, or non-image files).
  const appended: string[] = [];
  for (const entry of [...imageEntries, ...fileEntries]) {
    if (usedAttachmentIds.has(entry.attachment.id)) continue;
    appended.push(
      buildAttachmentNodeHtml({
        kind: entry.isImage ? "image" : "file",
        attachmentId: entry.attachment.id,
        fileName: entry.isImage ? undefined : entry.attachment.name,
      }),
    );
  }

  const parts = [body, ...appended].filter((part) => part.length > 0);
  const result = parts.join(body && appended.length > 0 ? "\n\n" : "");
  return result.length > 0 ? result : null;
}

/** Type guard equivalent to sortday's isSdxManifest (for tests / verification). */
export function isSortdayManifest(value: unknown): value is SortdayManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SortdayManifest>;
  return (
    v.schemaVersion === SDX_SCHEMA_VERSION &&
    v.app === "sortday" &&
    Array.isArray(v.things) &&
    Array.isArray(v.lists) &&
    Array.isArray(v.attachments)
  );
}
