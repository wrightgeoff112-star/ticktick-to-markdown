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

test("超长中文及控制字符标题可保存，原始标题仍保留", () => {
  const csv = parseDidaCsv("taskId,Title,List Name\n1,测试,列表");
  const title = "很长的标题".repeat(300) + "\u007f\u0080";
  csv.tasks[0]!.title = title;
  csv.lists[0]!.title = "很长的列表".repeat(300);
  const plan = buildVault({
    csv,
    host: resolveHost("dida365"),
    csvPath: "backup.csv",
    withImages: false,
    toolVersion: "test",
  });
  const file = plan.files[0]!;
  assert.ok(Buffer.byteLength(file.path) < 240);
  assert.doesNotMatch(file.path, /\p{Cc}/u);
  assert.ok(file.text.includes("# " + title));
  assert.equal(plan.manifest.tasks[0]!.title, title);
});

test("Windows保留名称、大小写与截断冲突不覆盖文字或附件", () => {
  const csv = parseDidaCsv(
    "taskId,Title,List Name\n1,CON,attachments\n2,con,ATTACHMENTS\n3,A,列表\n4,a,列表\n5,NUL.txt,列表",
  );
  const plan = buildVault({
    csv,
    host: resolveHost("dida365"),
    csvPath: "backup.csv",
    withImages: true,
    toolVersion: "test",
    attachmentsByTask: new Map([
      [
        "1",
        [
          {
            id: "CON",
            taskId: "1",
            name: "x.md",
            type: "text/plain",
            bytes: new Uint8Array([1]),
          },
        ],
      ],
    ]),
  });
  const paths = [...plan.files, ...plan.binaries].map((f) =>
    f.path.toLowerCase(),
  );
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths)
    for (const part of path.split("/"))
      assert.doesNotMatch(
        part,
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i,
      );
  assert.notEqual(
    plan.manifest.tasks[0]!.file.split("/")[0]!.toLowerCase(),
    "attachments",
  );
  assert.notEqual(
    plan.manifest.tasks[0]!.file.split("/")[0]!.toLowerCase(),
    plan.manifest.tasks[1]!.file.split("/")[0]!.toLowerCase(),
  );
});

test("3000条重复标题去重近似线性且文件完整", () => {
  const csv = parseDidaCsv(
    "taskId,Title,List Name\n" +
      Array.from({ length: 3000 }, (_, i) => `${i},重复,列表`).join("\n"),
  );
  let reads = 0;
  const has = Set.prototype.has;
  Set.prototype.has = function (value: unknown) {
    reads++;
    return has.call(this, value);
  };
  try {
    const plan = buildVault({
      csv,
      host: resolveHost("dida365"),
      csvPath: "backup.csv",
      withImages: false,
      toolVersion: "test",
    });
    assert.equal(plan.manifest.tasks.length, 3000);
    assert.equal(new Set(plan.manifest.tasks.map((t) => t.file)).size, 3000);
    assert.ok(reads < 30000, `Set reads: ${reads}`);
  } finally {
    Set.prototype.has = has;
  }
});
