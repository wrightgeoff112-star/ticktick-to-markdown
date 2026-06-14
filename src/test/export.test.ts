import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { runExport } from "../lib/export.js";
import { resolveHost } from "../lib/host.js";
import { SAMPLE_CSV } from "./fixtures.js";

async function withTempCsv<T>(fn: (csvPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), "tte-test-"));
  const csvPath = resolve(dir, "TickTick.csv");
  await writeFile(csvPath, SAMPLE_CSV, "utf8");
  try {
    return await fn(csvPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("default mode produces a no-image vault with an images_disabled gap", async () => {
  await withTempCsv(async (csvPath) => {
    const { plan } = await runExport({
      csvPath,
      host: resolveHost("dida365"),
      withImages: false,
      toolVersion: "0.1.0",
    });
    assert.equal(plan.manifest.counts.tasks, 3);
    assert.equal(plan.manifest.counts.attachmentsDownloaded, 0);
    assert.ok(plan.manifest.gaps.some((g) => g.code === "images_disabled"));
  });
});

test("--with-images on non-macOS records a skip gap and produces no images", async () => {
  await withTempCsv(async (csvPath) => {
    const { plan } = await runExport({
      csvPath,
      host: resolveHost("dida365"),
      withImages: true,
      toolVersion: "0.1.0",
      platformId: "linux",
    });
    assert.ok(
      plan.manifest.gaps.some((g) => g.code === "images_skipped_not_macos"),
    );
    assert.equal(plan.binaries.length, 0);
  });
});

test("--with-images with injected engine downloads and links an attachment", async () => {
  await withTempCsv(async (csvPath) => {
    const pngBytes = Buffer.from("FAKEPNG");

    const fetchImpl: typeof fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);

      if (url.includes("/api/v2/batch/check/0")) {
        return jsonResponse({
          projectProfiles: [{ id: "p1", name: "Roadmap" }],
          syncTaskBean: { update: [{ id: "task-1", projectId: "p1" }] },
        });
      }
      if (url.includes("/api/v2/project/p1/task/task-1")) {
        return jsonResponse({
          attachments: [
            {
              id: "att-1",
              fileName: "diagram.png",
              contentType: "image/png",
              size: pngBytes.length,
              url: "https://api.dida365.com/download/att-1",
            },
          ],
        });
      }
      if (url.includes("/download/att-1")) {
        return new Response(pngBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { plan } = await runExport({
      csvPath,
      host: resolveHost("dida365"),
      withImages: true,
      toolVersion: "0.1.0",
      platformId: "darwin",
      fetchImpl,
      loadCookies: async () => ({ t: "fake-login-cookie" }),
    });

    assert.equal(plan.manifest.counts.attachmentsDownloaded, 1);
    assert.ok(plan.binaries.some((b) => b.path === "attachments/att-1.png"));
    const ship = plan.manifest.tasks.find((t) => t.sourceTaskId === "task-1");
    assert.deepEqual(ship?.attachmentIds, ["att-1"]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
