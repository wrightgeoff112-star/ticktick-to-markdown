import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchTaskAttachments,
  downloadAttachmentBytes,
} from "../lib/image-engine.js";
import { resolveHost } from "../lib/host.js";
import type { EngineSnapshot } from "../lib/image-api.js";
function snapshot(fetchImpl: typeof fetch): EngineSnapshot {
  return {
    cookies: { t: "synthetic" },
    host: resolveHost("dida365"),
    fetchImpl,
    projects: [],
    projectIdByTaskId: new Map(),
    openTasksByProject: new Map(),
  };
}
test("task detail请求失败不可吞成空附件", async () => {
  const s = snapshot(
    (async () => new Response("bad", { status: 503 })) as typeof fetch,
  );
  await assert.rejects(fetchTaskAttachments(s, "task", "project"));
});
test("附件302转储存域不会携带账号Cookie", async () => {
  let cookie: string | undefined;
  let calls = 0;
  const s = snapshot((async (_input, options) => {
    calls++;
    if (calls === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://storage.test/file?signed=1" },
      });
    cookie = (options?.headers as Record<string, string>)?.Cookie;
    return new Response(new Uint8Array([1]));
  }) as typeof fetch);
  await downloadAttachmentBytes(s, {
    id: "a",
    taskId: "t",
    projectId: "p",
    name: "a",
    type: "application/octet-stream",
    url: "https://api.dida365.com/api/v1/attachment/p/t/a?action=download",
  });
  assert.equal(cookie, undefined);
});
