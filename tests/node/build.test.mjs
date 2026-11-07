import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../scripts/build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "src", "index.html");
const PLACEHOLDERS = ["__FONT700__", "__FONT800__", "__FONTAZ__", "/*QRLIB*/", "/*ZIPLIB*/"];

const tmp = () => mkdtemp(join(tmpdir(), "rbl-build-"));
async function built() {
  const out = await tmp();
  try { const n = await build({ out }); return { html: await readFile(join(out, "index.html"), "utf8"), n }; }
  finally { await rm(out, { recursive: true, force: true }); }
}

test("the source page has every placeholder the build needs", async () => {
  const html = await readFile(src, "utf8");
  for (const p of PLACEHOLDERS) assert.ok(html.includes(p), `${p} missing from src/index.html`);
});

test("builds one page and reports its size", async () => {
  const { html, n } = await built();
  assert.equal(n, html.length);
  assert.ok(html.length > 200_000, "fonts and libraries should make it large");
  assert.ok(html.startsWith("<!doctype html>") || html.startsWith("<!DOCTYPE html>"));
});

test("leaves no placeholder behind", async () => {
  const { html } = await built();
  for (const p of PLACEHOLDERS) assert.ok(!html.includes(p), `${p} was not replaced`);
});

test("inlines the three fonts as base64 woff2", async () => {
  const { html } = await built();
  const fonts = [...html.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)];
  assert.equal(fonts.length, 3);
  for (const [, b64] of fonts) {
    const head = Buffer.from(b64.slice(0, 8), "base64").subarray(0, 4).toString("latin1");
    assert.equal(head, "wOF2", "not a woff2 file");
  }
});

test("inlines the QR and ZIP libraries", async () => {
  const { html } = await built();
  assert.match(html, /QR Code Generator for JavaScript/);
  assert.match(html, /JSZip/);
  assert.match(html, /qrcode\s*=\s*function|var qrcode|qrcode=function/);
});

test("script tags stay balanced, so no library can close one early", async () => {
  const { html } = await built();
  const opens = (html.match(/<script[\s>]/g) || []).length;
  const closes = (html.match(/<\/script>/g) || []).length;
  assert.equal(opens, closes);
});

test("is fully self-contained: no external loads and no runtime network calls", async () => {
  const { html } = await built();
  const external = html.match(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*\b(?:src|href)=["']https?:/gi);
  assert.equal(external, null, `external resource: ${external}`);
  assert.doesNotMatch(html, /@import\s/);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/);
  assert.doesNotMatch(html, /\bfetch\(/);
  assert.doesNotMatch(html, /XMLHttpRequest|WebSocket|sendBeacon/);
});

test("the only outgoing links are the source and license links", async () => {
  const { html } = await built();
  const links = [...html.matchAll(/<a\b[^>]*\bhref="(https?:[^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(links, ["https://github.com/arbrick/router-bit-label-maker", "https://www.gnu.org/licenses/agpl-3.0.html"]);
});

test("is reproducible", async () => {
  const [a, b] = [await built(), await built()];
  assert.equal(a.html, b.html);
});

test("the default build writes dist/index.html", async () => {
  const n = await build();
  assert.equal((await readFile(join(root, "dist", "index.html"), "utf8")).length, n);
});

for (const p of PLACEHOLDERS) {
  test(`fails loudly when ${p} is missing from the source`, async () => {
    const dir = await tmp();
    try {
      const bad = join(dir, "index.html");
      await writeFile(bad, (await readFile(src, "utf8")).split(p).join(""));
      await assert.rejects(build({ src: bad, out: join(dir, "out") }), (e) => e.message.includes(p) && /missing/.test(e.message));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("fails when the source file does not exist", async () => {
  await assert.rejects(build({ src: join(tmpdir(), "rbl-nope", "index.html"), out: await tmp() }), /ENOENT/);
});
