import JSZip from "jszip";
import { test, expect } from "./helpers.mjs";

// Replaces the claude.ai downloads capability with one that records what the page tried to save.
const capture = (page, behaviour = "ok") => page.evaluate((behaviour) => {
  window.saved = [];
  dl = { save: async ({ filename, data }) => {
    if (behaviour === "declined") { const e = new Error("no"); e.code = "declined"; throw e; }
    if (behaviour === "fail") { const e = new Error("boom"); e.code = "disk_full"; throw e; }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
    window.saved.push({ filename, bytes: Array.from(bytes) });
    return true;
  } };
}, behaviour);
const lastSaved = async (page) => {
  await page.waitForFunction(() => window.saved.length > 0);
  const s = await page.evaluate(() => window.saved.at(-1));
  return { filename: s.filename, buf: Buffer.from(s.bytes) };
};
const png = (buf) => ({ ok: buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

test.describe("PNG", () => {
  test("saves the current label at the chosen scale", async ({ app }) => {
    await capture(app);
    const w = await app.evaluate(() => { const cv = document.createElement("canvas"); renderLabel(cv, cur); return cv.width; });
    await app.click("#savePng");
    const { filename, buf } = await lastSaved(app);
    expect(filename).toBe("RB_STR_1-2_1-2_Whiteside_1072.png");
    expect(png(buf)).toEqual({ ok: true, w: w * 4, h: 256 });   // 4x is the default
  });

  for (const k of [1, 8]) {
    test(`scale ${k}x gives ${64 * k} dots tall`, async ({ app }) => {
      await capture(app);
      await app.selectOption("#scale", String(k));
      await app.click("#savePng");
      expect(png((await lastSaved(app)).buf).h).toBe(64 * k);
    });
  }

  test("a list entry's PNG button saves that entry", async ({ app }) => {
    await app.fill("#model", "ZZ9"); await app.click("#addList");
    await capture(app);
    await app.locator("#list").getByRole("button", { name: "PNG" }).click();
    const { filename, buf } = await lastSaved(app);
    expect(filename).toContain("ZZ9");
    expect(png(buf).ok).toBe(true);
  });

  test("scaling uses hard pixel edges (no smoothing)", async ({ app }) => {
    await capture(app);
    await app.click("#savePng");
    const { buf } = await lastSaved(app);
    const grey = await app.evaluate(async (bytes) => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
      const c = cv.getContext("2d"); c.drawImage(bmp, 0, 0);
      const d = c.getImageData(0, 0, cv.width, cv.height).data; let g = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== 0 && d[i] !== 255) g++;
      return g;
    }, Array.from(buf));
    expect(grey).toBe(0);
  });
});

test.describe("ZIP", () => {
  test("bundles one PNG per entry and numbers duplicate names", async ({ app }) => {
    await app.fill("#bid", "001"); await app.click("#addList");
    await app.fill("#bid", "002"); await app.click("#addList");     // same design, same file name
    await app.fill("#model", "OTHER"); await app.fill("#bid", "003"); await app.click("#addList");
    await capture(app);
    await app.click("#zipAll");
    const { filename, buf } = await lastSaved(app);
    expect(filename).toBe("router-bit-labels.zip");
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual([
      "RB_STR_1-2_1-2_Whiteside_1072.png", "RB_STR_1-2_1-2_Whiteside_1072_2.png", "RB_STR_1-2_1-2_Whiteside_OTHER.png"]);
    for (const f of Object.values(zip.files)) expect(png(await f.async("nodebuffer")).ok).toBe(true);
  });

  test("the whole sample set zips to 16 PNGs", async ({ app }) => {
    await app.click("#loadSamples");
    await capture(app);
    await app.click("#zipAll");
    const zip = await JSZip.loadAsync((await lastSaved(app)).buf);
    expect(Object.keys(zip.files)).toHaveLength(16);
  });

  test("refuses an empty list", async ({ app }) => {
    await capture(app);
    await app.click("#zipAll");
    await expect(app.locator("#toast")).toHaveText("List is empty");
    expect(await app.evaluate(() => saved.length)).toBe(0);
  });
});

test.describe("CSV", () => {
  const csvOf = async (app) => { await capture(app); await app.click("#saveCsv"); return (await lastSaved(app)).buf.toString("utf8"); };

  test("has the documented header and one row per entry", async ({ app }) => {
    await app.fill("#bid", "001"); await app.click("#addList");
    await app.click('.pick[data-id="CHM"]'); await app.fill("#key", "45°"); await app.fill("#bid", "002"); await app.click("#addList");
    const lines = (await csvOf(app)).split("\r\n");
    expect(lines[0]).toBe("id,link,type_code,type,shank,key_kind,key_size,cutter_dia,cut_length,overall_length,brand,model,qr_payload");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("001,HTTP://BITS.LAN/B/001,STR,Straight");
    expect(lines[2]).toContain("002,HTTP://BITS.LAN/B/002,CHM,");
    expect(lines[2]).toContain(",ang,45°,");
  });

  test("quotes cells that contain commas, quotes or newlines", async ({ app }) => {
    await app.fill("#brand", 'Acme, "Pro"'); await app.click("#addList");
    await app.evaluate(() => { list[0].model = "line1\nline2"; persist(); });   // a one-line <input> can't hold a newline, an imported list can
    const csv = await csvOf(app);
    expect(csv).toContain('"Acme, ""Pro"""');
    expect(csv).toContain('"line1\nline2"');
  });

  test("includes the exact QR payload that is printed", async ({ app }) => {
    await app.click("#addList");
    const csv = await csvOf(app);
    const payload = await app.evaluate(() => payloadFor(list[0]));
    expect(csv.split("\r\n")[1].endsWith(payload)).toBe(true);
  });

  test("link column is empty for entries without an ID", async ({ app }) => {
    await app.fill("#bid", ""); await app.click("#addList");
    const row = (await csvOf(app)).split("\r\n")[1];
    expect(row.startsWith(",,STR,")).toBe(true);
  });

  test("refuses an empty list", async ({ app }) => {
    await capture(app);
    await app.click("#saveCsv");
    await expect(app.locator("#toast")).toHaveText("List is empty");
  });
});

test.describe("PDF", () => {
  const pdfOf = async (app, page = "12") => { await capture(app); await app.selectOption("#pdfPage", page); await app.click("#savePdf"); return (await lastSaved(app)).buf; };
  const text = (buf) => buf.toString("latin1");

  test("is a well-formed one-label-per-page document", async ({ app }) => {
    await app.click("#loadSamples");
    await app.evaluate(() => { list = list.slice(0, 3); persist(); renderList(); });
    const buf = await pdfOf(app);
    const t = text(buf);
    expect(t.startsWith("%PDF-1.4")).toBe(true);
    expect(t.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(t).toContain("/Count 3");
    expect(t.match(/\/Type \/Page /g)).toHaveLength(3);
    expect(t.match(/\/Interpolate false/g)).toHaveLength(3);
    expect(t.match(/\/BitsPerComponent 1/g)).toHaveLength(3);
  });

  test("the cross-reference table points at every object", async ({ app }) => {
    await app.click("#loadSamples");
    await app.evaluate(() => { list = list.slice(0, 2); persist(); renderList(); });
    const t = text(await pdfOf(app));
    const xrefAt = Number(t.match(/startxref\n(\d+)\n/)[1]);
    expect(t.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const n = Number(t.slice(xrefAt).match(/xref\n0 (\d+)\n/)[1]);
    const entries = [...t.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(n - 1);
    entries.forEach((off, i) => expect(t.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(t).toContain(`/Size ${n}`);
  });

  test("page size follows the selection (34 mm wide; 12 or 9 mm tall)", async ({ app }) => {
    await app.click("#addList");
    const mm = (v) => (v * 72 / 25.4).toFixed(3);
    expect(text(await pdfOf(app, "12"))).toContain(`/MediaBox [0 0 ${mm(34)} ${mm(12)}]`);
    await app.evaluate(() => { window.saved = []; });
    expect(text(await pdfOf(app, "9"))).toContain(`/MediaBox [0 0 ${mm(34)} ${mm(9)}]`);
  });

  test("the label image is 9 mm tall on the page", async ({ app }) => {
    await app.click("#addList");
    const t = text(await pdfOf(app));
    const m = t.match(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/);
    expect(Number(m[2])).toBeCloseTo(9 * 72 / 25.4, 2);
  });

  test("uses compression when the browser supports it", async ({ app }) => {
    await app.click("#addList");
    expect(text(await pdfOf(app))).toContain("/FlateDecode");
  });

  test("refuses an empty list", async ({ app }) => {
    await capture(app);
    await app.click("#savePdf");
    await expect(app.locator("#toast")).toHaveText("List is empty — add bits first");
  });
});

test.describe("saving", () => {
  test("without the downloads capability the page explains how to save instead", async ({ app }) => {
    await app.click("#savePng");
    await expect(app.locator("#saveNote")).toContainText("Saving isn’t available in this view");
  });

  test("a declined save is silent", async ({ app }) => {
    await capture(app, "declined");
    await app.click("#savePng");
    await app.waitForTimeout(200);
    await expect(app.locator("#toast")).not.toHaveText("Saved");
    await expect(app.locator("#saveNote")).toHaveText("Tip: long-press or right-click the true-size image to save it.");
  });

  test("a failed save names the error", async ({ app }) => {
    await capture(app, "fail");
    await app.click("#savePng");
    await expect(app.locator("#saveNote")).toContainText("Save failed (disk_full)");
  });

  test("a successful save shows a toast", async ({ app }) => {
    await capture(app);
    await app.click("#savePng");
    await expect(app.locator("#toast")).toHaveText("Saved");
  });
});
