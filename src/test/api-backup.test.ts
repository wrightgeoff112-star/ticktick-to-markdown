import test from "node:test";
import assert from "node:assert/strict";
import { readApiBackup } from "../lib/api-backup.js";
import { exportDesktop, type NativeBridge } from "../lib/desktop-export.js";

const batch = {
  inboxId: "inbox1",
  projectProfiles: [{ id: "p", name: "工作", groupId: "g" }],
  projectGroups: [{ id: "g", name: "资料" }],
  syncTaskBean: {
    update: [
      {
        id: "open",
        projectId: "inbox1",
        title: "附件",
        kind: "TEXT",
        status: 0,
        content: "正文",
        attachments: [{ id: "csv", fileName: "data.csv", size: 3 }],
      },
      { id: "note", projectId: "p", title: "笔记", kind: "NOTE", status: 0 },
      {
        id: "check",
        projectId: "p",
        title: "检查",
        kind: "CHECKLIST",
        status: 0,
        priority: 5,
        parentId: "note",
        items: [
          { title: "步骤 [一]", status: 2 },
          { title: "步骤二", status: 0 },
        ],
        reminders: [{ trigger: "TRIGGER:-PT10M" }],
        repeatFlag: "RRULE:FREQ=DAILY",
      },
    ],
  },
};
const done = {
  id: "done",
  projectId: "p",
  title: "历史",
  status: 2,
  completedTime: "2014-10-01T00:00:00.000+0000",
};
const abandoned = {
  id: "closed",
  projectId: "p",
  title: "已放弃",
  status: -1,
  completedTime: "2014-10-02T00:00:00.000+0000",
};
const request = async (path: string): Promise<unknown> => {
  if (path.includes("/batch/")) return batch;
  if (path.endsWith("/tasks"))
    return [batch.syncTaskBean.update[1], batch.syncTaskBean.update[2]];
  if (path.includes("/completed?")) return [done];
  if (path.includes("/closed?")) return [abandoned];
  throw Error("unexpected " + path);
};
test("API备用备份包含收集箱、笔记、清单步骤、父子关系和历史，不伪造官方CSV", async () => {
  const result = await readApiBackup(request);
  assert.equal(result.csv.tasks.length, 5);
  const tasks = result.csv.tasks;
  assert.equal(tasks.find((t) => t.sourceTaskId === "note")?.kind, "note");
  assert.equal(tasks.find((t) => t.sourceTaskId === "done")?.status, "done");
  assert.equal(
    tasks.find((t) => t.sourceTaskId === "closed")?.status,
    "canceled",
  );
  const check = tasks.find((t) => t.sourceTaskId === "check")!;
  assert.equal(check.parentId, "dida-note");
  assert.equal(check.priority, 3);
  assert.match(check.content!, /- \[x\] 步骤 \[一\]/);
  assert.match(check.content!, /- \[ \] 步骤二/);
  assert.equal(check.recurrence?.canonical, "RRULE:FREQ=DAILY");
  assert.equal(check.reminderRules.length, 1);
  assert.equal(result.csv.folders[0]?.title, "资料");
  assert.equal(result.gaps.length, 0);
  assert.equal(JSON.parse(result.rawJson).tasks.length, 5);
});
test("备用历史接口失败必须留下覆盖缺口，不能把空结果当完整", async () => {
  const result = await readApiBackup(async (p) => {
    if (p.includes("/completed?")) throw Error("timeout");
    return request(p);
  });
  assert.equal(result.csv.tasks.length, 4);
  assert.ok(result.gaps.some((g) => g.code === "completed_scan_incomplete"));
});
test("限流后真实使用API备用数据和附件，备份保留来源声明，不调用CSV下载", async () => {
  const calls: string[] = [];
  const bridge: NativeBridge = async (command, args) => {
    if (command === "api_json") {
      const path = String(args?.path);
      calls.push(path);
      if (path.endsWith("/export/auto"))
        throw Error("官方限制备份次数（export_too_many_times）");
      return JSON.stringify(await request(path)) as any;
    }
    if (command === "download_attachment")
      return { diskHandle: "csv-handle", size: 3, type: "text/csv" } as any;
    if (command === "save_zip") return "/tmp/api.zip" as any;
    return undefined as any;
  };
  const result = await exportDesktop("ticktick", bridge);
  assert.equal(result.path, "/tmp/api.zip");
  assert.equal(result.plan.manifest.counts.tasks, 5);
  assert.equal(result.plan.manifest.counts.attachmentsDownloaded, 1);
  assert.equal(result.plan.manifest.source.method, "api");
  assert.equal(result.plan.manifest.source.csvFile, undefined);
  assert.equal(result.plan.manifest.source.apiFile, "api-snapshot.json");
  assert.ok(result.plan.files.some((f) => f.path === "api-snapshot.json"));
  assert.ok(!result.plan.files.some((f) => f.path === "backup.csv"));
  assert.ok(
    result.plan.manifest.gaps.some(
      (g) => g.code === "official_backup_unavailable",
    ),
  );
  assert.ok(!calls.some((p) => p.endsWith("/data/export")));
});
test("登录失效不能被备用链路掩盖", async () => {
  let requests = 0;
  await assert.rejects(
    exportDesktop("ticktick", async (command) => {
      if (command === "api_json") {
        requests++;
        throw Error("官方接口 HTTP 401：登录失效");
      }
      return undefined as any;
    }),
    /401/,
  );
  assert.equal(requests, 1);
});
