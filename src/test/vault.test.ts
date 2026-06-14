import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDidaCsv } from "../lib/csv.js";
import { resolveHost } from "../lib/host.js";
import { ManifestSchema } from "../lib/manifest.js";
import { buildVault, type ResolvedAttachment } from "../lib/vault.js";
import { SAMPLE_CSV } from "./fixtures.js";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function build(withImages: boolean, attachments?: Map<string, ResolvedAttachment[]>) {
  const csv = parseDidaCsv(SAMPLE_CSV);
  return buildVault({
    csv,
    host: resolveHost("dida365"),
    csvPath: "/tmp/TickTick.csv",
    withImages,
    toolVersion: "0.1.0",
    now: NOW,
    ...(attachments ? { attachmentsByTask: attachments } : {}),
    gaps: withImages
      ? []
      : [{ code: "images_disabled", message: "no images" }],
  });
}

test("emits one markdown file per task plus a manifest", () => {
  const plan = build(false);
  const mdFiles = plan.files.filter((f) => f.path.endsWith(".md"));
  assert.equal(mdFiles.length, 3);
  assert.ok(plan.files.some((f) => f.path === "manifest.json"));
});

test("markdown has YAML frontmatter with structured fields", () => {
  const plan = build(false);
  const ship = plan.files.find((f) => f.path.endsWith("Ship v1.md"));
  assert.ok(ship);
  assert.match(ship.text, /^---\n/);
  assert.match(ship.text, /\nstatus: todo\n/);
  assert.match(ship.text, /\npriority: 3\n/);
  assert.match(ship.text, /\ntags: \[release, urgent\]\n/);
  assert.match(ship.text, /\nrepeat: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"\n/);
  assert.match(ship.text, /# Ship v1/);
});

test("tasks live under their list directory", () => {
  const plan = build(false);
  assert.ok(plan.files.some((f) => f.path === "Roadmap/Ship v1.md"));
  assert.ok(plan.files.some((f) => f.path === "Personal/Buy groceries.md"));
});

test("manifest validates against the zod schema and records the disabled-images gap", () => {
  const plan = build(false);
  const parsed = ManifestSchema.safeParse(plan.manifest);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(plan.manifest.schemaVersion, 1);
  assert.equal(plan.manifest.source.withImages, false);
  assert.ok(plan.manifest.gaps.some((g) => g.code === "images_disabled"));
});

test("with images: writes attachment bytes, rewrites body ref, records mapping", () => {
  const bytes = Buffer.from("PNGDATA");
  const attachments = new Map<string, ResolvedAttachment[]>([
    [
      "task-1",
      [
        {
          id: "att-9",
          taskId: "task-1",
          name: "diagram.png",
          type: "image/png",
          size: bytes.length,
          bytes,
        },
      ],
    ],
  ]);

  const plan = build(true, attachments);

  // Binary written under attachments/.
  const bin = plan.binaries.find((b) => b.path === "attachments/att-9.png");
  assert.ok(bin);
  assert.equal(bin.bytes.toString(), "PNGDATA");

  // Body image ref rewritten to the relative attachment path.
  const ship = plan.files.find((f) => f.path.endsWith("Ship v1.md"));
  assert.ok(ship);
  assert.match(ship.text, /!\[[^\]]*\]\(attachments\/att-9\.png\)/);

  // Manifest links task -> attachment -> file.
  const manifestAtt = plan.manifest.attachments.find((a) => a.id === "att-9");
  assert.equal(manifestAtt?.file, "attachments/att-9.png");
  const manifestTask = plan.manifest.tasks.find((t) => t.sourceTaskId === "task-1");
  assert.deepEqual(manifestTask?.attachmentIds, ["att-9"]);
  assert.equal(plan.manifest.counts.attachmentsDownloaded, 1);

  const parsed = ManifestSchema.safeParse(plan.manifest);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});
