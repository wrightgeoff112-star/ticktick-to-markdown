#!/usr/bin/env tsx
/**
 * Backfill missing frontmatter fields (created / parent / tags / repeat /
 * priority / folder) in an already-exported vault, using a CSV as the source
 * of truth. Reuses the project's own parser + frontmatter builder so values
 * stay consistent with a fresh export.
 *
 * Only the YAML frontmatter is rewritten. The note body and every image
 * reference are left byte-for-byte untouched — no images are re-fetched.
 *
 * Alignment key: the vault file's `sourceTaskId` ↔ the CSV's `taskId`.
 *
 * Usage:
 *   tsx src/backfill.ts --csv <path.csv> --vault <vault-dir>           # dry-run
 *   tsx src/backfill.ts --csv <path.csv> --vault <vault-dir> --write   # apply
 */
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDidaCsv } from "./lib/csv.js";
import { buildFrontmatter } from "./lib/vault.js";

interface Args {
  csv: string;
  vault: string;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { csv: "", vault: "", write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === "--csv") a.csv = argv[(i += 1)] ?? "";
    else if (t === "--vault") a.vault = argv[(i += 1)] ?? "";
    else if (t === "--write") a.write = true;
  }
  if (!a.csv || !a.vault) {
    console.error(
      "用法: tsx src/backfill.ts --csv <path.csv> --vault <vault-dir> [--write]",
    );
    process.exit(2);
  }
  return a;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SOURCE_ID_RE = /^sourceTaskId:\s*(.+?)\s*$/m;

function parseFmKV(fm: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of fm.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) m.set(k, v);
  }
  return m;
}

function unquote(v: string): string {
  return v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

async function walkMd(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    if (name === ".obsidian" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walkMd(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const csvText = await readFile(args.csv, "utf8");
  const csv = parseDidaCsv(csvText);

  const listById = new Map(csv.lists.map((l) => [l.id, l]));
  const folderById = new Map(csv.folders.map((f) => [f.id, f]));

  const fmBySourceId = new Map<string, string>();
  for (const task of csv.tasks) {
    if (!task.sourceTaskId) continue;
    const list = task.listId ? listById.get(task.listId) : undefined;
    const folderTitle = list?.folderId
      ? (folderById.get(list.folderId)?.title ?? null)
      : null;
    fmBySourceId.set(
      task.sourceTaskId,
      buildFrontmatter(task, list?.title ?? null, folderTitle),
    );
  }

  const files = await walkMd(args.vault);
  let matched = 0;
  let unmatched = 0;
  let noId = 0;
  let written = 0;
  const addedKey = new Map<string, number>();
  const changedKey = new Map<string, number>();
  const samples: { path: string; before: string; after: string }[] = [];
  const unmatchedSamples: string[] = [];

  for (const path of files) {
    const raw = await readFile(path, "utf8");
    const m = raw.match(FM_RE);
    if (!m) {
      noId += 1;
      continue;
    }
    const oldFm = m[1] ?? "";
    const rest = raw.slice(m[0].length);
    const body = rest.replace(/^[\r\n]+/, "");

    const idMatch = oldFm.match(SOURCE_ID_RE);
    const sid = idMatch ? unquote(idMatch[1] ?? "") : "";
    if (!sid) {
      noId += 1;
      continue;
    }
    const newFm = fmBySourceId.get(sid) ?? null;
    if (!newFm) {
      unmatched += 1;
      if (unmatchedSamples.length < 8) unmatchedSamples.push(`${sid}  <=  ${path}`);
      continue;
    }

    matched += 1;

    const oldKV = parseFmKV(oldFm);
    const newFmInner = newFm.replace(/^---\r?\n/, "").replace(/\r?\n---$/, "");
    const newKV = parseFmKV(newFmInner);
    for (const [k, v] of newKV) {
      if (!oldKV.has(k)) addedKey.set(k, (addedKey.get(k) ?? 0) + 1);
      else if (oldKV.get(k) !== v) changedKey.set(k, (changedKey.get(k) ?? 0) + 1);
    }

    if (samples.length < 2) {
      samples.push({ path, before: m[0].replace(/\n$/, ""), after: newFm });
    }

    if (args.write) {
      const out = `${newFm}\n\n${body}`;
      await writeFile(path, out, "utf8");
      written += 1;
    }
  }

  console.log(`扫描 md:        ${files.length}`);
  console.log(`可补全(matched): ${matched}`);
  console.log(`CSV 未找到(unmatched): ${unmatched}`);
  console.log(`无 frontmatter/无 sourceTaskId: ${noId}`);
  console.log(args.write ? `已写入:         ${written}` : "(dry-run，未写盘。加 --write 落盘)");

  console.log("\n新增字段统计（旧没有、新多出来的 key → 影响多少文件）:");
  for (const [k, v] of [...addedKey].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n值变化字段统计（同 key 但值不同 → 多少文件）:");
  const changed = [...changedKey].sort((a, b) => b[1] - a[1]);
  if (changed.length === 0) console.log("  (无)");
  for (const [k, v] of changed) console.log(`  ${k}: ${v}`);

  if (unmatchedSamples.length > 0) {
    console.log("\nunmatched 样例（md 里有但 CSV 里没有的 taskId）:");
    for (const s of unmatchedSamples) console.log(`  ${s}`);
  }

  for (const s of samples) {
    console.log(`\n样例: ${s.path}`);
    console.log("--- 旧 frontmatter ---");
    console.log(s.before);
    console.log("--- 新 frontmatter ---");
    console.log(s.after);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
