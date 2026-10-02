import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await mkdir("desktop/dist", { recursive: true });
await build({
  entryPoints: ["desktop/src/main.ts"],
  bundle: true,
  outfile: "desktop/dist/app.js",
  platform: "browser",
  format: "esm",
  target: "es2022",
});
for (const name of ["index.html", "style.css"])
  await copyFile(`desktop/${name}`, `desktop/dist/${name}`);
await copyFile("desktop/assets/logo.svg", "desktop/dist/logo.svg");
