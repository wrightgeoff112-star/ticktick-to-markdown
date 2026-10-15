import test from "node:test";
import assert from "node:assert/strict";
import { exportDesktop, type NativeBridge } from "../lib/desktop-export.js";
import * as desktop from "../lib/desktop-export.js";

test("扫描只取得附件目录，选择后导出保留全部文字且只下载选中项", async () => {
  assert.equal(typeof (desktop as any).scanDesktop, "function");
  const calls: string[] = [];
  const downloaded: string[] = [];
  const csv = "taskId,Title,List Name\n1,任务一,收集箱\n2,任务二,收集箱";
  const bridge: NativeBridge = async (command, args) => {
    calls.push(command);
    if (command === "api_json") {
      if (args?.path === "/api/v2/data/export/auto")
        return JSON.stringify({}) as any;
      if (args?.path === "/api/v2/data/export")
        return JSON.stringify(csv) as any;
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: {
          update: [
            {
              id: "r1",
              projectId: "i",
              title: "任务一",
              attachments: [{ id: "a", name: "a.pdf", size: 3 }],
            },
            {
              id: "r2",
              projectId: "i",
              title: "任务二",
              attachments: [{ id: "b", name: "b.pdf" }],
            },
          ],
        },
      }) as any;
    }
    if (command === "download_attachment") {
      downloaded.push(String(args?.attachmentId));
      return { diskHandle: "h", size: 3, type: "application/pdf" } as any;
    }
    if (command === "save_zip") return "/selected/backup.zip" as any;
    return undefined as any;
  };
  const scanController = new AbortController();
  const scanned = await (desktop as any).scanDesktop("dida365", bridge, {
    signal: scanController.signal,
  });
  assert.equal(scanned.scan.entries.length, 2);
  assert.ok(!calls.includes("download_attachment"));
  assert.ok(!calls.includes("save_zip"));
  // The scan and download steps have separate cancellation lifetimes.
  scanController.abort();
  const apiCount = calls.filter((c) => c === "api_json").length;
  const result = await exportDesktop("dida365", bridge, {
    scanned,
    selectedAttachmentKeys: new Set([scanned.scan.entries[0].key]),
    destination: "/selected/backup.zip",
  } as any);
  assert.deepEqual(downloaded, ["a"]);
  assert.equal(calls.filter((c) => c === "api_json").length, apiCount);
  assert.equal(result.plan.manifest.tasks.length, 2);
  assert.equal(result.plan.diskFiles.length, 1);
  assert.equal(
    (result.plan.manifest.attachments[1] as any).skippedByUser,
    true,
  );
  assert.equal(result.plan.manifest.gaps.length, 0);
  assert.match(
    result.plan.files.find((f) => f.path.endsWith("任务二.md"))!.text,
    /未选入/,
  );
  downloaded.length = 0;
  const textOnly = await exportDesktop("dida365", bridge, {
    scanned,
    selectedAttachmentKeys: new Set(),
    previous: result.enriched,
  } as any);
  assert.deepEqual(downloaded, []);
  assert.equal(textOnly.plan.diskFiles.length, 0);
  assert.equal(textOnly.plan.manifest.tasks.length, 2);
});
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
  assert.equal(result.plan.manifest.tool.version, "1.1.0");
});

test("扫描有总时间预算，终止挂起请求且不接受晚到的CSV", async () => {
  const calls: string[] = [];
  let finish!: (value: any) => void;
  const bridge: NativeBridge = async (command) => {
    calls.push(command);
    if (command === "api_json")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return undefined as any;
  };
  await assert.rejects(
    desktop.scanDesktop("dida365", bridge, { scanTimeoutMs: 20 } as any),
    /扫描超时/,
  );
  assert.ok(calls.includes("cancel_export"));
  finish(JSON.stringify({}));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.filter((c) => c === "api_json").length, 1);
});

test("CSV历史使用跨清单批量元数据，不下载附件", async () => {
  const paths: string[] = [];
  const bridge: NativeBridge = async (command, args) => {
    assert.notEqual(command, "download_attachment");
    if (command !== "api_json") return undefined as any;
    const path = String(args?.path);
    paths.push(path);
    if (path.includes("batch"))
      return JSON.stringify({
        inboxId: "i",
        projectProfiles: [],
        syncTaskBean: { update: [] },
      }) as any;
    assert.match(path, /all\/closed\?/);
    assert.match(path, /status=Completed/);
    return JSON.stringify([
      {
        id: "done",
        title: "完成",
        projectId: "i",
        status: 2,
        completedTime: "2026-01-01T00:00:00Z",
        attachments: [{ id: "a", name: "a.pdf", size: 123 }],
      },
    ]) as any;
  };
  const result = await desktop.scanDesktop("dida365", bridge, {
    rawCsv:
      "taskId,Title,List Name,Status,Completed Time\n1,完成,收集箱,2,2026-01-01T00:00:00Z",
  });
  assert.equal(result.scan.entries.length, 1);
  assert.equal(result.scan.gaps.length, 0);
  assert.equal(paths.length, 2);
});

test("历史超时后复用已取得CSV，但切换账号绝不复用", async () => {
  const csvCache = {};
  let account = "a",
    hang = true,
    exports = 0;
  const bridge: NativeBridge = async (command, args) => {
    if (command !== "api_json") return undefined as any;
    const path = String(args?.path);
    if (path.includes("/batch/"))
      return JSON.stringify({
        inboxId: account,
        projectProfiles: [],
        syncTaskBean: { update: [] },
      }) as any;
    if (path.endsWith("/auto")) {
      exports++;
      return "{}" as any;
    }
    if (path.endsWith("/export"))
      return JSON.stringify(
        "taskId,Title,List Name,Status,Completed Time\n1,任务,收集箱,2,2026-01-01T00:00:00Z",
      ) as any;
    if (hang) return new Promise(() => {});
    return JSON.stringify([
      {
        id: "real",
        projectId: account,
        title: "任务",
        status: 2,
        completedTime: "2026-01-01T00:00:00Z",
      },
    ]) as any;
  };
  await assert.rejects(
    desktop.scanDesktop("dida365", bridge, {
      csvCache,
      scanTimeoutMs: 20,
    } as any),
    /超时/,
  );
  hang = false;
  const result = await desktop.scanDesktop("dida365", bridge, {
    csvCache,
  } as any);
  assert.equal(result.scan.gaps.length, 0);
  assert.equal(exports, 1);
  account = "b";
  await desktop.scanDesktop("dida365", bridge, { csvCache } as any);
  assert.equal(exports, 2);
});

test("保存计划出现无效或重复路径时不进入原生写入", async () => {
  const { buildVault } = await import("../lib/vault.js");
  const { parseDidaCsv } = await import("../lib/csv.js");
  const { resolveHost } = await import("../lib/host.js");
  const plan = buildVault({
    csv: parseDidaCsv("taskId,Title\n1,任务"),
    host: resolveHost("dida365"),
    csvPath: "backup.csv",
    withImages: false,
    toolVersion: "test",
  });
  let writes = 0;
  const bridge: NativeBridge = async () => {
    writes++;
    return undefined as any;
  };
  plan.files.push({ path: "../escape.md", text: "text" });
  assert.throws(() => desktop.saveDesktopPlan(plan, bridge), /路径无效/);
  plan.files.pop();
  plan.files.push({ ...plan.files[0]! });
  assert.throws(() => desktop.saveDesktopPlan(plan, bridge), /路径重复/);
  assert.equal(writes, 0);
});
