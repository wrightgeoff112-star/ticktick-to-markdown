import test from "node:test";
import assert from "node:assert/strict";
import { parseDidaCsv } from "../lib/csv.js";
import type { AttachmentCandidate } from "../lib/enrich.js";

const task = parseDidaCsv("taskId,Title,List Name\n1,测试,工作").tasks[0]!;
const entry = (
  key: string,
  patch: Partial<typeof task> = {},
  size?: number,
): AttachmentCandidate => ({
  key,
  task: { ...task, ...patch },
  meta: {
    id: key,
    taskId: "t",
    projectId: "p",
    name: key,
    type: "application/pdf",
    url: "https://example.com",
    size,
  },
});
async function api() {
  const path = "../lib/attachment-selection.js";
  return await import(path);
}
const filter = {
  scope: "all",
  listId: null,
  includeNotes: true,
  dateField: "created",
  status: "all",
  from: "2026-09-02",
  to: "2026-10-02",
  now: new Date("2026-10-02T12:00:00"),
};

test("状态和清单取交集，笔记由独立开关决定", async () => {
  const { filterAttachments } = await api();
  const entries = [
    entry("todo"),
    entry("done", { status: "done" }),
    entry("note", { kind: "note" }),
    entry("other", { listId: "other" }),
  ];
  assert.deepEqual(
    filterAttachments(entries, {
      ...filter,
      scope: "todo",
      listId: task.listId,
    }).map((e: any) => e.key),
    ["todo", "note"],
  );
  assert.deepEqual(
    filterAttachments(entries, {
      ...filter,
      scope: "todo",
      listId: task.listId,
      includeNotes: false,
    }).map((e: any) => e.key),
    ["todo"],
  );
});
test("最近范围以任务创建时间筛选，活跃范围保留旧未完成任务", async () => {
  const { filterAttachments } = await api();
  const entries = [
    entry("old", { createdTime: "2025-01-01T12:00:00Z" }),
    entry("recent", {
      createdTime: "2026-09-20T12:00:00Z",
      status: "done",
      completedTime: "2026-09-21T00:00:00Z",
    }),
    entry("cancel", {
      status: "canceled",
      createdTime: "2026-09-20T12:00:00Z",
    }),
    entry("unknown", { createdTime: null, status: "done" }),
  ];
  assert.deepEqual(
    filterAttachments(entries, { ...filter, scope: "recent" }).map(
      (e: any) => e.key,
    ),
    ["recent", "cancel"],
  );
  assert.deepEqual(
    filterAttachments(entries, { ...filter, scope: "active" }).map(
      (e: any) => e.key,
    ),
    ["old", "recent"],
  );
});
test("自定义日期包含结束日全部时间；完成日期不包括未完成任务和笔记", async () => {
  const { filterAttachments } = await api();
  const date = new Date("2026-10-02T23:59:59").toISOString();
  const entries = [
    entry("last", { createdTime: date, status: "done", completedTime: date }),
    entry("todo", { createdTime: date, completedTime: date }),
    entry("note", { kind: "note", createdTime: date, completedTime: date }),
  ];
  assert.equal(
    filterAttachments(entries, { ...filter, scope: "custom" }).length,
    3,
  );
  assert.deepEqual(
    filterAttachments(entries, {
      ...filter,
      scope: "custom",
      dateField: "completed",
    }).map((e: any) => e.key),
    ["last"],
  );
  assert.deepEqual(
    filterAttachments(entries, {
      ...filter,
      scope: "custom",
      from: "2026-10-03",
      to: "2026-10-02",
    }),
    [],
  );
});
test("大小未知独立提示，不把未知、负数或NaN算作零大小", async () => {
  const { estimateAttachments } = await api();
  assert.deepEqual(
    estimateAttachments([
      entry("a", {}, 1024),
      entry("b"),
      entry("c", {}, -1),
      entry("d", {}, NaN),
      entry("e", {}, 0),
    ]),
    { count: 5, knownBytes: 1024, unknownCount: 3 },
  );
});
