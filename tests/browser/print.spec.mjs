import { test as base, expect, load, MOCK_LINK, MOCK_SERIAL, MOCK_USB, PARSE_JOB } from "./helpers.mjs";

// Same as the shared fixture, plus the in-page printer mocks.
const test = base.extend({
  app: async ({ page, errors }, use) => { // eslint-disable-line no-unused-vars
    await load(page);
    await page.addScriptTag({ content: MOCK_LINK + MOCK_SERIAL + MOCK_USB + PARSE_JOB });
    await use(page);
  },
});

const state = (p) => p.locator("#ptState");
const jobs = (p) => p.evaluate(() => writes.filter((w) => w.length > 200 && w[w.length - 1] === 0x1A).map((w) => parseJob(w)).map(({ rows, ...r }) => r));

test.describe("status packets", () => {
  test("ptParse reads a valid 32-byte status", async ({ app }) => {
    const s = await app.evaluate(() => ptParse(mkStatus({ err1: 4, err2: 0x10, width: 12, stype: 6, phase: 1 })));
    expect(s).toEqual({ model: 0x76, err1: 4, err2: 0x10, width: 12, type: 1, stype: 6, phase: 1 });
  });

  test("ptParse rejects short, wrong-header and empty input", async ({ app }) => {
    const r = await app.evaluate(() => [ptParse(null), ptParse(new Uint8Array(0)), ptParse(new Uint8Array(31).fill(0x80)), ptParse(new Uint8Array(32))]);
    expect(r).toEqual([null, null, null, null]);
  });

  test("ptErrText names each error bit", async ({ app }) => {
    const r = await app.evaluate(() => ({
      none: ptErrText({ err1: 0, err2: 0 }),
      noTape: ptErrText({ err1: 0x01, err2: 0 }), jam: ptErrText({ err1: 0x04, err2: 0 }), battery: ptErrText({ err1: 0x08, err2: 0 }),
      tape: ptErrText({ err1: 0, err2: 0x01 }), cover: ptErrText({ err1: 0, err2: 0x10 }), hot: ptErrText({ err1: 0, err2: 0x20 }),
      several: ptErrText({ err1: 0x05, err2: 0x10 }), unknown: ptErrText({ err1: 0x02, err2: 0 }),
    }));
    expect(r).toEqual({
      none: "", noTape: "no tape", jam: "cutter jam", battery: "weak battery", tape: "wrong/replace tape", cover: "cover open", hot: "overheating",
      several: "no tape, cutter jam, cover open", unknown: "error 2/0",
    });
  });
});

test.describe("PtLink buffered reader", () => {
  test("collects 32 bytes delivered in pieces and keeps the rest", async ({ app }) => {
    const r = await app.evaluate(async () => {
      const l = new PtLink(); const p = l.read32(1000);
      l._push(Uint8Array.from({ length: 10 }, (_, i) => i)); l._push(Uint8Array.from({ length: 30 }, (_, i) => 10 + i));
      const got = await p;
      return { first: Array.from(got), left: l.buf.length };
    });
    expect(r.first).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(r.left).toBe(8);
  });

  test("times out with null, and returns null once closed", async ({ app }) => {
    const r = await app.evaluate(async () => {
      const l = new PtLink(); const t0 = Date.now(); const timedOut = await l.read32(120); const waited = Date.now() - t0;
      const c = new PtLink(); c.closed = true;
      return { timedOut, waited, closed: await c.read32(1000) };
    });
    expect(r.timedOut).toBeNull();
    expect(r.waited).toBeGreaterThanOrEqual(100);
    expect(r.closed).toBeNull();
  });

  test("drain drops buffered bytes", async ({ app }) => {
    expect(await app.evaluate(() => { const l = new PtLink(); l._push(new Uint8Array(40)); l.drain(); return l.buf.length; })).toBe(0);
  });
});

test.describe("job encoding", () => {
  const job = (app, opts, bit = 0) => app.evaluate(({ opts, bit }) => {
    const cv = document.createElement("canvas"); renderLabel(cv, { ...SAMPLES[bit], id: "001", qrManual: false });
    const bytes = ptJob(cv, opts); const p = parseJob(Array.from(bytes));
    return { canvasW: cv.width, ...p, rows: undefined, total: bytes.length };
  }, { opts, bit });

  test("follows Brother's command sequence", async ({ app }) => {
    const j = await job(app, { chain: false, orient: "normal", trim: false, margin: 0 });
    expect(j).toMatchObject({ invalidate: true, rasterMode: true, init: true, notify: true, printInfo: true, autoCut: true, cutEvery: true, tiff: true, end: 0x1A });
    expect(j.pageByte).toBe(0);  // 02 makes the P710BT ignore the job
    expect(j.pad).toBe(0);
    expect(j.lines).toBe(j.canvasW);
    expect(j.total).toBe(143 + 20 * j.canvasW);
    expect(j.consumed).toBe(j.total);
  });

  test("chain mode turns the end-of-job feed off, otherwise it is on", async ({ app }) => {
    expect((await job(app, { chain: true, orient: "normal", trim: false, margin: 0 })).advanced).toBe(0x00);
    expect((await job(app, { chain: false, orient: "normal", trim: false, margin: 0 })).advanced).toBe(0x08);
  });

  test("margin is encoded as a little-endian 16-bit dot count", async ({ app }) => {
    for (const m of [0, 7, 14, 300]) expect((await job(app, { chain: false, orient: "normal", trim: false, margin: m })).margin).toBe(m);
  });

  test("trimming sends only the cropped columns", async ({ app }) => {
    const r = await app.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = 60; cv.height = 64;
      const c = cv.getContext("2d"); white(c); rect(c, 0, 0, 60, 64); black(c); rect(c, 10, 5, 20, 20);
      return { trimmed: parseJob(Array.from(ptJob(cv, { chain: false, orient: "normal", trim: true, margin: 0 }))).lines,
        full: parseJob(Array.from(ptJob(cv, { chain: false, orient: "normal", trim: false, margin: 0 }))).lines };
    });
    expect(r).toEqual({ trimmed: 24, full: 60 });
  });

  test("every raster line is a PackBits literal run and only pins 32-95 carry ink", async ({ app }) => {
    const r = await app.evaluate(() => {
      const cv = document.createElement("canvas"); renderLabel(cv, { ...SAMPLES[4], id: "005", qrManual: false });
      const p = parseJob(Array.from(ptJob(cv, { chain: false, orient: "normal", trim: false, margin: 0 })));
      let outside = 0;
      for (const row of p.rows) for (let pin = 0; pin < 128; pin++) if ((row.data[pin >> 3] & (0x80 >> (pin & 7))) && (pin < 32 || pin > 95)) outside++;
      return { allLiteral: p.rows.every((x) => x.ok), outside, lines: p.rows.length };
    });
    expect(r.allLiteral).toBe(true);
    expect(r.outside).toBe(0);
    expect(r.lines).toBeGreaterThan(100);
  });

  for (const [orient, rev, flip] of [["normal", false, false], ["mirror", true, false], ["flip", false, true], ["rot180", true, true]]) {
    test(`the raster reproduces the label exactly (${orient})`, async ({ app }) => {
      const diff = await app.evaluate(({ orient, rev, flip }) => {
        const cv = document.createElement("canvas"); renderLabel(cv, { ...SAMPLES[8], id: "009", qrManual: false });
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        const p = parseJob(Array.from(ptJob(cv, { chain: false, orient, trim: false, margin: 0 })));
        let bad = 0;
        for (let k = 0; k < p.lines; k++) {
          const x = rev ? p.lines - 1 - k : k;
          for (let y = 0; y < 64; y++) {
            const pin = 32 + (flip ? 63 - y : y), set = (p.rows[k].data[pin >> 3] & (0x80 >> (pin & 7))) !== 0;
            if (set !== (d[(y * cv.width + x) * 4] < 128)) bad++;
          }
        }
        return bad;
      }, { orient, rev, flip });
      expect(diff).toBe(0);
    });
  }
});

test.describe("status request", () => {
  test("sends invalidate, init and status request together and parses the reply", async ({ app }) => {
    const r = await app.evaluate(async () => {
      ptLink = new MockLink("USB"); const s = await ptStatus(); const w = writes[0];
      return { s, len: w.length, zeros: w.slice(0, 100).every((v) => v === 0), tail: w.slice(100) };
    });
    expect(r.s.model).toBe(0x76);
    expect(r.len).toBe(105);
    expect(r.zeros).toBe(true);
    expect(r.tail).toEqual([0x1B, 0x40, 0x1B, 0x69, 0x53]);
  });

  test("reports a printer that stays silent, with a reason", async ({ app }) => {
    const r = await app.evaluate(async () => { ptLink = new MockLink("USB", { silent: true }); const s = await ptStatus(); return { s, diag: ptLink.diag }; });
    expect(r.s).toBeNull();
    expect(r.diag).toBe("no reply to status request; 0 bytes received in total");
  });

  test("reports a link that never accepts the write", async ({ app }) => {
    const r = await app.evaluate(async () => { ptLink = new MockLink("USB", { hangWrites: true }); const s = await ptStatus(); return { s, diag: ptLink.diag }; });
    expect(r.s).toBeNull();
    expect(r.diag).toBe("write timeout");
  });

  test("Bluetooth retries and succeeds when the printer answers late", async ({ app }) => {
    test.setTimeout(60_000);
    const r = await app.evaluate(async () => {
      ptLink = new MockLink("Bluetooth", { skip: 2 }); const s = await ptStatus();
      return { s, requests: writes.filter(isStatusReq).length };
    });
    expect(r.s).not.toBeNull();
    expect(r.requests).toBe(3);
  });

  test("progress text only shows while connecting", async ({ app }) => {
    const r = await app.evaluate(async () => {
      document.getElementById("ptState").textContent = "untouched";
      ptLink = new MockLink("USB"); await ptStatus(false);
      return document.getElementById("ptState").textContent;
    });
    expect(r).toBe("untouched");
  });
});

test.describe("connecting over Bluetooth (Web Serial)", () => {
  test("connects, asserts DTR/RTS and reports the printer", async ({ app }) => {
    await app.evaluate(() => useMockSerial());
    await app.click("#ptBt");
    await expect(state(app)).toContainText("Connected over Bluetooth · model code 0x76 · 12 mm tape");
    const log = await app.evaluate(() => serialLog);
    expect(log.openOpts).toEqual({ baudRate: 9600, bufferSize: 4096 });
    expect(log.signals).toEqual({ dataTerminalReady: true, requestToSend: true });
    expect(log.filters.allowedBluetoothServiceClassIds).toEqual(["00001101-0000-1000-8000-00805f9b34fb"]);
    await expect(app.locator("#ptPrintCur")).toBeEnabled();
    await expect(app.locator("#ptDisc")).toBeVisible();
  });

  test("disconnect closes the port and resets the UI", async ({ app }) => {
    await app.evaluate(() => useMockSerial());
    await app.click("#ptBt");
    await expect(state(app)).toContainText("Connected over Bluetooth");
    await app.click("#ptDisc");
    await expect(state(app)).toHaveText("Not connected.");
    expect((await app.evaluate(() => serialLog)).closes).toBe(1);
    await expect(app.locator("#ptPrintCur")).toBeDisabled();
    await expect(app.locator("#ptDisc")).toBeHidden();
  });

  test("dismissing the chooser is silent", async ({ app }) => {
    await app.evaluate(() => useMockSerial({ cancel: true }));
    await app.click("#ptBt");
    await expect.poll(() => app.evaluate(() => serialLog.requested)).toBe(1);
    await expect(state(app)).toHaveText("Not connected.");
  });

  test("retries a slow open before giving up on it", async ({ app }) => {
    test.setTimeout(60_000);
    await app.evaluate(() => useMockSerial({ failOpens: 2 }));
    await app.click("#ptBt");
    await expect(state(app)).toContainText("Connected over Bluetooth", { timeout: 20_000 });
    expect((await app.evaluate(() => serialLog.opens))).toBe(3);
  });

  test("shows the error when the port never opens", async ({ app }) => {
    test.setTimeout(60_000);
    await app.evaluate(() => useMockSerial({ failOpens: 99 }));
    await app.click("#ptBt");
    await expect(state(app)).toContainText("Couldn't connect: Failed to open serial port.", { timeout: 30_000 });
    expect((await app.evaluate(() => serialLog.opens))).toBe(4);
    await expect(app.locator("#ptPrintCur")).toBeDisabled();
  });

  test("a silent printer gets a clear message with the reason, and the port is released", async ({ app }) => {
    test.setTimeout(90_000);
    await app.evaluate(() => useMockSerial({ silent: true }));
    await app.click("#ptBt");
    await expect(state(app)).toContainText("the printer didn't answer (no reply to status request; 0 bytes received in total)", { timeout: 45_000 });
    expect((await app.evaluate(() => serialLog.closes))).toBe(1);
    await expect(app.locator("#ptPrintCur")).toBeDisabled();
    await expect(app.locator("#ptBt")).toBeEnabled(); // a failed attempt must not block the next one
  });

  test("warns about the wrong tape width and printer errors", async ({ app }) => {
    await app.evaluate(() => useMockSerial({ status: { width: 9, err2: 0x10 } }));
    await app.click("#ptBt");
    await expect(state(app)).toContainText("9 mm tape");
    await expect(state(app)).toContainText("cover open");
    await expect(state(app)).toContainText("labels are designed for 12 mm tape");
  });
});

test.describe("connecting over USB (WebUSB)", () => {
  test("claims the printer interface and reports the printer", async ({ app }) => {
    await app.evaluate(() => useMockUsb());
    await app.click("#ptUsb");
    await expect(state(app)).toContainText("Connected over USB · model code 0x76 · 12 mm tape");
    const log = await app.evaluate(() => usbLog);
    expect(log.claimed).toBe(3);
    expect(log.filters).toEqual({ filters: [{ vendorId: 0x04F9, classCode: 7 }, { vendorId: 0x04F9 }] });
    expect(log.out[0]).toEqual([2, 105]);   // the status request goes out on the OUT endpoint
  });

  test("disconnect releases the interface and closes the device", async ({ app }) => {
    await app.evaluate(() => useMockUsb());
    await app.click("#ptUsb");
    await expect(state(app)).toContainText("Connected over USB");
    await app.click("#ptDisc");
    await expect(state(app)).toHaveText("Not connected.");
    const log = await app.evaluate(() => usbLog);
    expect(log.released).toBe(3);
    expect(log.closed).toBe(1);
  });

  test("a device without a printer interface is rejected", async ({ app }) => {
    await app.evaluate(() => useMockUsb({ noInterface: true }));
    await app.click("#ptUsb");
    await expect(state(app)).toContainText("Couldn't connect: No printer interface on this USB device");
  });

  test("a silent printer is reported and released", async ({ app }) => {
    await app.evaluate(() => useMockUsb({ silent: true }));
    await app.click("#ptUsb");
    await expect(state(app)).toContainText("the printer didn't answer", { timeout: 15_000 });
    expect((await app.evaluate(() => usbLog.closed))).toBe(1);
  });
});

test.describe("printing", () => {
  const setLink = (app, kind = "USB", opts = {}) => app.evaluate(({ kind, opts }) => { ptLink = new MockLink(kind, opts); ptUi(); }, { kind, opts });
  const loadSamples = (app) => app.evaluate(() => { document.getElementById("loadSamples").click(); });

  test("print buttons follow the connection and the list", async ({ app }) => {
    await expect(app.locator("#ptPrintCur")).toBeDisabled();
    await expect(app.locator("#ptPrintList")).toBeDisabled();
    await setLink(app);
    await expect(app.locator("#ptPrintCur")).toBeEnabled();
    await expect(app.locator("#ptPrintList")).toBeDisabled();          // nothing in the list yet
    await loadSamples(app);
    await expect(app.locator("#ptPrintList")).toBeEnabled();
    await expect(app.locator("#ptPrintList")).toHaveText("Print whole list (16)");
    await expect(app.locator("#ptUsb")).toBeDisabled();                // can't open a second connection
  });

  test("prints the current label and reports completion", async ({ app }) => {
    await setLink(app);
    await app.click("#ptPrintCur");
    await expect(app.locator("#ptLog")).toContainText("done", { timeout: 15_000 });
    await expect(app.locator("#toast")).toHaveText("Label printed");
    const j = await jobs(app);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ advanced: 0x08, margin: 0, pageByte: 0 });  // single label: feed at the end
    expect((await app.evaluate(() => writes.at(-1)))).toEqual([0x1B, 0x69, 0x61, 0xFF]);  // back to dynamic mode afterwards
  });

  test("chains a batch, feeding only after the last label", async ({ app }) => {
    test.setTimeout(60_000);
    await setLink(app); await loadSamples(app);
    await app.evaluate(() => { list = list.slice(0, 3); persist(); renderList(); });
    await app.click("#ptPrintList");
    await expect(app.locator("#toast")).toHaveText("All labels printed", { timeout: 30_000 });
    const j = await jobs(app);
    expect(j.map((x) => x.advanced)).toEqual([0x00, 0x00, 0x08]);
    await expect(app.locator("#ptLog")).toContainText("3/3");
  });

  test("with chaining off every label feeds", async ({ app }) => {
    test.setTimeout(60_000);
    await setLink(app); await loadSamples(app);
    await app.evaluate(() => { list = list.slice(0, 2); persist(); renderList(); });
    await app.uncheck("#ptChain");
    await app.click("#ptPrintList");
    await expect(app.locator("#toast")).toHaveText("All labels printed", { timeout: 30_000 });
    expect((await jobs(app)).map((x) => x.advanced)).toEqual([0x08, 0x08]);
  });

  test("sends the label that is on screen", async ({ app }) => {
    await setLink(app);
    const w = await app.evaluate(() => { const cv = document.createElement("canvas"); readForm(); renderLabel(cv, cur); return cv.width; });
    await app.click("#ptPrintCur");
    await expect(app.locator("#ptLog")).toContainText("done", { timeout: 15_000 });
    expect((await jobs(app))[0].lines).toBe(w);
  });

  test("stop finishes the current label and skips the rest", async ({ app }) => {
    test.setTimeout(60_000);
    await setLink(app); await loadSamples(app);
    await app.evaluate(() => { list = list.slice(0, 3); persist(); renderList(); });
    await app.click("#ptPrintList");
    await expect(app.locator("#ptStop")).toBeVisible();
    await app.click("#ptStop");
    await expect(app.locator("#ptLog")).toContainText("Stopped.", { timeout: 30_000 });
    expect(await jobs(app)).toHaveLength(1);
    await expect(app.locator("#ptStop")).toBeHidden();
    await expect(app.locator("#ptPrintCur")).toBeEnabled();
  });

  for (const [name, status, text] of [
    ["cover open", { err2: 0x10 }, "cover open"],
    ["no tape", { err1: 0x01 }, "no tape"],
    ["cutter jam", { err1: 0x04 }, "cutter jam"],
    ["wrong tape width", { width: 9 }, "9 mm tape loaded — these labels need 12 mm"],
  ]) {
    test(`refuses to print: ${name}`, async ({ app }) => {
      await setLink(app, "USB", { status });
      await app.click("#ptPrintCur");
      await expect(state(app)).toContainText(`Print failed: ${text}`, { timeout: 10_000 });
      expect(await jobs(app)).toHaveLength(0);
      await expect(app.locator("#ptPrintCur")).toBeEnabled();   // ready to retry
    });
  }

  test("a printer error during the job is surfaced", async ({ app }) => {
    await setLink(app, "USB", { jobError: { err1: 0x04 } });
    await app.click("#ptPrintCur");
    await expect(state(app)).toContainText("Print failed: cutter jam", { timeout: 15_000 });
    await expect(app.locator("#ptLog")).toContainText("✕ cutter jam");
  });

  test("a printer that does not answer the pre-print status is reported", async ({ app }) => {
    await setLink(app, "USB", { silent: true });
    await app.click("#ptPrintCur");
    await expect(state(app)).toContainText("Print failed: printer didn't answer the status request", { timeout: 15_000 });
  });

  test("clicking print twice does not start a second job", async ({ app }) => {
    await setLink(app);
    await app.evaluate(() => { const b = document.getElementById("ptPrintCur"); b.click(); b.click(); });
    await expect(app.locator("#ptLog")).toContainText("done", { timeout: 15_000 });
    expect(await jobs(app)).toHaveLength(1);
  });
});
