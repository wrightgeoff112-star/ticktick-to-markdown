import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDidaCsv } from "../lib/csv.js";
import { resolveHost } from "../lib/host.js";
import { ManifestSchema } from "../lib/manifest.js";
import { buildVault, type ResolvedAttachment } from "../lib/vault.js";
import { SAMPLE_CSV } from "./fixtures.js";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function build(
  withImages: boolean,
  attachments?: Map<string, ResolvedAttachment[]>,
) {
  const csv = parseDidaCsv(SAMPLE_CSV);
  return buildVault({
    csv,
    host: resolveHost("dida365"),
    csvPath: "/tmp/TickTick.csv",
    withImages,
    toolVersion: "0.1.0",
    now: NOW,
    ...(attachments ? { attachmentsByTask: attachments } : {}),
    gaps: withImages ? [] : [{ code: "images_disabled", message: "no images" }],
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
  // TickTick 的时段头尾 → start / end（不是 due）。due 保留给真截止，滴答不产生。
  assert.match(ship.text, /\nstart: /);
  assert.match(ship.text, /\nend: /);
  assert.doesNotMatch(ship.text, /\ndue: /);
  assert.match(ship.text, /\npriority: 3\n/);
  assert.match(ship.text, /\ntags: \[release, urgent\]\n/);
  assert.match(
    ship.text,
    /\nrepeat: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"\n/,
  );
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
  assert.match(ship.text, /!\[[^\]]*\]\(\.\.\/attachments\/att-9\.png\)/);

  // Manifest links task -> attachment -> file.
  const manifestAtt = plan.manifest.attachments.find((a) => a.id === "att-9");
  assert.equal(manifestAtt?.file, "attachments/att-9.png");
  const manifestTask = plan.manifest.tasks.find(
    (t) => t.sourceTaskId === "task-1",
  );
  assert.deepEqual(manifestTask?.attachmentIds, ["att-9"]);
  assert.equal(plan.manifest.counts.attachmentsDownloaded, 1);

  const parsed = ManifestSchema.safeParse(plan.manifest);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});
test("首图失败不会把第二张附件错贴到第一张引用", () => {
  const csv = parseDidaCsv(
    'taskId,Title,Content\n1,图,"![a](first/a.png) ![b](second/b.png)"',
  );
  const plan = buildVault({
    csv,
    host: resolveHost("dida365"),
    csvPath: "backup.csv",
    rawCsv: "original",
    withImages: true,
    toolVersion: "1",
    attachmentsByTask: new Map([
      [
        "1",
        [
          {
            id: "first",
            taskId: "1",
            name: "a.png",
            type: "image/png",
            bytes: null,
          },
          {
            id: "second",
            taskId: "1",
            name: "b.png",
            type: "image/png",
            bytes: new Uint8Array([1]),
          },
        ],
      ],
    ]),
  });
  const md = plan.files.find((f) => f.path.endsWith(".md"))!.text;
  assert.match(md, /!\[a\]\(first\/a.png\)/);
  assert.match(md, /!\[b\]\(\.\.\/attachments\/second.png\)/);
  assert.equal(plan.manifest.source.csvFile, "backup.csv");
});

test("普通文件在 Markdown 中有可点击的相对链接", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const plan = build(
    true,
    new Map([
      [
        "task-1",
        [
          {
            id: "csv-file",
            taskId: "task-1",
            name: "资料 [最终].csv",
            type: "text/csv",
            size: 3,
            bytes,
          },
        ],
      ],
    ]),
  );
  const note = plan.files.find((f) => f.path.endsWith("Ship v1.md"))!;
  assert.match(note.text, /## 附件/);
  assert.ok(
    note.text.includes("[资料 \\[最终\\].csv](<../attachments/csv-file.csv>)"),
  );
  const manifestPath = plan.manifest.attachments[0]!.file!;
  assert.ok(plan.binaries.some((b) => b.path === manifestPath));
});

test("Markdown 正文图片使用相对于笔记文件的路径", () => {
  const plan = build(
    true,
    new Map([
      [
        "task-1",
        [
          {
            id: "att-9",
            taskId: "task-1",
            name: "diagram.png",
            type: "image/png",
            bytes: new Uint8Array([1]),
          },
        ],
      ],
    ]),
  );
  const note = plan.files.find((f) => f.path.endsWith("Ship v1.md"))!;
  assert.match(note.text, /!\[[^\]]*\]\(\.\.\/attachments\/att-9\.png\)/);
});
