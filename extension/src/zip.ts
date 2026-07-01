/**
 * 把 VaultPlan 打包成 zip Blob 并触发浏览器下载。
 *
 * 与 Node CLI（fs.ts 的 writeVault 写磁盘）对应：扩展侧没有文件系统访问，
 * 改为 JSZip 内存打包 + <a download> 触发下载。复用根 vault.ts 的 VaultPlan 类型。
 */

import JSZip from "jszip";
import type { VaultPlan } from "../../src/lib/vault.js";

/** 将 vault 计划（markdown + manifest + 附件字节）打包成单个 zip Blob。 */
export async function zipVaultPlan(plan: VaultPlan): Promise<Blob> {
  const zip = new JSZip();
  for (const file of plan.files) {
    zip.file(file.path, file.text);
  }
  for (const bin of plan.binaries) {
    zip.file(bin.path, bin.bytes);
  }
  return zip.generateAsync({ type: "blob" });
}

/** 用 <a download> 触发浏览器下载，随后释放 object URL。 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 下一轮事件循环再释放，确保点击已生效。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
