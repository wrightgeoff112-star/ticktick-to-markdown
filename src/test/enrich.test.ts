import test from "node:test";
import assert from "node:assert/strict";
import { parseDidaCsv } from "../lib/csv.js";
import { enrichWithImages, type EngineApi } from "../lib/enrich.js";
import {
  attachmentsFromTaskRecord,
  type EngineSnapshot,
  type RawRecord,
} from "../lib/image-api.js";
import { resolveHost } from "../lib/host.js";
function engine(records: RawRecord[], inboxId = "inbox"): EngineApi {
  const snapshot = {
    cookies: {},
    host: resolveHost("dida365"),
    fetchImpl: fetch,
    projects: [],
    inboxId,
    projectIdByTaskId: new Map(),
    openTasksByProject: new Map([["inbox", records]]),
  } as EngineSnapshot;
  return {
    loadSnapshot: async () => snapshot,
    fetchCompletedTasksInWindow: async () => [],
    attachmentsFromTaskRecord,
    downloadAttachmentBytes: async () => new Uint8Array([1, 2, 3]),
  };
}
const csv = (content = "") =>
  parseDidaCsv(`taskId,Title,List Name,Content\n30,报告,收集箱,${content}`);
const rec = (id = "real") => ({
  id,
  projectId: "inbox",
  title: "报告",
  attachments: [{ id: "file1", name: "report.pdf" }],
});
test("收集箱中没有正文图片的普通附件也下载并关联CSV序号", async () => {
  const result = await enrichWithImages(csv(), engine([rec()]));
  assert.equal(result.attachmentsByTask.get("30")?.[0]?.id, "file1");
  assert.equal(result.gaps.length, 0);
});
test("同名候选不能按第一条猜测", async () => {
  const result = await enrichWithImages(csv(), engine([rec("a"), rec("b")]));
  assert.equal(result.attachmentsByTask.size, 0);
  assert.ok(result.gaps.some((g) => g.code === "task_match_ambiguous"));
});
test("正文附件ID能唯一选择同名候选", async () => {
  const other = {
    ...rec("b"),
    attachments: [{ id: "file2", name: "other.pdf" }],
  };
  const result = await enrichWithImages(
    csv("![图](file1/photo.png)"),
    engine([other, rec("a")]),
  );
  assert.equal(result.attachmentsByTask.get("30")?.[0]?.id, "file1");
});
test("空附件响应是下载失败", async () => {
  const e = engine([rec()]);
  e.downloadAttachmentBytes = async () => new Uint8Array();
  const result = await enrichWithImages(csv(), e);
  assert.ok(result.gaps.some((g) => g.code === "attachment_download_failed"));
});
test("下载失败可复用成功项重试", async () => {
  const record = {
    ...rec(),
    attachments: [
      { id: "a", name: "a.pdf" },
      { id: "b", name: "b.pdf" },
    ],
  };
  const e = engine([record]);
  let calls: string[] = [];
  e.downloadAttachmentBytes = async (_s, a) => {
    calls.push(a.id);
    if (a.id === "b") throw Error("offline");
    return new Uint8Array([1]);
  };
  const first = await enrichWithImages(csv(), e);
  assert.equal(first.gaps.length, 1);
  e.downloadAttachmentBytes = async (_s, a) => {
    calls.push(a.id);
    return new Uint8Array([2]);
  };
  const second = await enrichWithImages(csv(), e, { previous: first });
  assert.deepEqual(calls, ["a", "b", "b"]);
  assert.equal(second.gaps.length, 0);
});
test("取消必须标出覆盖缺口", async () => {
  const signal = new AbortController();
  signal.abort();
  const result = await enrichWithImages(csv(), engine([rec()]), {
    signal: signal.signal,
  });
  assert.ok(result.gaps.some((g) => g.code === "export_canceled"));
});
test("相同清单相近完成时间共用完整时间桶扫描", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name,Status,Completed Time\n1,a,收集箱,2,2025-01-01T01:00:00Z\n2,b,收集箱,2,2025-01-01T02:00:00Z",
  );
  const e = engine([]);
  let calls = 0;
  e.fetchCompletedTasksInWindow = async () => {
    calls++;
    return [
      {
        id: "a",
        title: "a",
        projectId: "inbox",
        completedTime: "2025-01-01T01:00:00Z",
      },
      {
        id: "b",
        title: "b",
        projectId: "inbox",
        completedTime: "2025-01-01T02:00:00Z",
      },
    ];
  };
  const result = await enrichWithImages(parsed, e);
  assert.equal(calls, 1);
  assert.equal(result.gaps.length, 0);
});
test("唯一同名但创建时间冲突的记录不能绑定", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name,Created Time\n1,报告,收集箱,2025-01-01T00:00:00Z",
  );
  const result = await enrichWithImages(
    parsed,
    engine([{ ...rec(), createdTime: "2026-01-01T00:00:00Z" }]),
  );
  assert.equal(result.attachmentsByTask.size, 0);
  assert.ok(result.gaps.length);
});
test("扫描中取消仍保留上轮已下载文件和映射", async () => {
  const first = await enrichWithImages(csv(), engine([rec()]));
  const controller = new AbortController();
  controller.abort();
  const retry = await enrichWithImages(csv(), engine([]), {
    previous: first,
    signal: controller.signal,
  });
  assert.equal(retry.attachmentsByTask.get("30")?.[0]?.id, "file1");
  assert.equal(retry.apiTaskIds.get("dida-30"), "real");
});
test("取消任务保留CSV完成时间并走Abandoned独立扫描", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name,Status,Completed Time\n1,取消,收集箱,-1,2025-01-01T01:00:00Z",
  );
  assert.equal(parsed.tasks[0]?.completedTime, "2025-01-01T01:00:00.000Z");
  const e = engine([]);
  let mode: unknown;
  e.fetchCompletedTasksInWindow = async (_s, _p, _c, opts) => {
    mode = (opts as any)?.status;
    return [
      {
        id: "cancel",
        title: "取消",
        projectId: "inbox",
        status: -1,
        completedTime: "2025-01-01T01:00:00Z",
        attachments: [{ id: "a", name: "a.pdf" }],
      },
    ];
  };
  const result = await enrichWithImages(parsed, e);
  assert.equal(mode, "Abandoned");
  assert.equal(result.attachmentsByTask.get("1")?.[0]?.id, "a");
  assert.equal(result.gaps.length, 0);
});
test("同时间桶跨清单取消任务共用all/closed返回并按项目过滤", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name,Status,Completed Time\n1,a,P1,-1,2025-01-01T01:00:00Z\n2,a,P2,-1,2025-01-01T02:00:00Z",
  );
  const e = engine([]);
  const load = e.loadSnapshot;
  e.loadSnapshot = async () => ({
    ...(await load()),
    projects: [
      { id: "p1", name: "P1" },
      { id: "p2", name: "P2" },
    ],
  });
  let calls = 0;
  e.fetchCompletedTasksInWindow = async () => {
    calls++;
    return [
      {
        id: "a1",
        title: "a",
        projectId: "p1",
        status: -1,
        completedTime: "2025-01-01T01:00:00Z",
      },
      {
        id: "a2",
        title: "a",
        projectId: "p2",
        status: -1,
        completedTime: "2025-01-01T02:00:00Z",
      },
    ];
  };
  const result = await enrichWithImages(parsed, e);
  assert.equal(calls, 1);
  assert.equal(result.apiTaskIds.get("dida-1"), "a1");
  assert.equal(result.apiTaskIds.get("dida-2"), "a2");
  assert.equal(result.gaps.length, 0);
});
test("batch缺失归档待办时按项目缓存补取tasks且排除status2", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name\n1,归档A,Archive\n2,归档B,Archive",
  );
  const e = engine([]);
  const load = e.loadSnapshot;
  e.loadSnapshot = async () => ({
    ...(await load()),
    projects: [{ id: "archive", name: "Archive" }],
  });
  let calls = 0;
  (e as any).fetchProjectTasks = async () => {
    calls++;
    return [
      { id: "done", projectId: "archive", title: "归档A", status: 2 },
      {
        id: "todoA",
        projectId: "archive",
        title: "归档A",
        status: 0,
        attachments: [{ id: "a", name: "a.pdf" }],
      },
      { id: "todoB", projectId: "archive", title: "归档B", status: 0 },
    ];
  };
  const result = await enrichWithImages(parsed, e);
  assert.equal(calls, 1);
  assert.equal(result.apiTaskIds.get("dida-1"), "todoA");
  assert.equal(result.apiTaskIds.get("dida-2"), "todoB");
  assert.equal(result.gaps.length, 0);
});
test("接口附件元数据无法解析不能宣称完整", async () => {
  const result = await enrichWithImages(
    csv(),
    engine([{ ...rec(), attachments: [{ name: "unknown.pdf" }] }]),
  );
  assert.ok(result.gaps.some((g) => g.code === "task_attachment_unreachable"));
});
test("API status0带旧完成时间仍能匹配当前待办", async () => {
  const parsed = parseDidaCsv(
    "taskId,Title,List Name,Status,Completed Time\n1,报告,收集箱,0,2025-01-01T00:00:00Z",
  );
  const result = await enrichWithImages(
    parsed,
    engine([{ ...rec(), status: 0, completedTime: "2025-01-01T00:00:00Z" }]),
  );
  assert.equal(result.apiTaskIds.get("dida-1"), "real");
  assert.equal(result.gaps.length, 0);
});
