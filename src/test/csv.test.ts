import assert from "node:assert/strict";
import { test } from "node:test";

import { CsvFormatError, parseDidaCsv } from "../lib/csv.js";
import { NO_HEADER_CSV, SAMPLE_CSV } from "./fixtures.js";

test("parses tasks, lists and folders from a real-shaped export", () => {
  const result = parseDidaCsv(SAMPLE_CSV);

  assert.equal(result.tasks.length, 3);
  assert.equal(result.summary.importedTasks, 3);

  const ship = result.tasks.find((t) => t.title === "Ship v1");
  assert.ok(ship);
  assert.equal(ship.sourceTaskId, "task-1");
  assert.equal(ship.id, "dida-task-1");
  assert.equal(ship.status, "todo");
  // Priority 5 (滴答 high) -> app 3.
  assert.equal(ship.priority, 3);
  assert.equal(ship.rawPriority, 5);
  assert.deepEqual(ship.tags, ["release", "urgent"]);
  assert.deepEqual(ship.attachmentRefs, ["abc123/diagram.png"]);
  assert.ok(ship.startDate?.startsWith("2026-06-10T01:00:00"));
});

test("maps status from completed time and status codes", () => {
  const result = parseDidaCsv(SAMPLE_CSV);
  const sub = result.tasks.find((t) => t.sourceTaskId === "task-2");
  const groceries = result.tasks.find((t) => t.sourceTaskId === "task-3");

  // status=2 + completed time -> done.
  assert.equal(sub?.status, "done");
  assert.ok(sub?.completedTime);
  // status=-1 -> canceled.
  assert.equal(groceries?.status, "canceled");
});

test("resolves parent ids within the export", () => {
  const result = parseDidaCsv(SAMPLE_CSV);
  const sub = result.tasks.find((t) => t.sourceTaskId === "task-2");
  assert.equal(sub?.parentId, "dida-task-1");
});

test("groups lists into folders", () => {
  const result = parseDidaCsv(SAMPLE_CSV);
  const roadmap = result.lists.find((l) => l.title === "Roadmap");
  const personal = result.lists.find((l) => l.title === "Personal");

  assert.ok(roadmap);
  assert.ok(personal);
  assert.ok(roadmap.folderId, "Roadmap should be under a folder");
  assert.equal(personal.folderId, null);

  const work = result.folders.find((f) => f.title === "Work");
  assert.ok(work);
  assert.equal(roadmap.folderId, work.id);
});

test("parses repeat and reminder rules", () => {
  const result = parseDidaCsv(SAMPLE_CSV);
  const ship = result.tasks.find((t) => t.sourceTaskId === "task-1");
  assert.equal(ship?.recurrence?.parseStatus, "parsed");
  assert.equal(ship?.recurrence?.parsed?.freq, "WEEKLY");
  assert.deepEqual(ship?.recurrence?.parsed?.byDay, ["MO"]);

  // -PT30M reminder -> relative, -1800s.
  assert.equal(ship?.reminderRules.length, 1);
  assert.equal(ship?.reminderRules[0]?.triggerSeconds, -1800);
  assert.equal(ship?.reminderRules[0]?.triggerMode, "relative");

  // All-day task with P9H -> day_clock.
  const groceries = result.tasks.find((t) => t.sourceTaskId === "task-3");
  assert.equal(groceries?.reminderRules[0]?.triggerMode, "day_clock");
  assert.equal(groceries?.reminderRules[0]?.triggerSeconds, 9 * 3600);
});

test("throws a friendly error when the header is missing", () => {
  assert.throws(() => parseDidaCsv(NO_HEADER_CSV), CsvFormatError);
});
