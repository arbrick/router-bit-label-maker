// Local dev server: builds, serves dist/ on http://localhost:8000 and rebuilds when src/ changes.
// localhost counts as a secure origin, so WebUSB / Web Serial printing works here in Chrome or Edge.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || "127.0.0.1";
const noWatch = process.argv.includes("--no-watch");

await build();
console.log("built dist/index.html");

if (!noWatch) {
  let timer;
  watch(join(root, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await build(); console.log(`rebuilt ${new Date().toLocaleTimeString()} — reload the page`); }
      catch (e) { console.error("build failed:", e.message); }
    }, 150);
  });
}

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path !== "/" && path !== "/index.html") { res.writeHead(404).end("not found"); return; }
  try {
    const body = await readFile(join(root, "dist", "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Permissions-Policy": "usb=(self), serial=(self)",
    }).end(body);
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(port, host, () => console.log(`serving on http://localhost:${port}${noWatch ? "" : " (watching src/)"}`));
