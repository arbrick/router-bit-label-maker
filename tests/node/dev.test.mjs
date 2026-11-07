import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get, request } from "node:http";
import { readFile, utimes } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNIPPET = '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>';

// Starts the dev server on a free port; resolves once it says where it is listening.
function start(args = [], env = {}) {
  const proc = spawn(process.execPath, ["scripts/dev.mjs", ...args], { cwd: root, env: { ...process.env, PORT: "0", ...env } });
  return new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", (d) => { out += d; const m = out.match(/serving on http:\/\/localhost:(\d+)/); if (m) resolve({ proc, port: Number(m[1]), log: () => out }); });
    proc.on("exit", (code) => reject(new Error(`dev server exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`dev server did not start: ${out}`)), 20_000).unref();
  });
}
const stop = (s) => new Promise((r) => { s.proc.removeAllListeners("exit"); s.proc.on("exit", r); s.proc.kill(); });
const fetchText = (port, path) => new Promise((resolve, reject) => {
  request({ port, path, host: "127.0.0.1" }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body })); }).on("error", reject).end();
});
// Opens the reload stream and lets a test wait for text to arrive on it.
function stream(port) {
  return new Promise((resolve, reject) => {
    const req = get({ port, path: "/__reload", host: "127.0.0.1" }, (res) => {
      let buf = ""; const waiters = [];
      res.setEncoding("utf8");
      res.on("data", (d) => { buf += d; for (const w of [...waiters]) if (buf.includes(w.text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } });
      resolve({
        res, status: res.statusCode, headers: res.headers, text: () => buf, close: () => req.destroy(),
        waitFor: (text, ms = 10_000) => new Promise((ok, no) => {
          if (buf.includes(text)) return ok();
          waiters.push({ text, resolve: ok }); setTimeout(() => no(new Error(`never received "${text}"; got ${JSON.stringify(buf)}`)), ms).unref();
        }),
      });
    });
    req.on("error", reject);
  });
}
const touchSource = () => { const now = new Date(); return utimes(join(root, "src", "index.html"), now, now); };

test("--no-watch serves the built page with the printing headers", async () => {
  const s = await start(["--no-watch"]);
  try {
    const r = await fetchText(s.port, "/");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^text\/html; charset=utf-8$/);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["permissions-policy"], "usb=(self), serial=(self)");
    assert.equal(r.body, await readFile(join(root, "dist", "index.html"), "utf8"));
    assert.ok(!r.body.includes("/__reload"), "no reload script without watching");
    assert.equal((await fetchText(s.port, "/index.html")).status, 200);
  } finally { await stop(s); }
});

test("--no-watch has no reload endpoint, and other paths are 404", async () => {
  const s = await start(["--no-watch"]);
  try {
    for (const p of ["/__reload", "/nope", "/dist/index.html", "/../package.json", "/src/index.html"]) assert.equal((await fetchText(s.port, p)).status, 404, p);
  } finally { await stop(s); }
});

test("reports the port it chose", async () => {
  const s = await start(["--no-watch"]);
  try { assert.match(s.log(), /localhost:\d+/); assert.equal((await fetchText(s.port, "/")).status, 200); } finally { await stop(s); }
});

for (const [name, env] of [["file events", {}], ["polling", { WATCH_POLL: "1" }]]) {
  test(`watch mode (${name}) injects the reload script before </body>`, async () => {
    const s = await start([], env);
    try {
      const { body } = await fetchText(s.port, "/");
      assert.ok(body.includes(SNIPPET));
      assert.ok(body.trimEnd().endsWith(`${SNIPPET}</body>\n</html>`) || body.includes(`${SNIPPET}</body>`));
      assert.equal(body.split(SNIPPET).length - 1, 1);
    } finally { await stop(s); }
  });

  test(`watch mode (${name}) tells open pages to reload after a rebuild`, async () => {
    const s = await start([], env);
    const a = await stream(s.port), b = await stream(s.port);
    try {
      assert.equal(a.status, 200);
      assert.equal(a.headers["content-type"], "text/event-stream");
      assert.equal(a.headers["cache-control"], "no-store");
      await a.waitFor(": connected"); await b.waitFor(": connected");
      await touchSource();
      await a.waitFor("data: reload"); await b.waitFor("data: reload");   // every open page is told
      assert.match(s.log(), /rebuilt/);
    } finally { a.close(); b.close(); await stop(s); }
  });
}

test("a closed page is dropped and the server keeps working", async () => {
  const s = await start([], { WATCH_POLL: "1" });
  try {
    const a = await stream(s.port); await a.waitFor(": connected"); a.close();
    const b = await stream(s.port); await b.waitFor(": connected");
    await touchSource(); await b.waitFor("data: reload");
    b.close();
    assert.equal((await fetchText(s.port, "/")).status, 200);
  } finally { await stop(s); }
});

test("the rebuilt page is what gets served next", async () => {
  const s = await start([], { WATCH_POLL: "1" });
  const a = await stream(s.port);
  try {
    await a.waitFor(": connected");
    await touchSource(); await a.waitFor("data: reload");
    const { body } = await fetchText(s.port, "/");
    assert.ok(body.includes("Router bit label system"));
  } finally { a.close(); await stop(s); }
});
