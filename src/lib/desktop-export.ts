/** Native transport only; parsing, identity matching and vault layout stay shared. */
import { readApiBackup, type ApiBackup } from "./api-backup.js";
import { parseDidaCsv, type CsvParseResult } from "./csv.js";
import {
  scanAttachments,
  downloadScannedAttachments,
  type AttachmentScan,
  type EnrichResult,
  type EngineApi,
} from "./enrich.js";
import { resolveHost, type HostId } from "./host.js";
import {
  snapshotFromBatch,
  attachmentsFromTaskRecord,
  fetchCompletedWindowComplete,
  parseProjectTasksResponse,
} from "./image-api.js";
import { buildVault, type VaultPlan } from "./vault.js";
export type NativeBridge = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
export type ExportStage = "preparing" | "scanning" | "downloading" | "packing";
export interface DesktopExportOptions {
  destination?: string;
  scanned?: DesktopScan;
  selectedAttachmentKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
  previous?: EnrichResult;
  rawCsv?: string;
  onProgress?: (stage: ExportStage, message: string) => void;
  onEnriched?: (result: EnrichResult, rawCsv: string | undefined) => void;
  onPlan?: (plan: VaultPlan) => void;
}
export interface DesktopScan {
  hostId: HostId;
  csv: CsvParseResult;
  rawCsv: string | undefined;
  apiBackup?: ApiBackup;
  scan: AttachmentScan;
  engine: EngineApi;
}
export async function scanDesktop(
  hostId: HostId,
  invoke: NativeBridge,
  options: DesktopExportOptions = {},
): Promise<DesktopScan> {
  const host = resolveHost(hostId);
  const progress = options.onProgress ?? (() => {});
  const active = () => {
    if (options.signal?.aborted) throw Error("导出已取消");
  };
  const request = async (path: string) => {
    active();
    const response = JSON.parse(
      await invoke<string>("api_json", { path }),
    ) as unknown;
    if (response && typeof response === "object" && "errorCode" in response) {
      const code = String(response.errorCode)
        .replace(/[^a-zA-Z0-9_]/g, "")
        .slice(0, 80);
      throw Error(`官方接口错误：${code}`);
    }
    return response;
  };
  active();
  await invoke("begin_export");
  active();
  progress("preparing", "正在生成官方备份…");
  let rawCsv = options.rawCsv;
  let apiBackup: ApiBackup | undefined;
  if (rawCsv === undefined) {
    const useApi = async () => {
      progress("preparing", "官方 CSV 暂不可用，正在读取任务与附件备份…");
      apiBackup = await readApiBackup(request, (message) =>
        progress("preparing", message),
      );
    };
    if (
      options.previous?.gaps.some(
        (g) => g.code === "official_backup_unavailable",
      )
    ) {
      await useApi();
    } else {
      try {
        await request("/api/v2/data/export/auto");
        const response = await request("/api/v2/data/export");
        if (typeof response !== "string")
          throw Error("官方备份尚未返回CSV，请稍后重试。");
        rawCsv = response;
      } catch (error) {
        active();
        const message = error instanceof Error ? error.message : String(error);
        // Only a known backup quota/server failure enables fallback; auth and malformed data still fail.
        if (!/export_too_many_times|官方接口返回 HTTP 5\d\d/.test(message))
          throw error;
        await useApi();
      }
    }
  }
  const csv = apiBackup?.csv ?? parseDidaCsv(rawCsv!);
  active();
  const engine: EngineApi = {
    loadSnapshot: async () =>
      snapshotFromBatch(
        apiBackup?.batch ?? (await request("/api/v2/batch/check/0")),
        {
          host,
          cookies: {},
          fetchImpl: fetch,
        },
      ),
    fetchCompletedTasksInWindow: (_snapshot, projectId, center, opts = {}) =>
      apiBackup
        ? Promise.resolve(
            apiBackup.records.filter(
              (r) =>
                r.projectId === projectId &&
                Number(r.status) !== 0 &&
                (opts.status
                  ? Number(r.status) === -1
                  : Number(r.status) !== -1),
            ),
          )
        : fetchCompletedWindowComplete(projectId, center, opts, request),
    fetchProjectTasks: async (_snapshot, projectId) =>
      apiBackup
        ? apiBackup.records.filter((r) => r.projectId === projectId)
        : parseProjectTasksResponse(
            await request(
              `/api/v2/project/${encodeURIComponent(projectId)}/tasks`,
            ),
          ),
    attachmentsFromTaskRecord,
    downloadAttachmentBytes: async () => {
      throw Error("Native disk transport required");
    },
    downloadAttachmentFile: async (_snapshot, a) => {
      const file = await invoke<{
        diskHandle: string;
        size: number;
        type: string;
      }>("download_attachment", {
        projectId: a.projectId,
        taskId: a.taskId,
        attachmentId: a.id,
        ...(a.size != null ? { expectedSize: a.size } : {}),
      });
      return { handle: file.diskHandle, size: file.size, type: file.type };
    },
  };
  progress("scanning", `正在扫描 ${csv.tasks.length} 个任务及附件…`);
  const scan = await scanAttachments(csv, engine, {
    signal: options.signal,
    onProgress: (message) => progress("scanning", message),
  });
  active();
  return { hostId, csv, rawCsv, apiBackup, scan, engine };
}

export async function exportDesktop(
  hostId: HostId,
  invoke: NativeBridge,
  options: DesktopExportOptions = {},
): Promise<{
  path: string | null;
  plan: VaultPlan;
  enriched: EnrichResult;
  rawCsv: string | undefined;
}> {
  const active = () => {
    if (options.signal?.aborted) throw Error("导出已取消");
  };
  active();
  if (options.scanned && options.scanned.hostId !== hostId)
    throw Error("账号站点已变更，请重新扫描");
  const scanned =
    options.scanned ?? (await scanDesktop(hostId, invoke, options));
  if (options.scanned) await invoke("begin_export");
  active();
  const { csv, rawCsv, apiBackup, engine, scan } = scanned;
  const host = resolveHost(hostId);
  const progress = options.onProgress ?? (() => {});
  const enriched = await downloadScannedAttachments(scan, engine, {
    signal: options.signal,
    previous: options.previous,
    selectedAttachmentKeys: options.selectedAttachmentKeys,
    onProgress: (message) => progress("downloading", message),
  });
  if (apiBackup)
    enriched.gaps.push(...apiBackup.gaps, {
      code: "official_backup_unavailable",
      message:
        "官方 CSV 因生成频率限制或服务器错误未取得。本次已从任务接口导出 Markdown 和附件，并保留 api-snapshot.json 原始数据；不等同于官方 CSV 备份。",
    });
  options.onEnriched?.(enriched, rawCsv);
  active();
  const gaps = [...enriched.gaps];
  const plan = buildVault({
    csv,
    host,
    csvPath: apiBackup ? "api-snapshot.json" : "backup.csv",
    rawCsv,
    ...(apiBackup ? { rawApiJson: apiBackup.rawJson } : {}),
    withImages: true,
    toolVersion: "1.1.0",
    attachmentsByTask: enriched.attachmentsByTask,
    apiTaskIds: enriched.apiTaskIds,
    gaps,
  });
  options.onPlan?.(plan);
  progress(
    "packing",
    `正在保存ZIP：${plan.manifest.counts.tasks} 个任务，${plan.manifest.counts.attachmentsDownloaded} 个附件…`,
  );
  active();
  const path = await saveDesktopPlan(plan, invoke, options.destination);
  // A confirmed native commit is authoritative, even if cancellation arrived afterwards.
  return { path, plan, enriched, rawCsv };
}

/** Save an already prepared export without contacting the source account again. */
export function saveDesktopPlan(
  plan: VaultPlan,
  invoke: NativeBridge,
  destination?: string,
): Promise<string | null> {
  return invoke<string | null>("save_zip", {
    files: plan.files.map((f) => ({ path: f.path, content: f.text })),
    attachments: plan.diskFiles.map((f) => ({
      path: f.path,
      diskHandle: f.handle,
    })),
    suggestedName: `${plan.manifest.source.host}-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    ...(destination ? { destination } : {}),
  });
}
