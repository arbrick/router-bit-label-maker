// Local dev server: builds, serves dist/ on http://localhost:8000, rebuilds when src/ changes and reloads open pages.
// localhost counts as a secure origin, so WebUSB / Web Serial printing works here in Chrome or Edge.
// Set WATCH_POLL=1 to poll for changes instead of using file events (needed on some bind-mounted Docker volumes).
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const port = process.env.PORT === undefined ? 8000 : Number(process.env.PORT);
const host = process.env.HOST || "127.0.0.1";
const noWatch = process.argv.includes("--no-watch");
const poll = process.env.WATCH_POLL === "1";

const clients = new Set();
const RELOAD_SNIPPET = '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>';

await build();
console.log("built dist/index.html");

async function rebuild() {
  try {
    await build();
    console.log(`rebuilt ${new Date().toLocaleTimeString()}`);
    for (const res of clients) res.write("data: reload\n\n");
  } catch (e) { console.error("build failed:", e.message); }
}

async function mtimes(dir) {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? await mtimes(p) : `${p}:${(await stat(p)).mtimeMs};`;
  }
  return out;
}

if (!noWatch) {
  let timer;
  const changed = () => { clearTimeout(timer); timer = setTimeout(rebuild, 150); };
  if (poll) {
    let last = await mtimes(srcDir);
    setInterval(async () => { const now = await mtimes(srcDir); if (now !== last) { last = now; changed(); } }, 500).unref();
  } else {
    watch(srcDir, { recursive: true }, changed);
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/__reload" && !noWatch) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (path !== "/" && path !== "/index.html") { res.writeHead(404).end("not found"); return; }
  try {
    let body = await readFile(join(root, "dist", "index.html"), "utf8");
    if (!noWatch) body = body.replace("</body>", `${RELOAD_SNIPPET}</body>`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Permissions-Policy": "usb=(self), serial=(self)",
    }).end(body);
  } catch (e) { res.writeHead(500).end(String(e)); }
});
server.listen(port, host, () => {
  console.log(`serving on http://localhost:${server.address().port}${noWatch ? "" : " (watching src/, pages reload on change)"}`);
});
