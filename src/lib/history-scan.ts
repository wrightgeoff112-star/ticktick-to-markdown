/** Metadata-only historical scan. CSV density bounds requests, not the user's selection. */
import type { CsvTask } from "./csv.js";
import type { RawRecord } from "./image-api.js";
import type { ManifestGap } from "./manifest.js";

export const HISTORY_PAGE_SIZE = 600;
const TARGET_ROWS = 450;
const CONCURRENCY = 3;
interface Window {
  from: number;
  to: number;
  status: "Completed" | "Abandoned";
  times?: number[];
}
export interface HistoryResult {
  records: RawRecord[];
  gaps: ManifestGap[];
}
export interface HistoryOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
const stamp = (second: number) =>
  new Date(second * 1000).toISOString().slice(0, 19).replace("T", " ");
const gap = (message: string): ManifestGap => ({
  code: "completed_scan_incomplete",
  message,
});

export async function scanHistory(
  tasks: readonly CsvTask[] | undefined,
  request: (path: string) => Promise<unknown>,
  options: HistoryOptions = {},
): Promise<HistoryResult> {
  const active = () => {
    if (options.signal?.aborted)
      throw options.signal.reason ?? Error("扫描已取消");
  };
  active();
  const windows: Window[] = [],
    gaps: ManifestGap[] = [],
    records = new Map<string, RawRecord>();
  for (const status of ["Completed", "Abandoned"] as const) {
    if (!tasks) {
      windows.push({
        from: 0,
        to: Math.floor(Date.now() / 1000) + 86400,
        status,
      });
      continue;
    }
    const selected = tasks.filter(
      (t) => t.status === (status === "Completed" ? "done" : "canceled"),
    );
    const times = selected
      .map((t) =>
        t.completedTime ? Math.floor(Date.parse(t.completedTime) / 1000) : NaN,
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (times.length !== selected.length)
      gaps.push(
        gap(
          `${selected.length - times.length} 条历史任务缺少有效完成时间，附件覆盖未核实。`,
        ),
      );
    let start = 0;
    while (start < times.length) {
      let end = Math.min(start + TARGET_ROWS, times.length);
      // A second is indivisible in the source API. Never drop its extra tasks at a boundary.
      while (end < times.length && times[end] === times[end - 1]) end++;
      const part = times.slice(start, end);
      windows.push({
        from: part[0]!,
        to: part[part.length - 1]!,
        status,
        times: part,
      });
      start = end;
    }
  }
  let calls = 0,
    cursor = 0;
  async function visit(window: Window): Promise<void> {
    active();
    if (++calls > 4096) throw Error("历史查询超过安全上限，覆盖尚未核实");
    const params = new URLSearchParams({
      from: stamp(window.from),
      to: stamp(window.to + 1),
      status: window.status,
      limit: String(HISTORY_PAGE_SIZE),
    });
    const response = await request(`/api/v2/project/all/closed?${params}`);
    active();
    const rows = Array.isArray(response)
      ? response
      : response &&
          typeof response === "object" &&
          Array.isArray((response as RawRecord).tasks)
        ? (response as RawRecord).tasks
        : null;
    if (
      !Array.isArray(rows) ||
      rows.some((r) => !r || typeof r !== "object" || typeof r.id !== "string")
    )
      throw Error("历史接口返回无效数据");
    const received = rows as RawRecord[];
    for (const r of received) {
      if (
        r.status !== undefined &&
        Number(r.status) !== (window.status === "Completed" ? 2 : -1)
      )
        throw Error("历史接口未遵循状态筛选，覆盖尚未核实");
      if (typeof r.completedTime === "string") {
        const t = Math.floor(Date.parse(r.completedTime) / 1000);
        if (!Number.isFinite(t) || t < window.from || t > window.to + 1)
          throw Error("历史接口未遵循时间筛选，覆盖尚未核实");
      }
    }
    // API endpoints accept seconds while records may carry milliseconds. Query through
    // the next second, then discard its boundary rows; windows remain logically disjoint.
    const valid = received.filter(
      (r) =>
        typeof r.completedTime !== "string" ||
        Date.parse(r.completedTime) < (window.to + 1) * 1000,
    );
    for (const r of valid) records.set(String(r.id), r);
    options.onProgress?.(
      `已取得 ${records.size.toLocaleString()} 条历史任务信息 · ${calls} 次查询`,
    );
    const unique = new Set(valid.map((r) => r.id)).size;
    // Without a CSV count, conservatively split at the old verified 100-row cap.
    const saturated =
      rows.length >= HISTORY_PAGE_SIZE || (!window.times && rows.length >= 100);
    const short = window.times !== undefined && unique < window.times.length;
    if (!saturated && !short) return;
    if (!rows.length) {
      gaps.push(gap("部分历史任务未返回，附件覆盖未核实。"));
      return;
    }
    if (window.to <= window.from) {
      gaps.push(gap("同一秒的历史任务未能完整取得，附件覆盖未核实。"));
      return;
    }
    const middle = Math.floor((window.from + window.to) / 2);
    for (const [from, to] of [
      [window.from, middle],
      [middle + 1, window.to],
    ]) {
      const times = window.times?.filter((t) => t >= from! && t <= to!);
      // For CSV mode only records in the backup are required, not unrelated time gaps.
      if (times && !times.length) continue;
      await visit({
        from: from!,
        to: to!,
        status: window.status,
        ...(times ? { times } : {}),
      });
    }
  }
  async function worker() {
    while (cursor < windows.length) {
      active();
      const window = windows[cursor++]!;
      try {
        await visit(window);
      } catch (error) {
        active();
        gaps.push(
          gap(
            `历史附件信息未完整读取：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker),
  );
  active();
  return { records: [...records.values()], gaps };
}
