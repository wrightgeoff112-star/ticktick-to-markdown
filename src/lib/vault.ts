/**
 * Vault builder: turns parsed CSV tasks (+ optional downloaded attachments)
 * into an in-memory plan of files (markdown + attachment bytes) plus a manifest.
 *
 * `buildVault` is pure and filesystem-free so it can be unit-tested. `writeVault`
 * (in fs.ts) flushes the plan to disk.
 */

import type { CsvFolder, CsvList, CsvParseResult, CsvTask } from "./csv.js";
import type { HostConfig } from "./host.js";
import {
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ManifestAttachment,
  type ManifestGap,
  type ManifestProject,
  type ManifestTask,
} from "./manifest.js";

export interface ResolvedAttachment {
  id: string;
  taskId: string;
  name: string;
  type: string;
  size?: number;
  /** Downloaded bytes, or null if metadata-only / download failed. */
  bytes: Uint8Array | null;
  diskHandle?: string;
  /** Explicitly excluded by the user, rather than a download failure. */
  skippedByUser?: boolean;
}

export interface BuildVaultInput {
  csv: CsvParseResult;
  host: HostConfig;
  csvPath: string;
  rawCsv?: string;
  rawApiJson?: string;
  apiTaskIds?: Map<string, string>;
  withImages: boolean;
  toolVersion: string;
  /** Attachments grouped by task id. */
  attachmentsByTask?: Map<string, ResolvedAttachment[]>;
  /** Pre-collected gaps (e.g. images skipped on non-macOS). */
  gaps?: ManifestGap[];
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface VaultFile {
  /** Path relative to vault root. */
  path: string;
  /** Markdown / json text content. */
  text: string;
}

export interface VaultBinaryFile {
  path: string;
  bytes: Uint8Array;
}

export interface VaultPlan {
  files: VaultFile[];
  binaries: VaultBinaryFile[];
  diskFiles: { path: string; handle: string }[];
  manifest: Manifest;
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** Filesystem-safe-ish segment; keeps CJK, strips path separators / control chars. */
function sanitizeSegment(input: string): string {
  const cleaned = input
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return cleaned || "untitled";
}

function extFromAttachment(att: ResolvedAttachment): string {
  const fromMime = IMAGE_EXT_BY_MIME[att.type.toLowerCase()];
  if (fromMime) return fromMime;
  const dot = att.name.lastIndexOf(".");
  if (dot >= 0 && dot < att.name.length - 1) {
    const ext = att.name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "bin";
}

function yamlScalar(value: string): string {
  // Quote when the value could be misread as YAML; escape double quotes.
  if (value === "") return '""';
  if (/^[\w./@:+一-龥-]+$/u.test(value) && !/^\d+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlStringList(values: string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(", ")}]`;
}

export function buildFrontmatter(
  task: CsvTask,
  listTitle: string | null,
  folderTitle: string | null,
): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${yamlScalar(task.id)}`);
  if (task.sourceTaskId) {
    lines.push(`sourceTaskId: ${yamlScalar(task.sourceTaskId)}`);
  }
  if (task.parentId) {
    lines.push(`parent: ${yamlScalar(task.parentId)}`);
  }
  lines.push(`kind: ${task.kind}`);
  lines.push(`status: ${task.status}`);
  if (folderTitle) lines.push(`folder: ${yamlScalar(folderTitle)}`);
  if (listTitle) lines.push(`list: ${yamlScalar(listTitle)}`);
  if (task.priority != null) lines.push(`priority: ${task.priority}`);
  if (task.startDate) lines.push(`start: ${yamlScalar(task.startDate)}`);
  // TickTick's "Due Date" is the END of the task's time span, not a deadline
  // (TickTick has no separate deadline concept). Emit it as `end:` so the
  // frontmatter reads naturally (start/end = a time span) and importers can map
  // it to a do-time span. `due:` is reserved for a real deadline.
  if (task.dueDate) lines.push(`end: ${yamlScalar(task.dueDate)}`);
  if (task.completedTime) {
    lines.push(`completed: ${yamlScalar(task.completedTime)}`);
  }
  if (task.createdTime) {
    lines.push(`created: ${yamlScalar(task.createdTime)}`);
  }
  lines.push(`allDay: ${task.isAllDay}`);
  if (task.timezone) lines.push(`timezone: ${yamlScalar(task.timezone)}`);
  if (task.tags.length > 0) {
    lines.push(`tags: ${yamlStringList(task.tags)}`);
  }
  if (task.recurrence) {
    lines.push(`repeat: ${yamlScalar(task.recurrence.canonical)}`);
    lines.push(`repeatStatus: ${task.recurrence.parseStatus}`);
  }
  if (task.reminderRules.length > 0) {
    lines.push(
      `reminders: ${yamlStringList(task.reminderRules.map((r) => r.triggerRaw))}`,
    );
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Rewrite markdown image refs in the note body to point at downloaded files.
 * Refs that have no matching downloaded attachment are left untouched.
 */
function rewriteBody(
  content: string,
  task: CsvTask,
  attachmentsForTask: ResolvedAttachment[],
  attachmentFileById: Map<string, string>,
  relativePrefix: string,
): string {
  if (!content) return "";

  return content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (full, alt: string, ref: string) => {
      const segments = ref.split(/[/?#]/);
      let matches = attachmentsForTask.filter((a) => segments.includes(a.id));
      // Legacy exports may use another reference ID; only a unique relative filename is safe.
      if (!matches.length && !/^https?:/i.test(ref)) {
        const basename = segments.at(-1);
        matches = attachmentsForTask.filter((a) => a.name === basename);
      }
      if (matches.length !== 1) return full;
      const att = matches[0]!;
      const file = attachmentFileById.get(att.id);
      return file ? `![${alt || att.name}](${relativePrefix}${file})` : full;
    },
  );
}

export function buildVault(input: BuildVaultInput): VaultPlan {
  const now = input.now ?? new Date();
  const attachmentsByTask: Map<string, ResolvedAttachment[]> =
    input.attachmentsByTask ?? new Map();
  const gaps: ManifestGap[] = [...(input.gaps ?? [])];

  const files: VaultFile[] = [];
  const binaries: VaultBinaryFile[] = [];
  const diskFiles: { path: string; handle: string }[] = [];
  if (input.rawCsv !== undefined)
    files.push({ path: "backup.csv", text: input.rawCsv });

  if (input.rawApiJson !== undefined)
    files.push({ path: "api-snapshot.json", text: input.rawApiJson });

  const listById = new Map<string, CsvList>(
    input.csv.lists.map((l) => [l.id, l]),
  );
  const folderById = new Map<string, CsvFolder>(
    input.csv.folders.map((f) => [f.id, f]),
  );

  // Pre-assign attachment file paths (so body rewrite + manifest agree).
  const attachmentFileById = new Map<string, string>();
  const manifestAttachments: ManifestAttachment[] = [];
  let attachmentsDownloaded = 0;
  const usedAttachmentPaths = new Set<string>();

  for (const [taskId, list] of attachmentsByTask) {
    for (const att of list) {
      let filePath: string | null = null;
      if (att.bytes || att.diskHandle) {
        const ext = extFromAttachment(att);
        let candidate = `attachments/${sanitizeSegment(att.id)}.${ext}`;
        let suffix = 2;
        while (usedAttachmentPaths.has(candidate)) {
          candidate = `attachments/${sanitizeSegment(att.id)}-${suffix}.${ext}`;
          suffix += 1;
        }
        usedAttachmentPaths.add(candidate);
        filePath = candidate;
        attachmentFileById.set(att.id, candidate);
        if (att.bytes) binaries.push({ path: candidate, bytes: att.bytes });
        else if (att.diskHandle)
          diskFiles.push({ path: candidate, handle: att.diskHandle });
        attachmentsDownloaded += 1;
      }
      manifestAttachments.push({
        id: att.id,
        taskId,
        name: att.name,
        type: att.type,
        file: filePath,
        ...(att.size != null ? { size: att.size } : {}),
        ...(att.skippedByUser ? { skippedByUser: true } : {}),
      });
    }
  }

  // Build per-task markdown files.
  const manifestTasks: ManifestTask[] = [];
  const usedMarkdownPaths = new Set<string>();

  for (const task of input.csv.tasks) {
    const list = task.listId ? listById.get(task.listId) : undefined;
    const projectDir = list ? sanitizeSegment(list.title) : "Inbox";
    const baseName = sanitizeSegment(task.title);

    let mdPath = `${projectDir}/${baseName}.md`;
    let suffix = 2;
    while (usedMarkdownPaths.has(mdPath)) {
      mdPath = `${projectDir}/${baseName}-${suffix}.md`;
      suffix += 1;
    }
    usedMarkdownPaths.add(mdPath);

    const attachmentsForTask =
      attachmentsByTask.get(task.sourceTaskId ?? task.id) ?? [];
    const folderTitle = list?.folderId
      ? (folderById.get(list.folderId)?.title ?? null)
      : null;
    const frontmatter = buildFrontmatter(
      task,
      list?.title ?? null,
      folderTitle,
    );
    const body = rewriteBody(
      task.content ?? "",
      task,
      attachmentsForTask,
      attachmentFileById,
      "../".repeat(mdPath.split("/").length - 1),
    );

    const prefix = "../".repeat(mdPath.split("/").length - 1);
    const attachmentLinks = attachmentsForTask.map((att) => {
      const name = att.name.replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&");
      const file = attachmentFileById.get(att.id);
      return file
        ? `- [${name}](<${prefix}${file}>)`
        : `- ${name}（${att.skippedByUser ? "未选入" : "未能下载"}）`;
    });
    const attachmentSection = attachmentLinks.length
      ? `\n## 附件\n\n${attachmentLinks.join("\n")}`
      : "";

    const heading = `# ${task.title}`;
    const text = [
      frontmatter,
      "",
      heading,
      body ? `\n${body}` : "",
      attachmentSection,
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()
      .concat("\n");

    files.push({ path: mdPath, text });

    const attachmentIds = attachmentsForTask.map((a) => a.id);
    manifestTasks.push({
      id: task.id,
      sourceTaskId: task.sourceTaskId,
      ...(input.apiTaskIds?.has(task.id)
        ? { apiTaskId: input.apiTaskIds.get(task.id)! }
        : {}),
      title: task.title,
      kind: task.kind,
      status: task.status,
      listId: task.listId,
      file: mdPath,
      attachmentIds,
    });
  }

  const manifestProjects: ManifestProject[] = input.csv.lists.map((l) => ({
    id: l.id,
    title: l.title,
    folderId: l.folderId,
  }));

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    tool: { name: "ticktick-export", version: input.toolVersion },
    source: {
      host: input.host.id,
      csvPath: input.csvPath,
      ...(input.rawCsv !== undefined ? { csvFile: "backup.csv" as const } : {}),
      ...(input.rawApiJson !== undefined
        ? { method: "api" as const, apiFile: "api-snapshot.json" as const }
        : {}),
      withImages: input.withImages,
      imagesVerifiedHost: input.host.imagesVerified,
    },
    counts: {
      tasks: manifestTasks.length,
      projects: manifestProjects.length,
      attachments: manifestAttachments.length,
      attachmentsDownloaded,
    },
    projects: manifestProjects,
    tasks: manifestTasks,
    attachments: manifestAttachments,
    gaps,
  };

  files.push({
    path: "manifest.json",
    text: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  return { files, binaries, diskFiles, manifest };
}
