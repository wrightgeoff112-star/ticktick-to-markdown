import test from "node:test";
import assert from "node:assert/strict";
import { parseDidaCsv } from "../lib/csv.js";
test("显式Status0优先于残留完成时间，保持官方待办身份", () => {
  const result = parseDidaCsv(
    "taskId,Title,Status,Completed Time\n1,待办,0,2025-01-01T00:00:00Z",
  );
  assert.equal(result.tasks[0]?.status, "todo");
  assert.equal(result.tasks[0]?.completedTime, null);
});
