#!/usr/bin/env node
/**
 * ticktick-export CLI.
 *
 * Usage:
 *   ticktick-export <export.csv> [--out vault] [--with-images] [--host dida365|ticktick]
 */

import { resolve } from "node:path";

import { CsvFormatError } from "./lib/csv.js";
import { resolveHost } from "./lib/host.js";
import { runExport } from "./lib/export.js";
import { writeVault } from "./lib/fs.js";

const TOOL_VERSION = "0.1.0";

interface ParsedArgs {
  csvPath: string | null;
  out: string;
  withImages: boolean;
  host: string;
  help: boolean;
  version: boolean;
}

const HELP = `ticktick-export — Export TickTick / 滴答清单 to an Obsidian/Markdown vault.

USAGE
  ticktick-export <export.csv> [options]

ARGUMENTS
  <export.csv>          Path to the CSV downloaded from the TickTick/滴答 web app
                        (Settings → Export → Backup). Required. This is the
                        official, cross-platform, compliant data source.

OPTIONS
  --out <dir>           Output vault directory. Default: ./vault
  --with-images         Also fetch attachment images via the cookie-direct engine.
                        ⚠ macOS + Chrome + dida365 ONLY. Uses TickTick's UNOFFICIAL
                        internal API — it may break at any time. Use at your own risk.
  --host <id>           dida365 (国内, default, images verified) or
                        ticktick (海外, EXPERIMENTAL — image path unverified).
  -h, --help            Show this help.
  -v, --version         Show version.

MODES
  Default (CSV only)    Cross-platform. Produces a complete vault WITHOUT images.
  --with-images         macOS-only image enrichment on top of the CSV.

OUTPUT (vault/)
  <list>/<task>.md      One markdown file per task, YAML frontmatter + body.
  attachments/<id>.<ext> Downloaded attachment bytes (only with --with-images).
  manifest.json         Machine-readable source of truth (schemaVersion, task /
                        project / attachment -> file mapping, and an honest list
                        of gaps — what could not be captured and why).

EXAMPLES
  ticktick-export ./TickTick.csv
  ticktick-export ./TickTick.csv --out ~/Obsidian/TickTick
  ticktick-export ./滴答清单.csv --with-images
  ticktick-export ./TickTick.csv --with-images --host ticktick   # experimental

DISCLAIMER
  --with-images uses an unofficial, internal API and reads your local Chrome
  cookie. It is not endorsed by TickTick/滴答. You are solely responsible for
  any use. The default CSV-only mode uses only the official export.
`;

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    csvPath: null,
    out: "vault",
    withImages: false,
    host: "dida365",
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      case "--with-images":
        out.withImages = true;
        break;
      case "--out": {
        const value = argv[i + 1];
        if (!value || value.startsWith("-")) {
          throw new UsageError("--out 需要一个目录参数 / --out requires a directory.");
        }
        out.out = value;
        i += 1;
        break;
      }
      case "--host": {
        const value = argv[i + 1];
        if (!value || value.startsWith("-")) {
          throw new UsageError("--host 需要 dida365 或 ticktick / --host requires a value.");
        }
        out.host = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("--out=")) {
          out.out = arg.slice("--out=".length);
        } else if (arg.startsWith("--host=")) {
          out.host = arg.slice("--host=".length);
        } else if (arg.startsWith("-")) {
          throw new UsageError(`未知参数 / unknown option: ${arg}`);
        } else if (out.csvPath === null) {
          out.csvPath = arg;
        } else {
          throw new UsageError(`只接受一个 CSV 路径，多余参数 / unexpected argument: ${arg}`);
        }
    }
  }

  return out;
}

class UsageError extends Error {}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误 / Error: ${error.message}\n\n`);
      process.stderr.write("运行 ticktick-export --help 查看用法。\n");
      return 2;
    }
    throw error;
  }

  if (args.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.csvPath) {
    process.stderr.write(
      "错误 / Error: 缺少 CSV 文件路径。\n" +
        "请从滴答/TickTick 网页端「设置 → 导出」下载 CSV，再传给本工具。\n\n",
    );
    process.stdout.write(HELP);
    return 2;
  }

  let host;
  try {
    host = resolveHost(args.host);
  } catch (error) {
    process.stderr.write(`错误 / Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const outDir = resolve(process.cwd(), args.out);

  try {
    const { plan, csv } = await runExport({
      csvPath: resolve(process.cwd(), args.csvPath),
      host,
      withImages: args.withImages,
      toolVersion: TOOL_VERSION,
      onProgress: (m) => process.stderr.write(`${m}\n`),
    });

    for (const warning of csv.warnings) {
      process.stderr.write(`提示 / Note: ${warning}\n`);
    }

    await writeVault(outDir, plan);

    const { counts, gaps } = plan.manifest;
    process.stdout.write(`\n完成 / Done.\n`);
    process.stdout.write(`  Vault / 目录: ${outDir}\n`);
    process.stdout.write(
      `  任务 / tasks: ${counts.tasks}\n` +
        `  清单 / projects: ${counts.projects}\n` +
        `  附件下载 / attachments downloaded: ${counts.attachmentsDownloaded}\n`,
    );
    if (gaps.length > 0) {
      process.stdout.write(
        `  缺口 / gaps: ${gaps.length}（详见 manifest.json 的 "gaps" 字段）\n`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof CsvFormatError) {
      process.stderr.write(`CSV 格式错误 / CSV format error:\n${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `导出失败 / Export failed:\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      `未捕获错误 / Unexpected error:\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
