/**
 * Cookie-direct image engine — macOS + Chrome + dida365 only (Node side).
 *
 * Talks to TickTick's *internal / unofficial* web v2 API using the login cookie
 * it reads out of your local Chrome profile. It is:
 *   - macOS only (uses Keychain `security` + Chrome Safe Storage),
 *   - Chrome only (reads Chrome's Cookies SQLite DB),
 *   - verified only against dida365 (国内). ticktick (海外) is experimental.
 *
 * The API is unofficial and may break at any time. Use at your own risk.
 *
 * 平台无关的解析逻辑（类型 + 附件解析 + 已完成窗口路径）已抽到 `image-api.ts`，
 * 浏览器扩展引擎（extension/src/engine.ts）共用同一份。本文件只保留 Node 专属：
 * Chrome cookie 解密 + 用 Node fetch 落地引擎操作。
 */

import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomUUID,
} from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { HostConfig } from "./host.js";
import {
  attachmentsFromTaskRecord,
  buildCompletedWindowPath,
  normalizeAttachments,
  type CookieMap,
  type EngineAttachment,
  type EngineProject,
  type EngineSnapshot,
  type RawRecord,
} from "./image-api.js";

// 保持 image-engine 原有公开 API 不变（export.ts 仍从这里 import）。
export {
  attachmentsFromTaskRecord,
  type CookieMap,
  type EngineAttachment,
  type EngineProject,
  type EngineSnapshot,
  type RawRecord,
};

const execFileAsync = promisify(execFile);

// Defaults to Chrome's "Default" profile; override with CHROME_PROFILE_DIR
// (e.g. "Profile 10") to read cookies from another Chrome profile.
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR ?? "Default";
const CHROME_COOKIES_PATH = resolve(
  homedir(),
  "Library/Application Support/Google/Chrome",
  CHROME_PROFILE_DIR,
  "Cookies",
);
const CHROME_SAFE_STORAGE_ACCOUNT = "Chrome";
const CHROME_SAFE_STORAGE_SERVICE = "Chrome Safe Storage";

export class ImageEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEngineError";
  }
}

type DidaFetchAttempt = {
  url: string;
  status?: number;
  body?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Chrome cookie decrypt (macOS)
// ---------------------------------------------------------------------------

export function decryptChromeCookieValue(
  encryptedValue: Buffer,
  password: string,
  hostKey?: string,
): string {
  if (encryptedValue.length === 0) return "";

  const versionPrefix = encryptedValue.subarray(0, 3).toString("utf8");
  const payload =
    versionPrefix === "v10" || versionPrefix === "v11"
      ? encryptedValue.subarray(3)
      : encryptedValue;

  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  const paddingSize = decrypted.at(-1) ?? 0;
  const unpadded =
    paddingSize > 0 && paddingSize <= 16
      ? decrypted.subarray(0, decrypted.length - paddingSize)
      : decrypted;

  // Chrome (v11+) prepends a SHA-256 of the host_key to the plaintext.
  if (hostKey && unpadded.length > 32) {
    const hostDigest = createHash("sha256").update(hostKey).digest();
    const maybeDigest = unpadded.subarray(0, 32);
    if (maybeDigest.equals(hostDigest)) {
      return unpadded.subarray(32).toString("utf8");
    }
  }

  return unpadded.toString("utf8");
}

async function readChromeSafeStoragePassword(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-w",
      "-a",
      CHROME_SAFE_STORAGE_ACCOUNT,
      "-s",
      CHROME_SAFE_STORAGE_SERVICE,
    ]);
    return stdout.trim();
  } catch (error) {
    throw new ImageEngineError(
      "无法从 macOS Keychain 读取「Chrome Safe Storage」密码。" +
        "通常意味着系统会弹出授权框、你点了拒绝，或本机没有用 Chrome 登录过。\n" +
        "Could not read the Chrome Safe Storage password from the macOS Keychain " +
        "(authorization denied, or Chrome was never used here). " +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readChromeCookieRows(host: HostConfig) {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ticktick-export-cookies-"));
  const tempDbPath = resolve(tempDir, "Cookies");
  try {
    await copyFile(CHROME_COOKIES_PATH, tempDbPath);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw new ImageEngineError(
      `找不到 Chrome 的 Cookies 数据库（${CHROME_COOKIES_PATH}）。请确认本机装了 Chrome 并用过默认配置（Default profile）。\n` +
        `Could not read Chrome's Cookies database at ${CHROME_COOKIES_PATH}. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      tempDbPath,
      `SELECT name, value, hex(encrypted_value) AS encryptedHex, host_key FROM cookies WHERE host_key LIKE '%${host.cookieHostSuffix}';`,
    ]);
    if (!stdout.trim()) return [];
    return JSON.parse(stdout) as Array<{
      name: string;
      value: string;
      encryptedHex: string;
      host_key: string;
    }>;
  } catch (error) {
    throw new ImageEngineError(
      "读取 Chrome cookie 失败（需要本机有 sqlite3 命令；macOS 自带）。\n" +
        `Failed to read Chrome cookies via sqlite3. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function loadCookiesFromChrome(host: HostConfig): Promise<CookieMap> {
  if (platform() !== "darwin") {
    throw new ImageEngineError(
      "--with-images 只支持 macOS（需要 Keychain + Chrome Safe Storage）。" +
        "其他系统请使用默认档（仅 CSV，无图）。\n" +
        "--with-images is macOS-only. Use the default CSV-only mode elsewhere.",
    );
  }

  const password = await readChromeSafeStoragePassword();
  const rows = await readChromeCookieRows(host);
  const cookies: CookieMap = {};

  for (const row of rows) {
    if (!row?.name) continue;
    if (typeof row.value === "string" && row.value.length > 0) {
      cookies[row.name] = row.value;
      continue;
    }
    if (typeof row.encryptedHex === "string" && row.encryptedHex.length > 0) {
      try {
        const decrypted = decryptChromeCookieValue(
          Buffer.from(row.encryptedHex, "hex"),
          password,
          row.host_key,
        );
        if (decrypted) cookies[row.name] = decrypted;
      } catch {
        // ignore undecodable rows
      }
    }
  }

  return cookies;
}

// ---------------------------------------------------------------------------
// Internal API access
// ---------------------------------------------------------------------------

function createTraceId(): string {
  return randomUUID().replace(/-/g, "");
}

function buildHeaders(cookies: CookieMap, host: HostConfig): Record<string, string> {
  const csrfToken = cookies._csrf_token ?? "";
  return {
    Accept: "application/json, text/plain, */*",
    Cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    Hl: host.hl,
    Traceid: createTraceId(),
    "X-Device": JSON.stringify({
      platform: "web",
      os: "MacIntel",
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

function formatFailure(path: string, attempts: DidaFetchAttempt[]): string {
  const details = attempts
    .map((attempt) =>
      typeof attempt.status === "number"
        ? `${attempt.url} -> HTTP_${attempt.status}${attempt.body ? ` ${attempt.body}` : ""}`
        : `${attempt.url} -> ${attempt.error ?? "Unknown error"}`,
    )
    .join(" | ");
  return details
    ? `内部接口请求失败 ${path}: ${details}`
    : `内部接口请求失败 ${path}`;
}

async function fetchJson(
  path: string,
  cookies: CookieMap,
  host: HostConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const headers = buildHeaders(cookies, host);
  const bases = [host.apiUrl, host.webUrl];
  const attempts: DidaFetchAttempt[] = [];

  for (const baseUrl of bases) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        const body = (await response.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        attempts.push({ url, status: response.status, body });
        continue;
      }
      return await response.json();
    } catch (error) {
      attempts.push({
        url,
        error: error instanceof Error ? error.message : "Network error",
      });
    }
  }

  throw new ImageEngineError(formatFailure(path, attempts));
}

export interface LoadSnapshotOptions {
  host: HostConfig;
  fetchImpl?: typeof fetch;
  loadCookies?: (host: HostConfig) => Promise<CookieMap>;
}

/** Load cookies and enumerate projects + open tasks once. */
export async function loadEngineSnapshot(
  options: LoadSnapshotOptions,
): Promise<EngineSnapshot> {
  const { host } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const loadCookies = options.loadCookies ?? loadCookiesFromChrome;
  const cookies = await loadCookies(host);

  if (!cookies.t) {
    throw new ImageEngineError(
      `没有在 Chrome 里检测到 ${host.id} 的登录态。请先在 Chrome 登录 ${host.webUrl}，再重试 --with-images。\n` +
        `No ${host.id} login cookie found in Chrome. Log into ${host.webUrl} in Chrome first.`,
    );
  }

  const batch = await fetchJson("/api/v2/batch/check/0", cookies, host, fetchImpl);
  const batchRecord = (batch && typeof batch === "object" ? batch : {}) as RawRecord;

  const projectProfiles = Array.isArray(batchRecord.projectProfiles)
    ? (batchRecord.projectProfiles as RawRecord[])
    : [];

  const projects: EngineProject[] = projectProfiles
    .map<EngineProject | null>((project) => {
      if (typeof project.id !== "string" || typeof project.name !== "string") {
        return null;
      }
      return { id: project.id, name: project.name };
    })
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
    fetchImpl,
    projects,
    projectIdByTaskId,
    openTasksByProject,
  };
}

/**
 * Fetch completed tasks in a ±168h window around `centerIso` (the task's own
 * completedTime). Path construction is shared via `buildCompletedWindowPath`;
 * only the fetch is Node-specific.
 */
export async function fetchCompletedTasksInWindow(
  snapshot: EngineSnapshot,
  projectId: string,
  centerIso: string,
  options: { windowHours?: number; global?: boolean } = {},
): Promise<RawRecord[]> {
  const path = buildCompletedWindowPath(projectId, centerIso, options);
  if (!path) return [];

  try {
    const res = await fetchJson(
      path,
      snapshot.cookies,
      snapshot.host,
      snapshot.fetchImpl,
    );
    return Array.isArray(res)
      ? (res as RawRecord[])
      : res && typeof res === "object" && Array.isArray((res as RawRecord).tasks)
        ? ((res as RawRecord).tasks as RawRecord[])
        : [];
  } catch {
    return [];
  }
}

/**
 * Fetch attachment metadata for a single task id. Returns [] when the task is
 * not reachable. Errors are swallowed into [] so a single bad task can't abort
 * the whole export; callers track misses via the manifest gaps.
 */
export async function fetchTaskAttachments(
  snapshot: EngineSnapshot,
  taskId: string,
  projectIdHint?: string | null,
): Promise<EngineAttachment[]> {
  const projectId = projectIdHint || snapshot.projectIdByTaskId.get(taskId);
  if (!projectId) return [];

  const { cookies, host, fetchImpl } = snapshot;

  try {
    const detail = await fetchJson(
      `/api/v2/project/${projectId}/task/${taskId}`,
      cookies,
      host,
      fetchImpl,
    );
    const detailRecord =
      detail && typeof detail === "object" ? (detail as RawRecord) : {};
    let attachments = normalizeAttachments(
      detailRecord.attachments,
      host,
      taskId,
      projectId,
    );

    if (attachments.length === 0) {
      const fallback = await fetchJson(
        `/api/v2/task/${taskId}/attachments`,
        cookies,
        host,
        fetchImpl,
      ).catch(() => null);
      attachments = normalizeAttachments(fallback, host, taskId, projectId);
    }

    return attachments;
  } catch {
    return [];
  }
}

/** Second GET: download the raw bytes of an attachment. */
export async function downloadAttachmentBytes(
  snapshot: EngineSnapshot,
  attachment: EngineAttachment,
): Promise<Uint8Array> {
  const headers = buildHeaders(snapshot.cookies, snapshot.host);
  const response = await snapshot.fetchImpl(attachment.url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new ImageEngineError(
      `下载附件失败 ${attachment.name} (HTTP ${response.status})`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
