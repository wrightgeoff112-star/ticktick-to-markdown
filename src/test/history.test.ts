import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchCompletedWindowComplete,
  normalizeAttachments,
  snapshotFromBatch,
} from "../lib/image-api.js";
import { resolveHost } from "../lib/host.js";
test("满100条窗口分割后返回所有历史并去重", async () => {
  let calls = 0;
  const records = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
  const result = await fetchCompletedWindowComplete(
    "p",
    "2025-01-01T00:00:00Z",
    { windowHours: 1 },
    async () => {
      calls++;
      return calls === 1
        ? records
        : calls === 2
          ? records.slice(0, 60)
          : records.slice(50).concat({ id: "extra" });
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.length, 101);
});
test("接口失败和损坏响应不能当作空历史", async () => {
  await assert.rejects(
    fetchCompletedWindowComplete("p", "2025-01-01T00:00:00Z", {}, async () => {
      throw Error("offline");
    }),
  );
  await assert.rejects(
    fetchCompletedWindowComplete("p", "2025-01-01T00:00:00Z", {}, async () => ({
      error: "login",
    })),
  );
});
test("1秒内仍满100条必须报告未证明覆盖", async () => {
  await assert.rejects(
    fetchCompletedWindowComplete(
      "p",
      "2025-01-01T00:00:00Z",
      { windowHours: 1 / 3600 },
      async () => Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
    ),
    /saturated/,
  );
});
test("附件下载地址忽略接口里的任意外部URL", () => {
  const [a] = normalizeAttachments(
    [{ id: "x", name: "file.pdf", url: "https://evil.test/" }],
    resolveHost("dida365"),
    "task",
    "project",
  );
  assert.equal(
    a?.url,
    "https://api.dida365.com/api/v1/attachment/project/task/x?action=download",
  );
});
test("batch保留独立收集箱ID", () => {
  const s = snapshotFromBatch(
    { inboxId: "inbox", projectProfiles: [], syncTaskBean: { update: [] } },
    { cookies: {}, host: resolveHost("dida365"), fetchImpl: fetch },
  );
  assert.equal(s.inboxId, "inbox");
});
test("已放弃窗口使用all/closed与固定Abandoned状态", async () => {
  let path = "";
  await fetchCompletedWindowComplete(
    "p",
    "2025-01-01T00:00:00Z",
    { status: "Abandoned", global: true },
    async (p) => {
      path = p;
      return [];
    },
  );
  assert.match(path, /\/project\/all\/closed\?/);
  assert.match(path, /status=Abandoned/);
});
