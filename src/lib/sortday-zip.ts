/**
 * Flush a SortdayBundle to a `.sortday.zip` buffer.
 *
 * Layout (matches sortday's SDX import expectations):
 *   sortday-export.json        the SDX manifest
 *   attachments/<id>.<ext>     attachment binaries (STORE — already compressed)
 */

import JSZip from "jszip";

import { SDX_MANIFEST_FILENAME, type SortdayBundle } from "./sortday-bundle.js";

export async function buildSortdayZipBuffer(
  bundle: SortdayBundle,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    SDX_MANIFEST_FILENAME,
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  );
  for (const bin of bundle.binaries) {
    zip.file(bin.path, bin.bytes, { compression: "STORE" });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
