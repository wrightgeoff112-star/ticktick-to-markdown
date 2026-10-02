import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  exportDesktop,
  scanDesktop,
  saveDesktopPlan,
  type DesktopScan,
  type NativeBridge,
  type ExportStage,
} from "../../src/lib/desktop-export.js";
import {
  estimateAttachments,
  filterAttachments,
  newestAttachments,
  type AttachmentFilter,
} from "../../src/lib/attachment-selection.js";
import type { EnrichResult } from "../../src/lib/enrich.js";
import type { VaultPlan } from "../../src/lib/vault.js";
import { waitForDesktopLogin } from "../../src/lib/desktop-login.js";
import { type HostId } from "../../src/lib/host.js";

const $ = (id: string) => document.getElementById(id)!;
const button = (id: string) => $(id) as HTMLButtonElement;
const select = (id: string) => $(id) as HTMLSelectElement;
const input = (id: string) => $(id) as HTMLInputElement;
const native = isTauri();
const bridge: NativeBridge = invoke;
type View = "setup" | "selection" | "save" | "progress" | "result";
let view: View = "setup",
  activeStep = 0,
  isBusy = false;
let controller: AbortController | undefined;
let scanned: DesktopScan | undefined;
let previous: EnrichResult | undefined;
let pendingPlan: VaultPlan | undefined;
let saved: { plan: VaultPlan; path: string; size?: number } | undefined;
let selected = new Set<string>(),
  pageIndex = 0;
const pageSize = 10;

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const now = new Date(),
  from = new Date(now);
from.setDate(from.getDate() - 30);
input("date-from").value = localDate(from);
input("date-to").value = localDate(now);
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function filter(): AttachmentFilter {
  return {
    scope: select("scope").value as AttachmentFilter["scope"],
    listId: select("list-filter").value || null,
    includeNotes: input("include-notes").checked,
    dateField: select("date-field").value as "created" | "completed",
    status: select("task-status").value as AttachmentFilter["status"],
    from: input("date-from").value,
    to: input("date-to").value,
  };
}
function invalidDates() {
  return (
    select("scope").value === "custom" &&
    !!input("date-from").value &&
    !!input("date-to").value &&
    input("date-from").value > input("date-to").value
  );
}
const eligible = () =>
  newestAttachments(filterAttachments(scanned?.scan.entries ?? [], filter()));
const chosen = () => eligible().filter((e) => selected.has(e.key));
function counts(scan = scanned) {
  const tasks = scan?.csv.tasks ?? [];
  return `${tasks.filter((t) => t.kind === "task").length.toLocaleString()} 个任务 · ${tasks.filter((t) => t.kind === "note").length.toLocaleString()} 篇笔记`;
}
function show(next: View, step: number) {
  view = next;
  activeStep = step;
  $("app").dataset.view = next;
  for (const id of ["setup", "selection", "save", "progress", "result"])
    $(`${id}-view`).hidden = id !== next;
  updateSteps();
}
function updateSteps() {
  ["step-setup", "step-selection", "step-save"].forEach((id, i) => {
    const node = button(id);
    node.disabled =
      isBusy || (i > 0 && !scanned) || (i === 2 && invalidDates());
    if (i === activeStep) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
    node.dataset.done = String(i < activeStep || view === "result");
    node.querySelector(".step-number")!.textContent =
      i < activeStep || view === "result" ? "✓" : String(i + 1);
  });
}
function busy(value: boolean, cancellable = true) {
  isBusy = value;
  for (const id of ["start", "next", "save", "retry", "reveal"])
    button(id).disabled = value || !native || (id === "next" && invalidDates());
  select("host").disabled = value;
  $("cancel").hidden = !value || !cancellable;
  button("cancel").disabled = false;
  updateSteps();
}
function clearMessage() {
  $("message-bar").hidden = true;
  $("error-details").hidden = true;
  $("scan-details").hidden = true;
}
function message(copy: string, error?: unknown) {
  $("message-bar").hidden = false;
  $("message-text").textContent = copy;
  $("scan-details").hidden = true;
  $("error-details").hidden = error === undefined;
  if (error !== undefined)
    $("error-text").textContent =
      error instanceof Error ? error.message : String(error);
}
function showGaps(gaps: VaultPlan["manifest"]["gaps"]) {
  $("gaps").replaceChildren(
    ...gaps.map((g) => {
      const li = document.createElement("li");
      li.textContent = g.message;
      return li;
    }),
  );
  (document.querySelector("#gap-dialog p") as HTMLElement).textContent =
    "文字与已下载附件仍会保留。用户未选入的附件不属于失败项。";
  ($("gap-dialog") as HTMLDialogElement).showModal();
}
function scanWarning() {
  if (!scanned) return;
  const gaps = [...scanned.scan.gaps, ...(scanned.apiBackup?.gaps ?? [])];
  if (gaps.length || scanned.apiBackup) {
    message(
      gaps.length
        ? "部分附件信息未能核实，已显示取得的目录。"
        : "已从任务接口取得备份，官方 CSV 暂不可用。",
    );
    $("scan-details").hidden = false;
  }
}
function markSelectionChanged() {
  // A prepared ZIP must never be reused after its attachment selection changes.
  pendingPlan = undefined;
}
function renderSelection() {
  const range = eligible(),
    list = range.filter((e) => selected.has(e.key));
  const estimate = estimateAttachments(list),
    f = filter();
  $("custom-filters").hidden = f.scope !== "custom";
  $("date-error").hidden = !invalidDates();
  $("notes-option").hidden =
    f.scope === "none" || (f.scope === "custom" && f.dateField === "completed");
  $("notes-copy").textContent = ["recent", "active", "custom"].includes(f.scope)
    ? "保留范围内笔记附件"
    : "同时保留笔记附件";
  $("selection-summary").textContent = list.length
    ? `已选 ${list.length} 个附件 · 预估 ${formatBytes(estimate.knownBytes)}`
    : "仅导出全部任务与笔记文字";
  $("unknown-size").hidden = !estimate.unknownCount;
  $("unknown-size").textContent =
    `另有 ${estimate.unknownCount} 个附件大小未知，未计入预估。`;
  input("select-all").checked = !!range.length && list.length === range.length;
  input("select-all").indeterminate =
    !!list.length && list.length < range.length;
  input("select-all").disabled = !range.length;
  $("select-all-label").textContent = `全选（${range.length}）`;
  input("attachment-limit").max = String(Math.max(1, range.length));
  button("apply-limit").disabled = !range.length;
  const totalPages = Math.max(1, Math.ceil(range.length / pageSize));
  pageIndex = Math.min(pageIndex, totalPages - 1);
  const nodes = range
    .slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
    .map((entry) => {
      const row = document.createElement("label");
      row.className = "attachment-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selected.has(entry.key);
      check.setAttribute("aria-label", `选择 ${entry.meta.name}`);
      const name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent = entry.meta.name;
      name.title = entry.meta.name;
      const task = document.createElement("span");
      task.className = "attachment-task";
      task.textContent = `${entry.task.title} · ${scanned!.csv.lists.find((l) => l.id === entry.task.listId)?.title ?? "收集箱"}`;
      task.title = task.textContent;
      const size = document.createElement("span");
      size.className = "attachment-size";
      size.textContent = estimateAttachments([entry]).unknownCount
        ? "大小未知"
        : formatBytes(entry.meta.size!);
      check.addEventListener("change", () => {
        check.checked ? selected.add(entry.key) : selected.delete(entry.key);
        markSelectionChanged();
        renderSelection();
      });
      row.append(check, name, task, size);
      return row;
    });
  $("attachment-list").replaceChildren(...nodes);
  if (!nodes.length) {
    const p = document.createElement("p");
    p.className = "empty-list";
    p.textContent =
      f.scope === "none"
        ? "不下载附件，仍会导出全部文字。"
        : "这个范围没有附件。";
    $("attachment-list").append(p);
  }
  $("page-info").textContent = range.length
    ? `共 ${range.length} 个 · 每页 ${pageSize} 个`
    : "";
  $("page-number").textContent = `${pageIndex + 1} / ${totalPages}`;
  button("page-prev").disabled = pageIndex === 0;
  button("page-next").disabled = pageIndex === totalPages - 1;
  button("next").disabled = invalidDates() || !native;
  updateSteps();
}
function reselect() {
  selected = new Set(eligible().map((e) => e.key));
  pageIndex = 0;
  markSelectionChanged();
  renderSelection();
}
function selection() {
  if (!scanned || isBusy) return;
  clearMessage();
  show("selection", 1);
  renderSelection();
  scanWarning();
}
function suggestedName() {
  return `${select("host").value}-backup-${localDate(new Date())}.zip`;
}
function prepare() {
  if (!scanned || isBusy || invalidDates()) return;
  clearMessage();
  show("save", 2);
  const list = chosen(),
    estimate = estimateAttachments(list);
  $("save-summary").textContent = `${counts()} · ${list.length} 个附件`;
  $("save-name").textContent = suggestedName();
  $("save-estimate").textContent = list.length
    ? `所选附件预估 ${formatBytes(estimate.knownBytes)}`
    : "仅保存文字备份";
  $("save-unknown").hidden = !estimate.unknownCount;
  $("save-unknown").textContent =
    `另有 ${estimate.unknownCount} 个附件大小未知，未计入预估。`;
  button("save").textContent = pendingPlan
    ? "保存已准备的备份"
    : "选择位置并保存";
}
function progress(stage: "login" | ExportStage, copy: string) {
  const titles = {
    login: "等待官方登录",
    preparing: "正在获取任务与笔记…",
    scanning: "正在扫描附件…",
    downloading: "正在下载所选附件…",
    packing: "正在生成 Markdown 并保存 ZIP…",
  };
  $("progress-title").textContent = titles[stage];
  $("progress-status").textContent = copy
    .replace(/已下载附件:(\d+)\/(\d+)/, "$1 / $2 个附件已下载")
    .replace(/扫描任务:(\d+)\/(\d+)/, "$1 / $2 个任务已扫描");
  $("show-login").hidden = stage !== "login";
  $("check-login").hidden = stage !== "login";
  if (stage === "downloading") {
    $("download-track").hidden = false;
    const match = copy.match(/已下载附件:(\d+)\/(\d+)/);
    if (match) {
      const percent = Number(match[2])
        ? Math.round((Number(match[1]) / Number(match[2])) * 100)
        : 100;
      $("download-fill").style.width = `${percent}%`;
      $("download-track").setAttribute("aria-valuenow", String(percent));
    }
  } else $("download-track").hidden = true;
}
async function loginAndScan() {
  if (isBusy || !native) return;
  const hostId = select("host").value as HostId;
  controller = new AbortController();
  const signal = controller.signal;
  busy(true);
  clearMessage();
  show("progress", 0);
  scanned = undefined;
  previous = undefined;
  pendingPlan = undefined;
  saved = undefined;
  $("connection").hidden = true;
  try {
    await bridge("cleanup");
    await bridge("begin_export");
    if (signal.aborted) throw Error("已取消");
    progress(
      "login",
      "请在官方窗口完成登录。登录后会自动扫描，也可点击下方按钮继续。",
    );
    await bridge("open_login", { host: hostId });
    await waitForDesktopLogin(hostId, bridge, {
      signal,
      subscribeRetry: (retry) => {
        button("check-login").addEventListener("click", retry);
        return () => button("check-login").removeEventListener("click", retry);
      },
      onChecking: (checking) => {
        button("check-login").disabled = checking;
        button("check-login").textContent = checking
          ? "正在检查登录…"
          : "我已登录，开始扫描";
        if (checking) progress("login", "正在检查官方登录状态…");
      },
      onError: (error) => {
        $("progress-status").textContent = error;
        $("progress-title").textContent = /尚未登录|登录失效|需要验证/.test(
          error,
        )
          ? "等待官方登录"
          : "暂时无法开始扫描";
      },
    });
    if (signal.aborted) throw Error("已取消");
    await bridge("hide_login");
    $("connection").hidden = false;
    scanned = await scanDesktop(hostId, bridge, {
      signal,
      onProgress: progress,
    });
    select("list-filter").replaceChildren(
      new Option("所有清单", ""),
      ...scanned.csv.lists.map(
        (l) =>
          new Option(
            l.folderId
              ? `${scanned!.csv.folders.find((f) => f.id === l.folderId)?.title ?? ""} / ${l.title}`
              : l.title,
            l.id,
          ),
      ),
    );
    selected = new Set(scanned.scan.entries.map((e) => e.key));
    pageIndex = 0;
    // Apply the visible filters rather than selecting invisible out-of-range entries.
    selected = new Set(eligible().map((e) => e.key));
    busy(false);
    selection();
  } catch (error) {
    show("setup", 0);
    message(
      signal.aborted
        ? "扫描已取消，可以重新登录并扫描。"
        : "无法取得备份，请检查登录状态与网络后重试。",
      signal.aborted ? undefined : error,
    );
  } finally {
    controller = undefined;
    busy(false);
  }
}
function presentSaved() {
  if (!saved || isBusy) return;
  const { plan, path, size } = saved,
    m = plan.manifest;
  show("result", 2);
  clearMessage();
  const gaps = m.gaps.filter((g) => g.code !== "official_backup_unavailable");
  $("result-title").textContent = gaps.length
    ? "备份已保存，部分内容待补齐"
    : "备份已保存";
  $("result-title").dataset.saved = "true";
  const taskCount = m.tasks.filter((t) => t.kind === "task").length,
    noteCount = m.tasks.filter((t) => t.kind === "note").length;
  const omitted = m.attachments.filter((a) => a.skippedByUser).length;
  $("result-summary").textContent =
    `${taskCount.toLocaleString()} 个任务 · ${noteCount.toLocaleString()} 篇笔记 · ${m.counts.attachmentsDownloaded} 个附件已保存${omitted ? ` · ${omitted} 个未选入` : ""}`;
  const parts = path.split(/[\\/]/);
  $("destination-name").textContent = parts.pop() || path;
  $("destination-directory").textContent =
    parts.join(path.includes("\\") ? "\\" : "/") || path;
  $("result-size").textContent = size === undefined ? "" : formatBytes(size);
  $("result-description").textContent =
    m.source.method === "api"
      ? "解压 ZIP 后即可阅读。官方 CSV 暂不可用，已保留原始接口数据。"
      : "解压 ZIP 后即可阅读笔记，也可在 Obsidian 中打开。";
  button("retry").hidden = !gaps.length;
  button("gap-summary").hidden = !m.gaps.length;
  $("result-action-status").textContent = "";
}
async function save() {
  if (isBusy || !scanned || !native || invalidDates()) return;
  const hostId = scanned.hostId,
    selectionKeys = new Set(chosen().map((e) => e.key));
  busy(true, false);
  clearMessage();
  let signal: AbortSignal | undefined;
  try {
    // The native picker grants a one-use destination. Canceling it starts no downloads.
    const path = await bridge<string | null>("choose_save_location", {
      suggestedName: suggestedName(),
    });
    if (!path) return;
    controller = new AbortController();
    signal = controller.signal;
    busy(true);
    show("progress", 2);
    $("download-fill").style.width = "0%";
    $("download-track").setAttribute("aria-valuenow", "0");
    let plan: VaultPlan, savedPath: string | null;
    if (pendingPlan) {
      plan = pendingPlan;
      await bridge("begin_export");
      progress("packing", "正在保存已准备的备份，无需重新扫描或下载。");
      savedPath = await saveDesktopPlan(plan, bridge, path);
    } else {
      progress(
        "downloading",
        selectionKeys.size
          ? `0 / ${selectionKeys.size} 个附件已下载`
          : "正在保存全部文字，不下载附件。",
      );
      const result = await exportDesktop(hostId, bridge, {
        scanned,
        selectedAttachmentKeys: selectionKeys,
        previous,
        destination: path,
        signal,
        onProgress: progress,
        onEnriched: (e) => {
          previous = e;
        },
        onPlan: (p) => {
          pendingPlan = p;
        },
      });
      plan = result.plan;
      savedPath = result.path;
    }
    if (savedPath) {
      saved = { plan, path: savedPath };
      try {
        saved.size = await bridge<number>("saved_file_size");
      } catch {
        /* Saved path is authoritative. */
      }
      busy(false);
      presentSaved();
    } else {
      busy(false);
      prepare();
      message("保存已取消，已准备的数据仍保留，可以再次选择位置。");
    }
  } catch (error) {
    busy(false);
    prepare();
    message(
      signal?.aborted
        ? "导出已取消，已下载附件可在本次会话中复用。"
        : !signal
          ? "未能选择保存位置，请重新选择。"
          : pendingPlan
            ? "备份已准备，保存失败。请重新选择位置保存。"
            : "附件导出未完成，请检查网络后再次保存。",
      signal?.aborted ? undefined : error,
    );
  } finally {
    controller = undefined;
    busy(false);
  }
}
async function retrySaved() {
  if (isBusy || !scanned || !saved) return;
  pendingPlan = undefined;
  // Download failures can retry against the existing directory. Metadata failures
  // require another scan so previously unreachable attachments can be discovered.
  if (scanned.scan.gaps.length || scanned.apiBackup?.gaps.length) {
    const original = scanned,
      known = new Set(original.scan.entries.map((e) => e.key));
    controller = new AbortController();
    const signal = controller.signal;
    busy(true);
    clearMessage();
    show("progress", 2);
    try {
      const refreshed = await scanDesktop(original.hostId, bridge, {
        rawCsv: original.rawCsv,
        previous,
        signal,
        onProgress: progress,
      });
      scanned = refreshed;
      for (const entry of eligible())
        if (!known.has(entry.key)) selected.add(entry.key);
    } catch (error) {
      busy(false);
      prepare();
      message(
        signal.aborted
          ? "重试已取消，原有备份仍可使用。"
          : "未能重新扫描，请检查网络与账号连接。",
        signal.aborted ? undefined : error,
      );
      return;
    } finally {
      controller = undefined;
      busy(false);
    }
  }
  prepare();
  await save();
}
button("start").addEventListener("click", () => void loginAndScan());
button("next").addEventListener("click", prepare);
button("save").addEventListener("click", () => void save());
button("retry").addEventListener("click", () => void retrySaved());
button("step-setup").addEventListener("click", () => {
  clearMessage();
  show("setup", 0);
});
button("step-selection").addEventListener("click", selection);
button("step-save").addEventListener("click", () =>
  saved && pendingPlan === saved.plan ? presentSaved() : prepare(),
);
for (const id of [
  "scope",
  "list-filter",
  "include-notes",
  "date-field",
  "task-status",
  "date-from",
  "date-to",
])
  $(id).addEventListener("change", reselect);
input("select-all").addEventListener("change", () => {
  for (const entry of eligible())
    input("select-all").checked
      ? selected.add(entry.key)
      : selected.delete(entry.key);
  markSelectionChanged();
  renderSelection();
});
button("apply-limit").addEventListener("click", () => {
  if (!input("attachment-limit").reportValidity()) return;
  selected = new Set(
    eligible()
      .slice(0, Number(input("attachment-limit").value))
      .map((e) => e.key),
  );
  markSelectionChanged();
  renderSelection();
});
button("page-prev").addEventListener("click", () => {
  pageIndex = Math.max(0, pageIndex - 1);
  renderSelection();
  $("attachment-list").scrollTop = 0;
});
button("page-next").addEventListener("click", () => {
  pageIndex++;
  renderSelection();
  $("attachment-list").scrollTop = 0;
});
button("cancel").addEventListener("click", () => {
  controller?.abort();
  button("cancel").disabled = true;
  $("progress-status").textContent = "正在停止当前操作…";
  void bridge("cancel_export").catch((error) =>
    message("取消请求失败，请稍后重试。", error),
  );
});
button("show-login").addEventListener(
  "click",
  () =>
    void bridge("show_login").catch((error) =>
      message("无法打开官方登录窗口。", error),
    ),
);
button("reveal").addEventListener("click", async () => {
  if (!saved) return;
  $("result-action-status").textContent = "";
  try {
    await bridge("reveal_export");
  } catch (error) {
    $("result-action-status").textContent =
      error instanceof Error ? error.message : String(error);
  }
});
select("host").addEventListener("change", async () => {
  scanned = undefined;
  previous = undefined;
  pendingPlan = undefined;
  saved = undefined;
  selected.clear();
  $("connection").hidden = true;
  clearMessage();
  updateSteps();
  if (native) {
    busy(true, false);
    try {
      await bridge("cleanup");
    } catch (error) {
      message("无法清理上次会话。", error);
    } finally {
      busy(false);
    }
  }
});
button("gap-summary").addEventListener("click", () => {
  if (saved) showGaps(saved.plan.manifest.gaps);
});
button("scan-details").addEventListener("click", () => {
  if (scanned)
    showGaps([
      ...scanned.scan.gaps,
      ...(scanned.apiBackup?.gaps ?? []),
      ...(scanned.apiBackup
        ? [
            {
              code: "official_backup_unavailable" as const,
              message:
                "官方 CSV 暂不可用，本次从任务接口取得文字与附件，保存时附原始 JSON。",
            },
          ]
        : []),
    ]);
});
button("error-details").addEventListener("click", () =>
  ($("error-dialog") as HTMLDialogElement).showModal(),
);
if (!native) $("preview-notice").hidden = false;
busy(false);
show("setup", 0);
