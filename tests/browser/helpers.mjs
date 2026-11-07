import { test as base, expect } from "@playwright/test";

export { expect };

// Opens the app and waits until init() has drawn everything. `storage` seeds localStorage once, before the
// page's scripts run (keys that already exist are kept, so a reload does not overwrite what the app saved).
export async function load(page, storage = {}) {
  await page.addInitScript((seed) => {
    try { for (const [k, v] of Object.entries(seed)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {}
  }, storage);
  await page.goto("/");
  await page.waitForFunction(() => document.getElementById("ptLen")?.textContent && document.getElementById("qrmeta")?.textContent);
}

// Every test fails if the page throws or logs a console error.
export const test = base.extend({
  errors: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    await use(errors);
    expect(errors).toEqual([]);
  },
  app: async ({ page, errors }, use) => { // eslint-disable-line no-unused-vars
    await load(page);
    await use(page);
  },
});

// A 32-byte status packet the way the PT-P710BT sends it.
export const STATUS = `(o = {}) => {
  const b = new Uint8Array(32);
  b[0] = 0x80; b[1] = 0x20; b[2] = 0x42; b[3] = 0x30; b[4] = 0x76; b[8] = o.err1 || 0; b[9] = o.err2 || 0;
  b[10] = o.width === undefined ? 12 : o.width; b[11] = 1; b[18] = o.stype || 0; b[19] = o.phase || 0;
  return b;
}`;

// ---- in-page printer mocks (injected with page.addScriptTag) ----

// A PtLink that answers like a PT-P710BT. opts: silent, skip (ignore the first N status requests), hangWrites,
// status ({err1, err2, width}), reply (false = never report job progress), jobError ({err1, err2}).
export const MOCK_LINK = `
window.mkStatus = ${STATUS};
window.writes = [];
window.isStatusReq = (u8) => u8.length >= 3 && u8[u8.length - 3] === 0x1B && u8[u8.length - 2] === 0x69 && u8[u8.length - 1] === 0x53;
window.MockLink = class extends PtLink {
  constructor(kind = "USB", opts = {}) { super(); this.kind = kind; this.opts = opts; this.rx = 0; this.name = "mock"; }
  async write(u8) {
    window.writes.push(Array.from(u8));
    if (this.opts.hangWrites) return new Promise(() => {});
    if (isStatusReq(u8) && !this.opts.silent) {
      if (this.opts.skip > 0) { this.opts.skip--; return; }
      this._push(mkStatus(this.opts.status));
    }
    if (u8.length > 200 && u8[u8.length - 1] === 0x1A && this.opts.reply !== false) {
      if (this.opts.jobError) { this._push(mkStatus({ stype: 2, ...this.opts.jobError })); return; }
      this._push(mkStatus({ stype: 6, phase: 1 })); this._push(mkStatus({ stype: 1 })); this._push(mkStatus({ stype: 6, phase: 0 }));
    }
  }
  async close() { this.closed = true; window.closedLinks = (window.closedLinks || 0) + 1; }
};`;

// navigator.serial with a port built on real streams. opts: failOpens (reject the first N open() calls),
// silent, cancel (requestPort rejects like a dismissed chooser), status.
export const MOCK_SERIAL = `
window.serialLog = { opens: 0, closes: 0, signals: null, requested: 0 };
window.useMockSerial = (opts = {}) => {
  let failOpens = opts.failOpens || 0;
  Object.defineProperty(navigator, "serial", { configurable: true, value: {
    requestPort: async (o) => {
      serialLog.requested++; serialLog.filters = o;
      if (opts.cancel) throw new DOMException("No port selected by the user.", "NotFoundError");
      let ctrl;
      const readable = new ReadableStream({ start(c) { ctrl = c; }, cancel() {} });
      const writable = new WritableStream({ write(chunk) { if (isStatusReq(chunk) && !opts.silent) ctrl.enqueue(mkStatus(opts.status)); } });
      return {
        readable, writable,
        open: async (o2) => { serialLog.opens++; serialLog.openOpts = o2; if (failOpens > 0) { failOpens--; throw new Error("Failed to open serial port."); } },
        setSignals: async (s) => { serialLog.signals = s; },
        close: async () => { serialLog.closes++; },
      };
    },
  } });
};`;

// navigator.usb with one Brother-style printer. opts: noInterface, silent, status.
export const MOCK_USB = `
window.usbLog = { claimed: null, released: null, opened: 0, closed: 0, out: [] };
window.useMockUsb = (opts = {}) => {
  const queue = [], waiters = [];
  const push = (u8) => { const w = waiters.shift(); if (w) w(u8); else queue.push(u8); };
  const iface = { interfaceNumber: 3, alternates: [{ interfaceClass: opts.noInterface ? 8 : 7, endpoints: [
    { direction: "in", endpointNumber: 1 }, { direction: "out", endpointNumber: 2 }] }] };
  const dev = {
    productName: "PT-P710BT", configuration: { interfaces: [iface] },
    open: async () => { usbLog.opened++; }, selectConfiguration: async () => {},
    claimInterface: async (n) => { usbLog.claimed = n; }, releaseInterface: async (n) => { usbLog.released = n; },
    close: async () => { usbLog.closed++; },
    transferOut: async (ep, data) => { const u8 = new Uint8Array(data); usbLog.out.push([ep, u8.length]); if (isStatusReq(u8) && !opts.silent) push(mkStatus(opts.status)); },
    transferIn: (ep, len) => new Promise((res) => { const give = (u8) => res({ data: new DataView(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)) }); queue.length ? give(queue.shift()) : waiters.push(give); }),
  };
  Object.defineProperty(navigator, "usb", { configurable: true, value: {
    requestDevice: async (f) => { usbLog.filters = f; return dev; },
    addEventListener() {}, removeEventListener() {},
  } });
};`;

// Unpacks a job built by ptJob into its pieces so tests can check each part.
export const PARSE_JOB = `
window.parseJob = (bytes) => {
  const u = Uint8Array.from(bytes), at = (i, ...seq) => seq.every((v, k) => u[i + k] === v);
  const r = { len: u.length, invalidate: u.subarray(0, 100).every((v) => v === 0) };
  let i = 100;
  r.rasterMode = at(i, 0x1B, 0x69, 0x61, 0x01); i += 4;
  r.init = at(i, 0x1B, 0x40); i += 2;
  r.notify = at(i, 0x1B, 0x69, 0x21, 0x00); i += 4;
  r.printInfo = at(i, 0x1B, 0x69, 0x7A, 0x84, 0x01, 0x0C, 0x00); r.lines = u[i + 7] | u[i + 8] << 8 | u[i + 9] << 16 | u[i + 10] << 24; r.pageByte = u[i + 11]; r.pad = u[i + 12]; i += 13;
  r.advanced = at(i, 0x1B, 0x69, 0x4B) ? u[i + 3] : null; i += 4;
  r.autoCut = at(i, 0x1B, 0x69, 0x4D, 0x40); i += 4;
  r.cutEvery = at(i, 0x1B, 0x69, 0x41, 0x01); i += 4;
  r.margin = at(i, 0x1B, 0x69, 0x64) ? u[i + 3] | u[i + 4] << 8 : null; i += 5;
  r.tiff = at(i, 0x4D, 0x02); i += 2;
  r.rows = [];
  for (let k = 0; k < r.lines; k++) { r.rows.push({ ok: at(i, 0x47, 17, 0x00, 15), data: u.slice(i + 4, i + 20) }); i += 20; }
  r.end = u[i]; r.consumed = i + 1;
  return r;
};`;
