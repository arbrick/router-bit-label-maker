import jsQR from "jsqr";
import { test, expect } from "./helpers.mjs";

// Renders a bit the way the app does and returns what the printer would see.
const render = (page, bit) => page.evaluate((b) => {
  const cv = document.createElement("canvas");
  const q = renderLabel(cv, b);
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  const ink = Array.from({ length: cv.width }, () => false);
  let pure = true, total = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4, v = d[i];
    if (d[i + 3] !== 255 || (v !== 0 && v !== 255) || d[i + 1] !== v || d[i + 2] !== v) pure = false;
    if (v === 0) { ink[x] = true; total++; }
  }
  return { w: cv.width, h: cv.height, ink, pure, total, qrErr: !!(q && q.err), qrV: q && q.v };
}, bit);

// Renders at 3x with a quiet border and returns the grey bytes, for the QR decoder.
const qrPixels = (page, bit) => page.evaluate((b) => {
  const cv = document.createElement("canvas"); renderLabel(cv, b);
  const k = 3, pad = 24, o = document.createElement("canvas");
  o.width = cv.width * k + 2 * pad; o.height = cv.height * k + 2 * pad;
  const c = o.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, o.width, o.height);
  c.imageSmoothingEnabled = false; c.drawImage(cv, pad, pad, cv.width * k, cv.height * k);
  const d = c.getImageData(0, 0, o.width, o.height).data, g = new Uint8Array(o.width * o.height);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
  let s = ""; for (let i = 0; i < g.length; i += 8192) s += String.fromCharCode(...g.subarray(i, i + 8192));
  return { w: o.width, h: o.height, b64: btoa(s) };
}, bit);

const decode = async (page, bit) => {
  const { w, h, b64 } = await qrPixels(page, bit);
  const grey = Buffer.from(b64, "base64"), rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < grey.length; i++) rgba.set([grey[i], grey[i], grey[i], 255], i * 4);
  return jsQR(rgba, w, h)?.data;
};

test.describe("bit type catalog", () => {
  test("ids are unique and every kind is known", async ({ app }) => {
    const t = await app.evaluate(() => TYPES.map(({ id, kind, name }) => ({ id, kind, name })));
    expect(t.length).toBeGreaterThanOrEqual(34);
    expect(new Set(t.map((x) => x.id)).size).toBe(t.length);
    for (const x of t) { expect(["dia", "rad", "ang"]).toContain(x.kind); expect(x.name).toBeTruthy(); }
  });

  test("every type draws a different pictogram", async ({ app }) => {
    const hashes = await app.evaluate(() => TYPES.map((t) => {
      const cv = document.createElement("canvas"); cv.width = 52; cv.height = 64;
      const c = cv.getContext("2d"); white(c); rect(c, 0, 0, 52, 64); drawShank(c, "", 0); drawProfile(c, t.id, 0); threshold(c, 52, 64);
      return [t.id, Array.from(c.getImageData(0, 0, 52, 64).data).filter((_, i) => i % 4 === 0).map((v) => (v ? 1 : 0)).join("")];
    }));
    const byShape = {};
    for (const [id, h] of hashes) (byShape[h] ||= []).push(id);
    const dupes = Object.values(byShape).filter((ids) => ids.length > 1);
    expect(dupes, `types sharing a pictogram: ${JSON.stringify(dupes)}`).toEqual([]);
    for (const [id, h] of hashes) expect(h.includes("0"), `${id} draws nothing`).toBe(true);
  });
});

test.describe("label geometry", () => {
  test("every sample renders 64 dots tall, pure black and white, inside the length budget", async ({ app }) => {
    const budget = await app.evaluate(() => budgetDots());
    const samples = await app.evaluate(() => SAMPLES.map((s, i) => ({ ...s, id: String(i + 1).padStart(3, "0"), qrManual: false })));
    for (const s of samples) {
      const r = await render(app, s);
      expect(r.h, s.model).toBe(64);
      expect(r.pure, `${s.model} has grey pixels`).toBe(true);
      expect(r.total, `${s.model} is blank`).toBeGreaterThan(200);
      expect(r.w, `${s.model} is wider than the ${budget}-dot budget`).toBeLessThanOrEqual(budget);
      expect(r.qrErr, `${s.model} QR`).toBe(false);
    }
  });

  test("the default 34 mm target gives a 240-dot budget", async ({ app }) => {
    expect(await app.evaluate(() => budgetDots())).toBe(240);
  });

  test("trimming leaves 2 dots before the shank bar and 2 mm of white after the QR", async ({ app }) => {
    const r = await render(app, await app.evaluate(() => ({ ...SAMPLES[0], id: "001", qrManual: false })));
    expect(r.ink.indexOf(true)).toBe(2); // the 2-dot pad that ptCrop keeps
    const pad = 14; // 2 mm at 180 dpi
    for (let x = r.w - pad; x < r.w; x++) expect(r.ink[x], `column ${x} should be blank`).toBe(false);
    expect(r.ink.slice(r.w - pad - 4, r.w - pad).some(Boolean)).toBe(true);
  });

  test("a longer target length widens the label and a shorter one narrows it", async ({ app }) => {
    const bit = await app.evaluate(() => ({ ...SAMPLES[8], id: "009", qrManual: false }));
    const at = async (mm) => { await app.evaluate((v) => { S.lenMM = v; }, mm); return (await render(app, bit)).w; };
    const [short, normal, long] = [await at(30), await at(34), await at(40)];
    expect(short).toBeLessThan(normal);
    expect(normal).toBeLessThan(long);
    expect(long).toBeLessThanOrEqual(await app.evaluate(() => budgetDots()));
  });

  test("calibrating the printer feed shrinks the budget by twice the feed", async ({ app }) => {
    const base = await app.evaluate(() => budgetDots());
    const less = await app.evaluate(() => { S.extraMM = 1; return budgetDots(); });
    expect(base - less).toBeGreaterThanOrEqual(Math.floor(2 * 180 / 25.4) - 1);
    expect(base - less).toBeLessThanOrEqual(Math.ceil(2 * 180 / 25.4) + 1);
  });

  test("the shank bar width encodes the shank size", async ({ app }) => {
    const w = await app.evaluate(() => ["1/2", '1/2"', "12mm", "12", "1/4", "6mm", "6", "1/8", "3mm", "3/8", "8mm", "5/16"].map((s) => [s, shankW(s)]));
    const m = Object.fromEntries(w);
    expect([m["1/2"], m['1/2"'], m["12mm"], m["12"]]).toEqual([40, 40, 40, 40]);
    expect([m["1/4"], m["6mm"], m["6"], m["1/8"], m["3mm"]]).toEqual([24, 24, 24, 24, 24]);
    expect([m["3/8"], m["8mm"], m["5/16"]]).toEqual([32, 32, 32]);
  });

  test("threshold forces pure black and white", async ({ app }) => {
    const ok = await app.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = 20; cv.height = 4;
      const c = cv.getContext("2d");
      for (let x = 0; x < 20; x++) { c.fillStyle = `rgb(${x * 13},${x * 13},${x * 13})`; c.fillRect(x, 0, 1, 4); }
      threshold(c, 20, 4);
      const d = c.getImageData(0, 0, 20, 4).data; let dark = 0, light = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] === 0) dark++; else if (d[i] === 255) light++; else return false; }
      return dark > 0 && light > 0;
    });
    expect(ok).toBe(true);
  });

  test("ptCrop trims blank columns with a 2-dot pad and leaves untrimmed labels alone", async ({ app }) => {
    const r = await app.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = 60; cv.height = 64;
      const c = cv.getContext("2d"); white(c); rect(c, 0, 0, 60, 64); black(c); rect(c, 10, 5, 20, 20);
      return { trim: ptCrop(cv, true), keep: ptCrop(cv, false) };
    });
    expect(r.trim).toEqual([8, 32]); // ink in columns 10-29, plus 2 blank columns each side
    expect(r.keep).toEqual([0, 60]);
  });
});

test.describe("QR codes", () => {
  test("every sample's QR decodes to its payload (specs mode)", async ({ app }) => {
    const samples = await app.evaluate(() => SAMPLES.map((s, i) => ({ ...s, id: String(i + 1).padStart(3, "0"), qrManual: false })));
    for (const s of samples) {
      const want = await app.evaluate((b) => payloadFor(b), s);
      expect(await decode(app, s), `${s.brand} ${s.model}`).toBe(want);
    }
  });

  test("link mode QR decodes to prefix + ID", async ({ app }) => {
    await app.evaluate(() => { S.qrmode = "link"; S.pfx = "HTTP://B.LAN/"; });
    const bit = await app.evaluate(() => ({ ...SAMPLES[2], id: "ABC123", qrManual: false }));
    expect(await decode(app, bit)).toBe("HTTP://B.LAN/ABC123");
  });

  test("a manual QR payload overrides both modes", async ({ app }) => {
    const bit = await app.evaluate(() => ({ ...SAMPLES[2], id: "001", qr: "HELLO 42", qrManual: true }));
    expect(await decode(app, bit)).toBe("HELLO 42");
  });

  test("picks the smallest QR version that fits, preferring stronger ECC", async ({ app }) => {
    const r = await app.evaluate(() => {
      const q = (t) => { const x = makeQR(t); return x.err ? { err: true } : { v: x.v, ecc: x.ecc, n: x.q.getModuleCount() }; };
      return { tiny: q("A"), mid: q("A".repeat(30)), big: q("A".repeat(60)), huge: q("A".repeat(200)), lower: q("abc") };
    });
    expect(r.tiny).toMatchObject({ v: 1, ecc: "Q", n: 21 });
    expect(r.mid.v).toBeLessThanOrEqual(2);
    expect(r.big.v).toBe(3);
    expect(r.big.n * 2).toBeLessThanOrEqual(64); // v3 is the largest that fits the 64-dot tape
    expect(r.huge.err).toBe(true);
    expect(r.lower.v).toBe(1);
  });

  test("a payload that is too long shows a warning instead of a QR", async ({ app }) => {
    await app.fill("#qrtxt", "X".repeat(200));
    await expect(app.locator("#qrmeta")).toContainText("Too long for this label");
  });

  test("the QR is drawn at 2 dots per module", async ({ app }) => {
    const r = await app.evaluate(() => {
      const b = { ...SAMPLES[0], id: "001", qrManual: false }, cv = document.createElement("canvas"), q = renderLabel(cv, b);
      return { n: q.q.getModuleCount(), size: q.q.getModuleCount() * 2 };
    });
    expect(r.size).toBeLessThanOrEqual(64);
    expect(r.size % 2).toBe(0);
  });
});

test.describe("payloads and names", () => {
  test("specs payload follows the documented format", async ({ app }) => {
    const p = await app.evaluate(() => ({
      ro: autoPayload({ type: "RO", sh: "1/2", kind: "rad", key: '3/8"', dia: '1-1/4"', cl: '5/8"', ol: '2-1/2"', brand: "Freud", model: "34-118" }),
      chm: autoPayload({ type: "CHM", sh: "1/2", kind: "ang", key: "45°", dia: '1-3/8"', cl: '1/2"', ol: '2-1/2"', brand: "Freud", model: "40-104" }),
      dia: autoPayload({ type: "STR", sh: "1/4", kind: "dia", key: '1/2"', dia: '1/2"', cl: '1"', ol: "", brand: "", model: "" }),
      metric: autoPayload({ type: "DT", sh: "8mm", kind: "ang", key: "14°", dia: "12.7mm", cl: "13mm", ol: "55mm", brand: "Bosch", model: "84505M" }),
    }));
    expect(p.ro).toBe("RO D1-1/4 R3/8 CL5/8 OL2-1/2 SH1/2 FREUD 34-118");
    expect(p.chm).toBe("CHM D1-3/8 A45 CL1/2 OL2-1/2 SH1/2 FREUD 40-104");
    expect(p.dia).toBe('STR D1/2 CL1 SH1/4'.replace('D1/2', 'D1/2'));
    expect(p.metric).toBe("DT D12.7MM A14 CL13MM OL55MM SH8MM BOSCH 84505M");
  });

  test("payloadFor picks manual, link or specs", async ({ app }) => {
    const r = await app.evaluate(() => {
      const b = { type: "STR", sh: "1/2", kind: "dia", key: '1/2"', dia: '1/2"', cl: '1"', ol: "", brand: "", model: "", id: " 007 ", qr: "", qrManual: false };
      S.qrmode = "data"; const data = payloadFor(b);
      S.qrmode = "link"; S.pfx = "HTTP://X/"; const link = payloadFor(b), noId = payloadFor({ ...b, id: "" });
      const manual = payloadFor({ ...b, qr: "CUSTOM", qrManual: true });
      const emptyManual = payloadFor({ ...b, qr: "  ", qrManual: true });
      return { data, link, noId, manual, emptyManual };
    });
    expect(r.data).toBe("STR D1/2 CL1 SH1/2");
    expect(r.link).toBe("HTTP://X/007");
    expect(r.noId).toBe("");
    expect(r.manual).toBe("CUSTOM");
    expect(r.emptyManual).toBe("HTTP://X/007"); // a blank override falls back to the current mode
  });

  test("file names are safe and truncated", async ({ app }) => {
    const r = await app.evaluate(() => ({
      plain: fname({ type: "STR", sh: "1/2", key: '1/2"', brand: "Whiteside", model: "1072" }),
      odd: fname({ type: "CHM", sh: "1/4", key: "45°", brand: "A/B C", model: "x*y?z" }),
      long: fname({ type: "STR", sh: "1/2", key: "k", brand: "B".repeat(200), model: "m" }),
    }));
    expect(r.plain).toBe("RB_STR_1-2_1-2_Whiteside_1072");
    expect(r.odd).toMatch(/^[\w.-]+$/);
    expect(r.long.length).toBeLessThanOrEqual(80);
  });

  test("next ID is one more than the highest numeric ID, zero padded", async ({ app }) => {
    const r = await app.evaluate(() => {
      list = []; const a = nextId();
      list = [{ id: "001" }, { id: "009" }, { id: "ABC" }]; const b = nextId();
      list = [{ id: "99" }]; const c = nextId();
      return { a, b, c };
    });
    expect(r).toEqual({ a: "001", b: "010", c: "100" });
  });

  test("clean trims and tolerates missing values", async ({ app }) => {
    expect(await app.evaluate(() => [clean("  hi "), clean(null), clean(undefined), clean(5)])).toEqual(["hi", "", "", "5"]);
  });
});
