/**
 * 浏览器扩展版图片引擎：用 chrome.cookies + 浏览器 fetch 实现 EngineApi。
 *
 * 与 Node 版（src/lib/image-engine.ts）对应：Node 版从 macOS Keychain + Chrome
 * Cookies SQLite 解密拿 cookie；浏览器版直接用 chrome.cookies API（需要 "cookies"
 * permission + 对应 host_permissions）。平台无关的解析逻辑共用 src/lib/image-api.ts。
 *
 * 与 Node 版的两点差异：
 * 1. cookie 来源：chrome.cookies.getAll({domain})，无需 Keychain / sqlite。
 * 2. cookie 附带：扩展对 host_permissions 内的域发 fetch 时浏览器会自动带 cookie，
 *    所以 buildHeaders 不再显式拼 Cookie 头，但仍需 X-Csrftoken / Traceid / X-Tz 等。
 */

import type { HostConfig } from "../../src/lib/host.js";
import type { EngineApi } from "../../src/lib/enrich.js";
import {
  attachmentsFromTaskRecord,
  buildCompletedWindowPath,
  type CookieMap,
  type EngineAttachment,
  type EngineProject,
  type EngineSnapshot,
  type RawRecord,
} from "../../src/lib/image-api.js";

export { attachmentsFromTaskRecord };

class BrowserEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserEngineError";
  }
}

/** 读取目标站在本浏览器的登录 cookie（受 host_permissions 控制）。 */
async function loadCookiesViaChromeApi(host: HostConfig): Promise<CookieMap> {
  const rows = await chrome.cookies.getAll({ domain: host.cookieHostSuffix });
  const cookies: CookieMap = {};
  for (const row of rows) {
    if (row.name && row.value) cookies[row.name] = row.value;
  }
  return cookies;
}

function createTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** 与 Node 版一致的请求头，但不含 Cookie（浏览器自动附带）。 */
function buildHeaders(
  cookies: CookieMap,
  host: HostConfig,
): Record<string, string> {
  const csrfToken = cookies._csrf_token ?? "";
  return {
    Accept: "application/json, text/plain, */*",
    Hl: host.hl,
    Traceid: createTraceId(),
    "X-Device": JSON.stringify({
      platform: "web",
      os: navigator.platform || "MacIntel",
      device: "ticktick-export",
      name: "ticktick-export",
      version: 1,
      id: createTraceId(),
      channel: "website",
      campaign: "",
      websocket: "",
    }),
    "X-Requested-With": "XMLHttpRequest",
    "X-Tz": host.tz,
    ...(csrfToken ? { "X-Csrftoken": csrfToken } : {}),
    Referer: `${host.webUrl}/`,
  };
}

/** 双 base（apiUrl / webUrl）逐个尝试，全部失败才抛。 */
async function fetchJson(
  path: string,
  cookies: CookieMap,
  host: HostConfig,
): Promise<unknown> {
  const headers = buildHeaders(cookies, host);
  const bases = [host.apiUrl, host.webUrl];
  let lastError = `内部接口请求失败 ${path}`;
  for (const baseUrl of bases) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        credentials: "include",
      });
      if (response.ok) return await response.json();
      lastError = `内部接口请求失败 ${path}: ${url} -> HTTP ${response.status}`;
    } catch (error) {
      lastError = `内部接口请求失败 ${path}: ${url} -> ${
        error instanceof Error ? error.message : "Network error"
      }`;
    }
  }
  throw new BrowserEngineError(lastError);
}

/** 加载 cookie 并一次性枚举项目 + 未完成任务。 */
async function loadSnapshot(host: HostConfig): Promise<EngineSnapshot> {
  const cookies = await loadCookiesViaChromeApi(host);
  if (!cookies.t) {
    throw new BrowserEngineError(
      `没有检测到 ${host.id} 的登录态。请先在本浏览器登录 ${host.webUrl}，再勾选「获取图片」。`,
    );
  }

  const batch = await fetchJson("/api/v2/batch/check/0", cookies, host);
  const batchRecord = (batch && typeof batch === "object" ? batch : {}) as RawRecord;

  const projectProfiles = Array.isArray(batchRecord.projectProfiles)
    ? (batchRecord.projectProfiles as RawRecord[])
    : [];
  const projects: EngineProject[] = projectProfiles
    .map((project) =>
      typeof project.id === "string" && typeof project.name === "string"
        ? { id: project.id, name: project.name }
        : null,
    )
    .filter((item): item is EngineProject => item !== null);

  const syncTaskBean =
    batchRecord.syncTaskBean && typeof batchRecord.syncTaskBean === "object"
      ? (batchRecord.syncTaskBean as RawRecord)
      : {};
  const openTasks = Array.isArray(syncTaskBean.update)
    ? (syncTaskBean.update as RawRecord[])
    : [];

  const projectIdByTaskId = new Map<string, string>();
  const openTasksByProject = new Map<string, RawRecord[]>();
  for (const task of openTasks) {
    if (typeof task.id === "string" && typeof task.projectId === "string") {
      projectIdByTaskId.set(task.id, task.projectId);
      const list = openTasksByProject.get(task.projectId);
      if (list) list.push(task);
      else openTasksByProject.set(task.projectId, [task]);
    }
  }

  return {
    cookies,
    host,
    fetchImpl: fetch,
    projects,
    projectIdByTaskId,
    openTasksByProject,
  };
}

/** ±168h 已完成窗口取任务（路径构造走 image-api，平台无关）。 */
async function fetchCompletedTasksInWindow(
  snapshot: EngineSnapshot,
  projectId: string,
  centerIso: string,
  options: { windowHours?: number; global?: boolean } = {},
): Promise<RawRecord[]> {
  const path = buildCompletedWindowPath(projectId, centerIso, options);
  if (!path) return [];
  try {
    const res = await fetchJson(path, snapshot.cookies, snapshot.host);
    return Array.isArray(res)
      ? (res as RawRecord[])
      : res && typeof res === "object" && Array.isArray((res as RawRecord).tasks)
        ? ((res as RawRecord).tasks as RawRecord[])
        : [];
  } catch {
    return [];
  }
}

/** 第二次 GET：下载附件字节。 */
async function downloadAttachmentBytes(
  snapshot: EngineSnapshot,
  attachment: EngineAttachment,
): Promise<Uint8Array> {
  const headers = buildHeaders(snapshot.cookies, snapshot.host);
  const response = await fetch(attachment.url, {
    method: "GET",
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    throw new BrowserEngineError(
      `下载附件失败 ${attachment.name} (HTTP ${response.status})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * 按 host 创建浏览器引擎。host 决定 cookie 域、API/Referer、hl/tz。
 * 返回的 EngineApi 直接喂给 enrichWithImages。
 */
export function createBrowserEngine(host: HostConfig): EngineApi {
  return {
    loadSnapshot: () => loadSnapshot(host),
    fetchCompletedTasksInWindow,
    attachmentsFromTaskRecord,
    downloadAttachmentBytes,
  };
}
