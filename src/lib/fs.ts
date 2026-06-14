/**
 * Flush a VaultPlan to disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { VaultPlan } from "./vault.js";

export async function writeVault(
  outDir: string,
  plan: VaultPlan,
): Promise<void> {
  for (const file of plan.files) {
    const full = resolve(outDir, file.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.text, "utf8");
  }
  for (const bin of plan.binaries) {
    const full = resolve(outDir, bin.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bin.bytes);
  }
}
