import "./build-desktop.ts";
import { resolve } from "node:path";
const root = resolve("desktop/dist");
Bun.serve({
  hostname: "127.0.0.1",
  port: 1420,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const name =
      path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    if (!["index.html", "app.js", "style.css", "logo.svg"].includes(name))
      return new Response("Not found", { status: 404 });
    return new Response(Bun.file(resolve(root, name)));
  },
});
console.log("Desktop preview: http://127.0.0.1:1420");
