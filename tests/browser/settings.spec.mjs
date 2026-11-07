import { test, expect, load } from "./helpers.mjs";

const S = (p) => p.evaluate(() => ({ ...S }));
const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("rbl-settings")));
const toast = (p) => p.locator("#toast");
// The orientation fix and the calibration form live in collapsed <details> sections.
const expand = (p) => p.locator("details").evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));

test.describe("defaults and saved settings", () => {
  test("a fresh browser gets the fixed layout settings", async ({ app }) => {
    expect(await S(app)).toMatchObject({ marginDots: 0, padR: 14, trim: true, extraMM: 0, lenMM: 34, qrmode: "data", showId: true, orient: "normal" });
  });

  test("settings saved by an older version are migrated once", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await load(page, { "rbl-settings": JSON.stringify({ extraMM: 1.3, marginDots: 7, padR: 7, trim: false, lenMM: 40 }) });
    expect(await S(page)).toMatchObject({ extraMM: 0, marginDots: 0, padR: 14, trim: true, cal: 1, lenMM: 40 }); // the old 1.3 mm feed is dropped, the length kept
    expect(await saved(page)).toMatchObject({ extraMM: 0, cal: 1 });
  });

  test("a calibration made after the migration is kept", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await load(page, { "rbl-settings": JSON.stringify({ extraMM: 0.4, cal: 1 }) });
    expect((await S(page)).extraMM).toBe(0.4);
  });

  test("margin, padding and trimming cannot be overridden by stored values", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await load(page, { "rbl-settings": JSON.stringify({ cal: 1, marginDots: 14, padR: 0, trim: false }) });
    expect(await S(page)).toMatchObject({ marginDots: 0, padR: 14, trim: true });
  });

  test("corrupt stored data falls back to defaults", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await load(page, { "rbl-settings": "{not json", "rbl-list": "also not json" });
    expect(await S(page)).toMatchObject({ lenMM: 34, padR: 14 });
    expect(await page.evaluate(() => list)).toEqual([]);
    await page.click("#addList");
    await expect(page.locator("#list tr:has(img)")).toHaveCount(1);
  });

  test("works when storage is blocked", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } }); });
    await page.goto("/");
    await page.waitForFunction(() => document.getElementById("ptLen")?.textContent);
    await page.click("#addList");
    await expect(page.locator("#list tr:has(img)")).toHaveCount(1);
  });

  test("the orientation fix is remembered", async ({ app }) => {
    await expand(app);
    await app.selectOption("#ptOrient", "mirror");
    expect((await saved(app)).orient).toBe("mirror");
    await app.reload();
    await expand(app);
    await expect(app.locator("#ptOrient")).toHaveValue("mirror");
  });
});

test.describe("label length", () => {
  test("a new target length is applied and saved", async ({ app }) => {
    const before = await app.evaluate(() => budgetDots());
    await app.fill("#ptLenMM", "40"); await app.locator("#ptLenMM").blur();
    expect((await S(app)).lenMM).toBe(40);
    expect(await app.evaluate(() => budgetDots())).toBeGreaterThan(before);
    expect((await saved(app)).lenMM).toBe(40);
    await expect(app.locator("#ptLen")).toContainText("mm of print");
  });

  test("out-of-range lengths snap back", async ({ app }) => {
    for (const bad of ["10", "99", ""]) {
      await app.fill("#ptLenMM", bad); await app.locator("#ptLenMM").blur();
      await expect(app.locator("#ptLenMM")).toHaveValue("34");
    }
    expect((await S(app)).lenMM).toBe(34);
  });

  test("the readout shows print length, printer feed and the total", async ({ app }) => {
    await expect(app.locator("#ptLen")).toContainText(/Current label: [\d.]+ mm of print \+ ~0\.0 mm printer feed at each end ≈ [\d.]+ mm/);
  });

  test("warns when the design cannot be squeezed into the target", async ({ app }) => {
    await app.evaluate(() => { S.lenMM = 25; S.extraMM = 4; ptFitChanged(); });
    await expect(app.locator("#ptLen")).toContainText("can't squeeze below this");
  });
});

test.describe("calibration", () => {
  test.beforeEach(async ({ app }) => { await expand(app); });
  const measure = async (app, mm) => { await app.fill("#ptMeasured", String(mm)); await app.click("#ptCal"); };
  const imgMM = (app) => app.evaluate(() => { const cv = document.createElement("canvas"); renderLabel(cv, cur); return cv.width * 25.4 / 180; });

  test("derives the per-end feed from a measured label", async ({ app }) => {
    const img = await imgMM(app);
    await measure(app, (img + 2).toFixed(2));
    const extra = (await S(app)).extraMM;
    expect(extra).toBeCloseTo(Math.round((((img + 2) - img) / 2) * 10) / 10, 1);
    await expect(app.locator("#ptCalNote")).toContainText("Calibrated from the current label");
    await expect(app.locator("#ptExtraShow")).toHaveText(extra.toFixed(1));
    expect((await saved(app)).extraMM).toBe(extra);
  });

  test("a calibration shortens the design so the printed label still hits the target", async ({ app }) => {
    const before = await app.evaluate(() => budgetDots());
    await measure(app, ((await imgMM(app)) + 3).toFixed(2));    // the printer adds 1.5 mm per end
    expect(await app.evaluate(() => budgetDots())).toBeLessThan(before);
  });

  test("a measurement slightly shorter than the design gives a small negative feed", async ({ app }) => {
    await measure(app, ((await imgMM(app)) - 0.4).toFixed(2));
    const extra = (await S(app)).extraMM;
    expect(extra).toBeLessThan(0);
    expect(extra).toBeGreaterThanOrEqual(-2);
  });

  test("uses the last printed label when there is one", async ({ app }) => {
    await app.evaluate(() => { ptLast = { imgMM: 30, marginDots: 0 }; });
    await measure(app, 31);
    expect((await S(app)).extraMM).toBe(0.5);
    await expect(app.locator("#ptCalNote")).toContainText("your last print");
  });

  test("rejects an empty or implausible measurement and keeps the old value", async ({ app }) => {
    await app.evaluate(() => { S.extraMM = 0.7; });
    await measure(app, 5);
    await expect(toast(app)).toHaveText("Enter the measured length in mm");
    await measure(app, 100);
    await expect(toast(app)).toHaveText("That measurement doesn't fit — check it");
    expect((await S(app)).extraMM).toBe(0.7);
  });

  test("reset puts the feed back to zero", async ({ app }) => {
    await app.evaluate(() => { S.extraMM = 1.2; ptFitChanged(); });
    await app.click("#ptCalReset");
    expect((await S(app)).extraMM).toBe(0);
    await expect(app.locator("#ptExtraShow")).toHaveText("0.0");
  });
});
