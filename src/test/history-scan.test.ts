import test from "node:test";
import assert from "node:assert/strict";
import { scanHistory } from "../lib/history-scan.js";
import type { CsvTask } from "../lib/csv.js";
const tasks = (n: number, sameSecond = false) =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        status: "done",
        completedTime: new Date(
          Date.UTC(2020, 0, 1) + (sameSecond ? 0 : i * 60000),
        ).toISOString(),
      }) as CsvTask,
  );
function server(input: CsvTask[], cap = 600) {
  const records = input.map((t, i) => ({
    id: `r${i}`,
    projectId: `p${i % 30}`,
    status: t.status === "canceled" ? -1 : 2,
    completedTime: t.completedTime,
    attachments: [{ id: `a${i}`, size: 10 }],
  }));
  let calls = 0,
    active = 0,
    peak = 0;
  return {
    records,
    get calls() {
      return calls;
    },
    get peak() {
      return peak;
    },
    request: async (path: string) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 0));
      active--;
      const u = new URL(path, "https://test.invalid");
      assert.equal(u.pathname, "/api/v2/project/all/closed");
      const parse = (name: string) =>
        Date.parse(u.searchParams.get(name)!.replace(" ", "T") + "Z");
      const status = u.searchParams.get("status") === "Abandoned" ? -1 : 2;
      return records
        .filter(
          (r) =>
            r.status === status &&
            Date.parse(r.completedTime!) >= parse("from") &&
            Date.parse(r.completedTime!) <= parse("to"),
        )
        .slice(0, cap);
    },
  };
}
test("30k historical tasks across projects use fewer than 100 metadata queries with at most 3 in flight", async () => {
  const input = tasks(30000),
    api = server(input);
  const result = await scanHistory(input, api.request);
  assert.equal(result.records.length, 30000);
  assert.equal(result.gaps.length, 0);
  assert.ok(api.calls < 100);
  assert.ok(api.peak <= 3 && api.peak > 1);
});
test("server silently capped at 100 must not lose the remaining records", async () => {
  const input = tasks(1200),
    api = server(input, 100);
  const result = await scanHistory(input, api.request);
  assert.equal(result.records.length, 1200);
  assert.equal(result.gaps.length, 0);
});
test("same-second saturation is an explicit coverage gap, not success", async () => {
  const input = tasks(700, true),
    api = server(input);
  const result = await scanHistory(input, api.request);
  assert.equal(result.records.length, 600);
  assert.ok(result.gaps.some((g) => g.code === "completed_scan_incomplete"));
  assert.ok(api.calls < 5);
});
test("abandoned records across projects and second boundaries are preserved", async () => {
  const input = tasks(900);
  input.forEach((t, i) => {
    if (i % 2) t.status = "canceled";
  });
  const api = server(input);
  const result = await scanHistory(input, api.request);
  assert.equal(result.records.length, 900);
  assert.equal(result.gaps.length, 0);
});
test("unknown server caps without CSV split even a 100-row response", async () => {
  let calls = 0;
  const records = tasks(100).map((t, i) => ({
    id: `r${i}`,
    status: 2,
    completedTime: t.completedTime,
  }));
  const result = await scanHistory(undefined, async (path) => {
    calls++;
    const u = new URL(path, "https://test.invalid");
    if (u.searchParams.get("status") === "Abandoned") return [];
    const from = Date.parse(
        u.searchParams.get("from")!.replace(" ", "T") + "Z",
      ),
      to = Date.parse(u.searchParams.get("to")!.replace(" ", "T") + "Z");
    return records
      .filter(
        (r) =>
          Date.parse(r.completedTime!) >= from &&
          Date.parse(r.completedTime!) <= to,
      )
      .slice(0, 100);
  });
  assert.equal(result.records.length, 100);
  assert.ok(calls > 2);
  assert.equal(result.gaps.length, 0);
});
test("invalid responses and missing timestamps cannot masquerade as empty completed history", async () => {
  const result = await scanHistory(
    [...tasks(1), { status: "done", completedTime: null } as CsvTask],
    async () => ({ errorCode: "unauthorized" }),
  );
  assert.ok(result.gaps.length >= 2);
  assert.equal(result.records.length, 0);
});
test("pre-canceled history scan performs no requests", async () => {
  const c = new AbortController();
  c.abort();
  let calls = 0;
  await assert.rejects(
    scanHistory(
      tasks(5),
      async () => {
        calls++;
        return [];
      },
      { signal: c.signal },
    ),
  );
  assert.equal(calls, 0);
});

test("窗口覆盖完整末秒并排除下一窗口边界，不遗漏毫秒任务", async () => {
  const { parseDidaCsv } = await import("../lib/csv.js");
  const csv = parseDidaCsv(
    "taskId,Title,Status,Completed Time\n1,任务,2,2026-01-01T00:00:00.500Z",
  );
  const records = [
    {
      id: "a",
      projectId: "p",
      status: 2,
      completedTime: "2026-01-01T00:00:00.500Z",
    },
    {
      id: "boundary",
      projectId: "p",
      status: 2,
      completedTime: "2026-01-01T00:00:01.000Z",
    },
  ];
  const result = await scanHistory(csv.tasks, async (path) => {
    const params = new URL(path, "https://example.test").searchParams;
    const from = Date.parse(params.get("from")!.replace(" ", "T") + "Z"),
      to = Date.parse(params.get("to")!.replace(" ", "T") + "Z");
    return records.filter(
      (r) =>
        Date.parse(r.completedTime) >= from &&
        Date.parse(r.completedTime) <= to,
    );
  });
  assert.deepEqual(
    result.records.map((r) => r.id),
    ["a"],
  );
  assert.equal(result.gaps.length, 0);
});
