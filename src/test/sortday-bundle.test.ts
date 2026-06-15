import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDidaCsv } from "../lib/csv.js";
import {
  buildSortdayBundle,
  isSortdayManifest,
  SDX_SCHEMA_VERSION,
} from "../lib/sortday-bundle.js";
import type { ResolvedAttachment } from "../lib/vault.js";
import { SAMPLE_CSV } from "./fixtures.js";

function counterIdFactory(): () => string {
  let n = 0;
  return () => `id${(n += 1)}`;
}

test("produces a valid SDX manifest the sortday importer accepts", () => {
  const csv = parseDidaCsv(SAMPLE_CSV);
  const { manifest } = buildSortdayBundle({
    csv,
    idFactory: counterIdFactory(),
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  assert.equal(manifest.schemaVersion, SDX_SCHEMA_VERSION);
  assert.equal(manifest.app, "sortday");
  assert.ok(isSortdayManifest(manifest));
  assert.equal(manifest.things.length, csv.tasks.length);
  assert.equal(manifest.counts.things, csv.tasks.length);
  assert.equal(manifest.lists.length, csv.lists.length + csv.folders.length);
});

test("emits fresh local ids, never dida- prefixed", () => {
  const csv = parseDidaCsv(SAMPLE_CSV);
  const { manifest } = buildSortdayBundle({
    csv,
    idFactory: counterIdFactory(),
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  for (const thing of manifest.things) {
    assert.ok(thing.id.startsWith("sd:local:local::"));
    assert.ok(!thing.id.includes("dida-"));
    assert.equal(thing.importMeta, null);
    assert.equal(thing.source.type, "local");
    // dates that exist are ISO (parseable, end in Z or offset)
    if (thing.dueTime) assert.ok(!Number.isNaN(Date.parse(thing.dueTime)));
    if (thing.doTime) {
      assert.ok(!Number.isNaN(Date.parse(thing.doTime.startAt)));
    }
  }
  for (const list of manifest.lists) {
    assert.ok(list.id.startsWith("sd:local:local::"));
  }
});

test("rewrites parentId/listId consistently to new ids (no dangling refs)", () => {
  const csv = parseDidaCsv(SAMPLE_CSV);
  const { manifest } = buildSortdayBundle({
    csv,
    idFactory: counterIdFactory(),
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  const thingIds = new Set(manifest.things.map((t) => t.id));
  const listIds = new Set(manifest.lists.map((l) => l.id));
  for (const thing of manifest.things) {
    if (thing.parentId !== null) assert.ok(thingIds.has(thing.parentId));
    if (thing.listId !== null) assert.ok(listIds.has(thing.listId));
  }
});

test("maps a downloaded attachment to blob + manifest entry + sd-attachment node", () => {
  const csv = parseDidaCsv(SAMPLE_CSV);
  const taskWithSource = csv.tasks.find((t) => t.sourceTaskId);
  assert.ok(taskWithSource?.sourceTaskId);

  const att: ResolvedAttachment = {
    id: "remote-att-1",
    taskId: taskWithSource.sourceTaskId,
    name: "shot.png",
    type: "image/png",
    size: 4,
    bytes: Buffer.from([1, 2, 3, 4]),
  };
  const attachmentsByTask = new Map([
    [taskWithSource.sourceTaskId, [att]],
  ]);

  const { manifest, binaries } = buildSortdayBundle({
    csv,
    attachmentsByTask,
    idFactory: counterIdFactory(),
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  assert.equal(manifest.counts.attachments, 1);
  assert.equal(manifest.counts.attachmentsMissing, 0);

  const entry = manifest.attachments[0]!;
  assert.ok(entry.file && entry.file.startsWith("attachments/"));
  assert.ok(entry.storageKey.startsWith("thing-attachment://"));
  // binary present at the manifest path
  assert.ok(binaries.some((b) => b.path === entry.file));

  // the owning thing carries the attachment + an sd-attachment node referencing it
  const owner = manifest.things.find((t) => t.id === entry.thingId)!;
  assert.ok(owner.attachments?.some((a) => a.id === entry.id));
  assert.ok(owner.noteMd?.includes(`data-attachment-id="${entry.id}"`));
});

test("missing-bytes attachment is marked missing, not silently dropped", () => {
  const csv = parseDidaCsv(SAMPLE_CSV);
  const taskWithSource = csv.tasks.find((t) => t.sourceTaskId)!;
  const att: ResolvedAttachment = {
    id: "remote-att-2",
    taskId: taskWithSource.sourceTaskId!,
    name: "broken.png",
    type: "image/png",
    bytes: null,
  };
  const { manifest, binaries } = buildSortdayBundle({
    csv,
    attachmentsByTask: new Map([[taskWithSource.sourceTaskId!, [att]]]),
    idFactory: counterIdFactory(),
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  assert.equal(manifest.counts.attachments, 1);
  assert.equal(manifest.counts.attachmentsMissing, 1);
  assert.equal(manifest.attachments[0]!.file, null);
  assert.equal(manifest.attachments[0]!.missing, true);
  assert.equal(binaries.length, 0);
});
