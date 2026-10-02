import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  exportDesktop,
  saveDesktopPlan,
  type ExportStage,
  type NativeBridge,
} from "../../src/lib/desktop-export.js";
import type { EnrichResult } from "../../src/lib/enrich.js";
import type { VaultPlan } from "../../src/lib/vault.js";
import { snapshotFromBatch } from "../../src/lib/image-api.js";
import { resolveHost, type HostId } from "../../src/lib/host.js";

const $ = (id: string) => document.getElementById(id)!;
const button = (id: string) => $(id) as HTMLButtonElement;
const host = $("host") as HTMLSelectElement;
const bridge: NativeBridge = invoke;
const stages = ["login", "preparing", "attachments", "packing"] as const;
const names: Record<ExportStage, string> = {
  preparing: "正在获取任务备份",
  scanning: "正在查找任务与附件",
  downloading: "正在下载图片与文件",
  packing: "正在打包并保存",
};
let controller: AbortController | undefined;
let previous: EnrichResult | undefined;
let rawCsv: string | undefined;
let connectedHost: HostId | undefined;
let chosenPath: string | undefined;
let pendingPlan: VaultPlan | undefined;
let savedPath: string | undefined;
let activeStage = -1;
let isBusy = false;

function status(title: string, message: string, state = "idle", badge = title) {
  $("stage").textContent = title;
  $("status").textContent = message;
  $("state-badge").textContent = badge;
  $("progress-card").dataset.state = state;
}
function progress(stage: "login" | ExportStage, message: string) {
  // Scanning and downloading interleave, so they share one honest UI stage.
  activeStage = stages.indexOf(
    stage === "scanning" || stage === "downloading" ? "attachments" : stage,
  );
  document.querySelectorAll<HTMLElement>("#steps li").forEach((li, index) => {
    li.dataset.state =
      index < activeStage
        ? "done"
        : index === activeStage
          ? "active"
          : "pending";
    li.toggleAttribute("aria-current", index === activeStage);
    if (index === activeStage) li.setAttribute("aria-current", "step");
    li.querySelector(".step-marker")!.innerHTML =
      index < activeStage
        ? '<svg class="icon" aria-hidden="true"><use href="#i-check" /></svg>'
        : String(index + 1);
  });
  const title =
    activeStage === 0 ? "等待官方登录" : names[stage as ExportStage];
  status(title, message, "running", `${activeStage + 1} / 4`);
  $("show-login").hidden = activeStage !== 0;
}
function busy(value: boolean, cancellable = true) {
  isBusy = value;
  for (const id of [
    "start",
    "retry",
    "save-again",
    "choose-location",
    "reveal",
  ])
    button(id).disabled = value || !isTauri();
  host.disabled = value;
  $("cancel").hidden = !value || !cancellable;
  button("cancel").disabled = false;
  $("start").firstChild!.textContent = value
    ? "正在处理…"
    : pendingPlan
      ? "重新备份"
      : "开始备份";
  if (!value) $("show-login").hidden = true;
}
function connection() {
  const connected = connectedHost === host.value;
  $("connection").dataset.connected = String(connected);
  $("connection").hidden = !connected;
  $("connection-text").textContent = connected ? "已连接" : "";
}
function errorDetails(error: unknown) {
  $("error-details").hidden = false;
  $("error-text").textContent =
    error instanceof Error ? error.message : String(error);
}
function destination(path: string) {
  const parts = path.split(/[\\/]/);
  $("destination-name").textContent = parts.pop() || path;
  $("destination-directory").hidden = false;
  $("destination-directory").textContent =
    parts.join(path.includes("\\") ? "\\" : "/") || path;
  $("choose-location").title = path;
  $("location-action").firstChild!.textContent = "更改";
}
function suggestedName() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${host.value}-backup-${date}.zip`;
}
async function chooseLocation(): Promise<boolean> {
  const path = await bridge<string | null>("choose_save_location", {
    suggestedName: suggestedName(),
  });
  if (path) {
    chosenPath = path;
    destination(path);
    return true;
  }
  return false;
}
function takeDestination() {
  const path = chosenPath;
  chosenPath = undefined;
  return path;
}
async function wait(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(Error("导出已取消"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function reset() {
  pendingPlan = undefined;
  savedPath = undefined;
  activeStage = -1;
  $("result").hidden = true;
  $("error-details").hidden = true;
  $("error-details").removeAttribute("open");
  $("gap-details").removeAttribute("open");
  $("result-action-status").textContent = "";
  $("gaps").replaceChildren();
  $("progress-view").hidden = false;
  $("progress-title").textContent = "导出进度";
  for (const id of ["retry", "save-again", "reveal"]) $(id).hidden = true;
  document.querySelectorAll<HTMLElement>("#steps li").forEach((li, index) => {
    li.dataset.state = "pending";
    li.removeAttribute("aria-current");
    li.querySelector(".step-marker")!.textContent = String(index + 1);
  });
}
function presentPlan(plan: VaultPlan) {
  const m = plan.manifest;
  $("result").hidden = false;
  $("progress-view").hidden = true;
  $("progress-title").textContent = "导出结果";
  (document.querySelector(".metrics") as HTMLElement).hidden = false;
  $("count-tasks").textContent = m.tasks
    .filter((t) => t.kind === "task")
    .length.toLocaleString();
  $("count-notes").textContent = m.tasks
    .filter((t) => t.kind === "note")
    .length.toLocaleString();
  $("count-lists").textContent = m.counts.projects.toLocaleString();
  $("count-files").textContent =
    `${m.counts.attachmentsDownloaded} / ${m.counts.attachments}`;
  $("gaps").replaceChildren(
    ...m.gaps.map((gap) => {
      const li = document.createElement("li");
      li.textContent = gap.message;
      return li;
    }),
  );
  $("gap-details").hidden = !m.gaps.length;
  $("gap-summary").textContent = m.gaps.every(
    (g) => g.code === "official_backup_unavailable",
  ) ? "查看导出说明" : `查看 ${m.gaps.length} 项未完成记录`;
  $("retry").hidden = !m.gaps.some(
    (g) => g.code !== "official_backup_unavailable",
  );
}
async function complete(plan: VaultPlan, path: string | null) {
  presentPlan(plan);
  savedPath = path ?? undefined;
  $("reveal").hidden = !path;
  $("save-again").hidden = !!path;
  const hasContentGaps = plan.manifest.gaps.some(
    (gap) => gap.code !== "official_backup_unavailable",
  );
  $("result-title").textContent = path
    ? hasContentGaps
      ? "已保存，部分内容待补齐"
      : plan.manifest.source.method === "api"
        ? "Markdown 与附件已保存"
        : "你的笔记库已保存"
    : "备份已准备，尚未保存";
  $("result-label").textContent = path
    ? plan.manifest.gaps.length
      ? "部分完成"
      : "完整导出"
    : "待保存";
  $("summary").textContent = path
    ? plan.manifest.source.method === "api"
      ? "已保存取得的任务与附件。官方 CSV 暂不可用，已附原始数据。"
      : plan.manifest.gaps.length
        ? "已保存取得的内容，可重试未完成项目。"
        : "解压后即可阅读，也可在 Obsidian 中打开。"
    : "已准备的数据仍保留在本次会话中，再次保存无需重新扫描或下载。";
  if (path) {
    destination(path);
    document.querySelectorAll<HTMLElement>("#steps li").forEach((li) => {
      li.dataset.state = "done";
      li.removeAttribute("aria-current");
      li.querySelector(".step-marker")!.innerHTML =
        '<svg class="icon" aria-hidden="true"><use href="#i-check" /></svg>';
    });
    status(
      plan.manifest.gaps.length
        ? "部分完成，文件已保存"
        : "导出完成，文件已保存",
      "解压 ZIP 后即可阅读 Markdown，也可在 Obsidian 中打开文件夹。",
      plan.manifest.gaps.length ? "warning" : "success",
      plan.manifest.gaps.length ? "部分完成" : "已保存",
    );
  } else {
    status(
      "尚未保存",
      "保存操作已取消。点击「保存已有备份」即可再次选择位置。",
      "warning",
      "待保存",
    );
  }
  if (path) {
    try {
      const bytes = await bridge<number>("saved_file_size");
      $("result-label").textContent =
        bytes < 1024 ** 2
          ? `${(bytes / 1024).toFixed(1)} KiB`
          : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    } catch {
      /* The confirmed save remains authoritative if size lookup fails. */
    }
  }
  $("result").focus({ preventScroll: true });
}
function fail(error: unknown, cancelled: boolean) {
  $("error-details").hidden = cancelled;
  if (!cancelled) errorDetails(error);
  status(
    cancelled
      ? "本次导出已取消"
      : pendingPlan
        ? "备份已准备，但保存失败"
        : "这次导出未能完成",
    cancelled
      ? "本次会话中已下载的附件会保留，可以继续重试。"
      : pendingPlan
        ? "请重新选择有写入权限和足够空间的位置，再保存已有备份。"
        : "请检查网络与官方登录状态后重试。详细原因可在下方查看。",
    cancelled ? "warning" : "error",
    cancelled ? "已取消" : "需要处理",
  );
  $("result").hidden = false;
  $("progress-view").hidden = true;
  $("progress-title").textContent = cancelled ? "导出已取消" : "需要处理";
  if (pendingPlan) presentPlan(pendingPlan);
  else {
    (document.querySelector(".metrics") as HTMLElement).hidden = true;
    $("gap-details").hidden = true;
  }
  $("result-title").textContent = pendingPlan
    ? "已准备的备份仍在本次会话中"
    : cancelled
      ? "本次导出已停止"
      : "这次导出未能完成";
  $("result-label").textContent = "未保存";
  $("summary").textContent = pendingPlan
    ? "保存已有备份无需再次获取任务或下载附件。关闭应用前请完成保存。"
    : "重试会重新确认连接并继续导出，已下载附件可在本次会话内复用。";
  $("save-again").hidden = !pendingPlan;
  $("retry").hidden = !!pendingPlan && !pendingPlan.manifest.gaps.some(
    (gap) => gap.code !== "official_backup_unavailable",
  );
  $("reveal").hidden = true;
}
async function run(isRetry = false) {
  if (isBusy) return;
  busy(true, false);
  try {
    if (!chosenPath && !(await chooseLocation())) return;
  } catch (error) {
    errorDetails(error);
    status(
      "未能选择保存位置",
      "请重新选择保存位置后开始。",
      "error",
      "需要处理",
    );
    return;
  } finally {
    busy(false);
  }
  const hostId = host.value as HostId;
  let cachedPrevious = isRetry ? previous : undefined;
  let cachedCsv = isRetry ? rawCsv : undefined;
  reset();
  if (!isRetry) {
    previous = undefined;
    rawCsv = undefined;
  }
  controller = new AbortController();
  busy(true);
  try {
    await bridge("begin_export");
    if (controller.signal.aborted) throw Error("导出已取消");
    const confirmConnection = async () => {
      const batch = JSON.parse(
        await bridge<string>("api_json", { path: "/api/v2/batch/check/0" }),
      );
      snapshotFromBatch(batch, {
        host: resolveHost(hostId),
        cookies: {},
        fetchImpl: fetch,
      });
    };
    if (isRetry && connectedHost === hostId) {
      progress("login", "正在确认当前账号连接，将复用本次会话中已下载的附件。");
      try {
        await confirmConnection();
      } catch (error) {
        connectedHost = undefined;
        connection();
        throw error;
      }
    } else {
      // Reopening login may change accounts, so cached files cannot be reused across it.
      cachedPrevious = undefined;
      cachedCsv = undefined;
      previous = undefined;
      rawCsv = undefined;
      progress(
        "login",
        "正在打开官方页面。请完成登录、验证码或二次验证，助手会自动继续。",
      );
      await bridge("open_login", { host: hostId });
      connectedHost = undefined;
      connection();
      while (!controller.signal.aborted) {
        try {
          await confirmConnection();
          connectedHost = hostId;
          connection();
          $("error-details").hidden = true;
          break;
        } catch (error) {
          errorDetails(error);
          progress(
            "login",
            "请在官方窗口完成登录。验证成功后会自动继续；窗口关闭时可取消后重新开始。",
          );
          await wait(2000, controller.signal);
        }
      }
    }
    if (controller.signal.aborted) throw Error("导出已取消");
    await bridge("hide_login");
    const result = await exportDesktop(hostId, bridge, {
      signal: controller.signal,
      previous: cachedPrevious,
      rawCsv: cachedCsv,
      // Consume the one-use native selection only at saving, not during login or scanning.
      onEnriched: (e, c) => {
        previous = e;
        rawCsv = c;
      },
      onPlan: (plan) => {
        pendingPlan = plan;
      },
      destination: chosenPath,
      onProgress: (stage, message) => {
        progress(stage, message);
        if (stage === "packing") chosenPath = undefined;
      },
    });
    pendingPlan = result.plan;
    await complete(result.plan, result.path);
  } catch (error) {
    if (!connectedHost) connection();
    fail(error, controller.signal.aborted);
  } finally {
    controller = undefined;
    busy(false);
  }
}
button("start").addEventListener("click", () => void run());
button("retry").addEventListener("click", () => void run(true));
button("choose-location").addEventListener("click", async () => {
  busy(true, false);
  try {
    await chooseLocation();
  } catch (error) {
    errorDetails(error);
    status("未能选择保存位置", "请稍后重试。", "error", "需要处理");
  } finally {
    busy(false);
  }
});
button("save-again").addEventListener("click", async () => {
  if (!pendingPlan || isBusy) return;
  busy(true, false);
  try {
    if (!chosenPath && !(await chooseLocation())) return;
    controller = new AbortController();
    await bridge("begin_export");
    busy(true);
    progress("packing", "正在保存已准备的备份，不会重新扫描或下载。");
    const path = await saveDesktopPlan(pendingPlan, bridge, takeDestination());
    await complete(pendingPlan, path);
  } catch (error) {
    fail(error, controller?.signal.aborted ?? false);
  } finally {
    controller = undefined;
    busy(false);
  }
});
button("cancel").addEventListener("click", () => {
  controller?.abort();
  button("cancel").disabled = true;
  status(
    "正在停止…",
    "正在停止当前请求，已经下载的附件会保留。",
    "warning",
    "正在取消",
  );
  void bridge("cancel_export").catch(errorDetails);
});
button("show-login").addEventListener(
  "click",
  () => void bridge("show_login").catch(errorDetails),
);
button("reveal").addEventListener("click", async () => {
  if (!savedPath) return;
  $("result-action-status").textContent = "";
  try {
    await bridge("reveal_export");
  } catch (error) {
    $("result-action-status").textContent =
      error instanceof Error ? error.message : String(error);
  }
});
host.addEventListener("change", async () => {
  busy(true, false);
  connectedHost = undefined;
  previous = undefined;
  rawCsv = undefined;
  reset();
  connection();
  status("准备就绪", "登录后，自动完成备份。", "idle", "未开始");
  try {
    await bridge("cleanup");
  } catch (error) {
    if (isTauri()) errorDetails(error);
  } finally {
    busy(false);
  }
});
if (!isTauri()) {
  $("preview-notice").hidden = false;
  for (const id of ["start", "choose-location"]) button(id).disabled = true;
}

for (const [id, dialog] of [
  ["help-open", "help-dialog"],
  ["gap-summary", "gap-dialog"],
  ["error-details", "error-dialog"],
]) {
  button(id!).addEventListener("click", () =>
    ($(dialog!) as HTMLDialogElement).showModal(),
  );
}
