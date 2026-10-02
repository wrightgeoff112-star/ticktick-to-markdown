import test from "node:test";
import assert from "node:assert/strict";
import { exportDesktop, type NativeBridge } from "../lib/desktop-export.js";
test("官方JSON编码CSV自动备份生成ZIP计划，保持源序号和父子任务", async () => {
  let zip: any;
  let download: Record<string, unknown> | undefined;
  const csv = "taskId,Title,List Name,parentId\n30,父,收集箱,\n31,子,收集箱,30";
  const invoke: NativeBridge = async (command, args) => {
    if (command === "api_json") {
      if (args?.path === "/api/v2/data/export/auto")
        return JSON.stringify({ type: "direct" }) as any;
      if (args?.path === "/api/v2/data/export")
        return JSON.stringify(csv) as any;
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: {
          update: [
            {
              id: "real30",
              projectId: "i",
              title: "父",
              attachments: [{ id: "file", name: "a.pdf", size: 3 }],
            },
            { id: "real31", projectId: "i", title: "子" },
          ],
        },
      }) as any;
    }
    if (command === "download_attachment") {
      download = args;
      return { diskHandle: "handle", type: "application/pdf", size: 3 } as any;
    }
    if (command === "save_zip") {
      zip = args;
      return "/tmp/result.zip" as any;
    }
    return undefined as any;
  };
  const result = await exportDesktop("dida365", invoke);
  assert.equal(result.path, "/tmp/result.zip");
  assert.equal(download?.expectedSize, 3);
  assert.equal(result.plan.manifest.source.csvFile, "backup.csv");
  assert.equal(
    zip.files.find((f: any) => f.path === "backup.csv").content,
    csv,
  );
  assert.deepEqual(zip.attachments, [
    { path: "attachments/file.pdf", diskHandle: "handle" },
  ]);
  assert.equal(result.plan.manifest.tasks[0]?.sourceTaskId, "30");
  assert.equal(result.plan.manifest.tasks[0]?.apiTaskId, "real30");
  assert.match(
    zip.files.find((f: any) => f.path.endsWith("子.md")).content,
    /parent: dida-30/,
  );
});
test("备份接口不是JSON字符串CSV必须失败", async () => {
  const bridge: NativeBridge = async () =>
    JSON.stringify({ error: "not ready" }) as any;
  await assert.rejects(exportDesktop("dida365", bridge), /CSV/);
});

test("预选的保存位置会传入原生保存，保存前可取得已准备好的计划", async () => {
  let ready: any;
  let saveArgs: Record<string, unknown> | undefined;
  const bridge: NativeBridge = async (command, args) => {
    if (command === "api_json")
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: { update: [] },
      }) as any;
    if (command === "save_zip") {
      saveArgs = args;
      assert.ok(ready, "保存之前应保留准备好的计划");
      throw Error("磁盘空间不足");
    }
    return undefined as any;
  };
  await assert.rejects(
    exportDesktop("dida365", bridge, {
      rawCsv: "taskId,Title,List Name\n1,测试,收集箱",
      destination: "/selected/backup.zip",
      onPlan: (plan: any) => {
        ready = plan;
      },
    } as any),
    /磁盘空间不足/,
  );
  assert.equal(saveArgs?.destination, "/selected/backup.zip");
  assert.equal(ready.manifest.counts.tasks, 1);
});

test("再次保存已准备的计划不重新访问官方接口或下载附件", async () => {
  const { saveDesktopPlan } = await import("../lib/desktop-export.js");
  const { buildVault } = await import("../lib/vault.js");
  const { parseDidaCsv } = await import("../lib/csv.js");
  const { resolveHost } = await import("../lib/host.js");
  const plan = buildVault({
    csv: parseDidaCsv("taskId,Title\n1,测试"),
    host: resolveHost("dida365"),
    csvPath: "backup.csv",
    withImages: true,
    toolVersion: "0.1.0",
  });
  const calls: string[] = [];
  const bridge: NativeBridge = async (command, args) => {
    calls.push(command);
    assert.equal(args?.destination, "/selected/retry.zip");
    assert.ok(Array.isArray(args?.files));
    return "/selected/retry.zip" as any;
  };
  const path = await saveDesktopPlan(plan, bridge, "/selected/retry.zip");
  assert.equal(path, "/selected/retry.zip");
  assert.deepEqual(calls, ["save_zip"]);
});

test("保存已确认落盘后收到取消，不把已保存文件误报成未保存", async () => {
  const controller = new AbortController();
  const bridge: NativeBridge = async (command, args) => {
    if (command === "api_json")
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: { update: [] },
      }) as any;
    if (command === "save_zip") {
      controller.abort();
      return "/selected/saved.zip" as any;
    }
    return undefined as any;
  };
  const result = await exportDesktop("dida365", bridge, {
    rawCsv: "taskId,Title,List Name\n1,测试,收集箱",
    signal: controller.signal,
  });
  assert.equal(result.path, "/selected/saved.zip");
});

test("已取消的操作不能重新激活原生导出", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const bridge: NativeBridge = async (command) => {
    calls.push(command);
    return undefined as any;
  };
  await assert.rejects(
    exportDesktop("dida365", bridge, { signal: controller.signal }),
    /取消/,
  );
  assert.deepEqual(calls, []);
});

test("国际站不因站点选择生成固定的未验证缺口", async () => {
  const bridge: NativeBridge = async (command) => {
    if (command === "api_json")
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: { update: [{ id: "r", projectId: "i", title: "测试" }] },
      }) as any;
    if (command === "save_zip") return "/selected/backup.zip" as any;
    return undefined as any;
  };
  const result = await exportDesktop("ticktick", bridge, {
    rawCsv: "taskId,Title,List Name\n1,测试,收集箱",
  });
  assert.equal(result.plan.manifest.gaps.length, 0);
  assert.equal(result.plan.manifest.source.imagesVerifiedHost, true);
  assert.equal(result.plan.manifest.tool.version, "1.0.0");
});
