/**
 * Manifest: the machine-readable source of truth for an export.
 *
 * Downstream consumers (e.g. re-import into another app) should read `manifest.json` and
 * NEVER reverse-parse the generated markdown. The markdown is for humans /
 * Obsidian; the manifest is the stable, versioned contract.
 */

import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = 1;

export const ManifestAttachmentSchema = z.object({
  /** Attachment id from the source API. */
  id: z.string(),
  taskId: z.string(),
  name: z.string(),
  type: z.string(),
  /** Path relative to vault root, e.g. "attachments/<id>.png". null = not downloaded. */
  file: z.string().nullable(),
  size: z.number().optional(),
});

export const ManifestTaskSchema = z.object({
  id: z.string(),
  sourceTaskId: z.string().nullable(),
  title: z.string(),
  kind: z.enum(["task", "note"]),
  status: z.enum(["todo", "done", "canceled"]),
  listId: z.string().nullable(),
  /** Path relative to vault root of the generated markdown file. */
  file: z.string(),
  /** Attachment ids attached to this task (may be empty). */
  attachmentIds: z.array(z.string()),
});

export const ManifestProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
});

export const ManifestGapSchema = z.object({
  /** Stable machine code for the gap kind. */
  code: z.enum([
    "images_skipped_not_macos",
    "images_skipped_overseas_unverified",
    "images_disabled",
    "image_engine_failed",
    "task_attachment_unreachable",
    "attachment_download_failed",
    "account_mismatch",
  ]),
  /** Human-readable explanation. */
  message: z.string(),
  /** Optional related task/attachment ids. */
  taskId: z.string().optional(),
  attachmentId: z.string().optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  generatedAt: z.string(),
  tool: z.object({
    name: z.literal("ticktick-export"),
    version: z.string(),
  }),
  source: z.object({
    host: z.enum(["dida365", "ticktick"]),
    csvPath: z.string(),
    withImages: z.boolean(),
    imagesVerifiedHost: z.boolean(),
  }),
  counts: z.object({
    tasks: z.number(),
    projects: z.number(),
    attachments: z.number(),
    attachmentsDownloaded: z.number(),
  }),
  projects: z.array(ManifestProjectSchema),
  tasks: z.array(ManifestTaskSchema),
  attachments: z.array(ManifestAttachmentSchema),
  /** Honest list of what we could NOT capture. */
  gaps: z.array(ManifestGapSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestGap = z.infer<typeof ManifestGapSchema>;
export type ManifestAttachment = z.infer<typeof ManifestAttachmentSchema>;
export type ManifestTask = z.infer<typeof ManifestTaskSchema>;
export type ManifestProject = z.infer<typeof ManifestProjectSchema>;
