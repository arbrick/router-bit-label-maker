import { test, expect, load } from "./helpers.mjs";

const rows = (p) => p.locator("#list tr:has(img)");
const toast = (p) => p.locator("#toast");
const storedList = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("rbl-list") || "[]"));

test.describe("page", () => {
  test("loads with the heading, the type picker, the form and a preview", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await load(page);
    await expect(page).toHaveTitle(/Router Bit Label System/);
    await expect(page.locator("h1")).toHaveText("Router bit label system");
    expect(await page.locator(".pick").count()).toBe(await page.evaluate(() => TYPES.length));
    await expect(page.locator('.pick[data-id="STR"]')).toHaveClass(/on/);
    expect(await page.evaluate(() => document.getElementById("big").width)).toBeGreaterThan(100);
    expect(await page.evaluate(() => document.getElementById("big").height)).toBe(64);
    await expect(page.locator("#truesize")).toHaveAttribute("src", /^data:image\/png/);
    expect(await page.locator("#legend > *").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getElementById("spec").width)).toBeGreaterThan(100);
  });

  test("is self-contained: nothing is requested from another origin", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    const external = [];
    page.on("request", (r) => { const u = r.url(); if (!u.startsWith("http://127.0.0.1:4173/") && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u); });
    await load(page);
    await page.click("#loadSamples");
    await page.waitForTimeout(300);
    expect(external).toEqual([]);
  });

  test("links to the source and the license", async ({ app }) => {
    const src = app.getByRole("link", { name: "Source code" });
    await expect(src).toHaveAttribute("href", "https://github.com/arbrick/router-bit-label-maker");
    await expect(app.getByRole("link", { name: "AGPL-3.0" })).toHaveAttribute("href", "https://www.gnu.org/licenses/agpl-3.0.html");
  });

  test("has an inline icon, so the browser never asks for /favicon.ico", async ({ app }) => {
    await expect(app.locator('link[rel="icon"]')).toHaveAttribute("href", /^data:image\/svg\+xml/);
  });
});

test.describe("designing a label", () => {
  test("picking a bit type updates the label and the key kind", async ({ app }) => {
    const before = await app.locator("#truesize").getAttribute("src");
    await app.click('.pick[data-id="RO"]');
    expect(await app.evaluate(() => [cur.type, cur.kind])).toEqual(["RO", "rad"]);
    await expect(app.locator("#kind")).toHaveValue("rad");
    await expect(app.locator('.pick[data-id="RO"]')).toHaveClass(/on/);
    await expect(app.locator('.pick[data-id="STR"]')).not.toHaveClass(/on/);
    expect(await app.locator("#truesize").getAttribute("src")).not.toBe(before);
  });

  test("the key label follows the kind", async ({ app }) => {
    await app.selectOption("#kind", "rad");
    await expect(app.locator("#keyLbl")).toHaveText("Radius (R)");
    await app.selectOption("#kind", "ang");
    await expect(app.locator("#keyLbl")).toHaveText("Angle (∠)");
    await app.selectOption("#kind", "dia");
    await expect(app.locator("#keyLbl")).toHaveText("Diameter (Ø)");
  });

  test("in diameter mode the cutter Ø is locked to the key value", async ({ app }) => {
    await app.fill("#key", '3/4"');
    await expect(app.locator("#dia")).toHaveValue('3/4"');
    await expect(app.locator("#dia")).toBeDisabled();
    await app.selectOption("#kind", "rad");
    await expect(app.locator("#dia")).toBeEnabled();
  });

  test("editing a field redraws the label and refreshes the QR payload", async ({ app }) => {
    const before = await app.locator("#truesize").getAttribute("src");
    await app.fill("#brand", "Amana");
    await app.fill("#model", "46170");
    await expect(app.locator("#qrtxt")).toHaveValue(/AMANA 46170$/);
    expect(await app.locator("#truesize").getAttribute("src")).not.toBe(before);
    await expect(app.locator("#qrmeta")).toContainText("QR version");
  });

  test("the preview width matches the label's true size at 180 dpi", async ({ app }) => {
    const r = await app.evaluate(() => ({ w: document.getElementById("big").width, css: document.getElementById("truesize").style.width }));
    expect(parseFloat(r.css)).toBeCloseTo(r.w * 25.4 / 180, 2);
  });

  test("a manual QR text overrides the generated one until it is cleared", async ({ app }) => {
    await app.fill("#qrtxt", "MY OWN TEXT");
    expect(await app.evaluate(() => [cur.qrManual, payloadFor(cur)])).toEqual([true, "MY OWN TEXT"]);
    await app.fill("#qrtxt", "");
    expect(await app.evaluate(() => cur.qrManual)).toBe(false);
    await app.locator("#qrtxt").blur();
    await expect(app.locator("#qrtxt")).toHaveValue(/^STR D/);
  });
});

test.describe("QR mode", () => {
  test("link mode builds prefix + ID and shows the prefix field", async ({ app }) => {
    await expect(app.locator("#pfxWrap")).toHaveCSS("visibility", "hidden");
    await app.selectOption("#qrmode", "link");
    await expect(app.locator("#pfxWrap")).toHaveCSS("visibility", "visible");
    await app.fill("#pfx", "HTTP://B.LAN/");
    await app.fill("#bid", "ABC123");
    await expect(app.locator("#qrtxt")).toHaveValue("HTTP://B.LAN/ABC123");
  });

  test("link mode without an ID explains what is missing", async ({ app }) => {
    await app.selectOption("#qrmode", "link");
    await app.fill("#bid", "");
    await expect(app.locator("#qrmeta")).toContainText("give this bit an ID");
  });

  test("the choice is remembered across a reload", async ({ app }) => {
    await app.selectOption("#qrmode", "link");
    await app.fill("#pfx", "HTTP://KEEP.ME/");
    await app.reload();
    await expect(app.locator("#qrmode")).toHaveValue("link");
    await expect(app.locator("#pfx")).toHaveValue("HTTP://KEEP.ME/");
  });

  test("the ID column can be switched off", async ({ app }) => {
    await app.fill("#bid", "ABC123");
    const withId = await app.locator("#truesize").getAttribute("src");
    await app.uncheck("#showId");
    expect(await app.locator("#truesize").getAttribute("src")).not.toBe(withId);
    expect(await app.evaluate(() => JSON.parse(localStorage.getItem("rbl-settings")).showId)).toBe(false);
  });
});

test.describe("my bits list", () => {
  test("starts empty with a hint", async ({ app }) => {
    await expect(app.locator("#list")).toContainText("No bits yet");
    await expect(app.locator("#cnt")).toHaveText("");
  });

  test("adds the current design", async ({ app }) => {
    await app.fill("#bid", "001");
    await app.click("#addList");
    await expect(rows(app)).toHaveCount(1);
    await expect(toast(app)).toHaveText("Added to list");
    await expect(app.locator("#cnt")).toHaveText("(1)");
    await expect(rows(app).first()).toContainText("#001");
    await expect(rows(app).first()).toContainText("Whiteside");
  });

  test("keeps the list across a reload", async ({ app }) => {
    await app.click("#addList");
    await app.click("#addList");
    expect(await storedList(app)).toHaveLength(2);
    await app.reload();
    await expect(rows(app)).toHaveCount(2);
  });

  test("edit loads an entry; Update saves over it; Add as new keeps both", async ({ app }) => {
    await app.fill("#bid", "001"); await app.fill("#model", "AAA"); await app.click("#addList");
    await rows(app).first().getByRole("button", { name: "Edit" }).click();
    await expect(app.locator("#model")).toHaveValue("AAA");
    await expect(app.locator("#updList")).toBeVisible();
    await expect(app.locator("#cancelEdit")).toBeVisible();
    await expect(app.locator("#addList")).toHaveText("Add as new");
    await expect(app.locator("#editNote")).toContainText("Editing entry 1 (#001)");

    await app.fill("#model", "BBB");
    await app.click("#updList");
    await expect(toast(app)).toHaveText("Entry updated");
    await expect(rows(app)).toHaveCount(1);
    expect((await storedList(app))[0].model).toBe("BBB");
    await expect(app.locator("#updList")).toBeHidden();

    await rows(app).first().getByRole("button", { name: "Edit" }).click();
    await app.fill("#bid", "002"); await app.fill("#model", "CCC");
    await app.click("#addList");
    await expect(rows(app)).toHaveCount(2);
    expect((await storedList(app)).map((b) => b.model)).toEqual(["BBB", "CCC"]);
  });

  test("cancel leaves the entry alone", async ({ app }) => {
    await app.fill("#model", "AAA"); await app.click("#addList");
    await rows(app).first().getByRole("button", { name: "Edit" }).click();
    await app.fill("#model", "ZZZ");
    await app.click("#cancelEdit");
    await expect(app.locator("#updList")).toBeHidden();
    await expect(app.locator("#addList")).toHaveText("Add to list");
    expect((await storedList(app))[0].model).toBe("AAA");
  });

  test("delete removes just that entry", async ({ app }) => {
    for (const m of ["A", "B", "C"]) { await app.fill("#bid", m); await app.fill("#model", m); await app.click("#addList"); }
    await rows(app).nth(1).getByRole("button", { name: "✕" }).click();
    await expect(rows(app)).toHaveCount(2);
    expect((await storedList(app)).map((b) => b.model)).toEqual(["A", "C"]);
  });

  test("deleting an entry above the one being edited keeps the edit pointing at the right entry", async ({ app }) => {
    for (const m of ["A", "B", "C"]) { await app.fill("#bid", m); await app.fill("#model", m); await app.click("#addList"); }
    await rows(app).nth(2).getByRole("button", { name: "Edit" }).click();
    await rows(app).nth(0).getByRole("button", { name: "✕" }).click();
    await expect(app.locator("#editNote")).toContainText("Editing entry 2");
    await app.fill("#model", "C2"); await app.click("#updList");
    expect((await storedList(app)).map((b) => b.model)).toEqual(["B", "C2"]);
  });

  test("warns about a duplicate ID but still adds", async ({ app }) => {
    await app.fill("#bid", "007"); await app.click("#addList");
    await app.fill("#bid", "007"); await app.click("#addList");
    await expect(toast(app)).toContainText("ID 007 is already used");
    await expect(rows(app)).toHaveCount(2);
  });

  test("duplicate check ignores case", async ({ app }) => {
    await app.fill("#bid", "abc"); await app.click("#addList");
    await app.fill("#bid", "ABC"); await app.click("#addList");
    await expect(toast(app)).toContainText("already used");
  });

  test("loads the sample set with sequential IDs", async ({ app }) => {
    await app.click("#loadSamples");
    await expect(rows(app)).toHaveCount(16);
    await expect(toast(app)).toHaveText("Samples loaded");
    const ids = (await storedList(app)).map((b) => b.id);
    expect(ids[0]).toBe("001");
    expect(ids[15]).toBe("016");
    await expect(app.locator("#cnt")).toHaveText("(16)");
  });

  test("clearing needs a second tap", async ({ app }) => {
    await app.click("#loadSamples");
    await app.click("#clearList");
    await expect(app.locator("#clearList")).toHaveText("Tap again to clear");
    await expect(rows(app)).toHaveCount(16);
    await app.click("#clearList");
    await expect(rows(app)).toHaveCount(0);
    await expect(app.locator("#clearList")).toHaveText("Clear list");
    expect(await storedList(app)).toEqual([]);
  });

  test("the clear prompt times out on its own", async ({ app }) => {
    await app.click("#loadSamples");
    await app.click("#clearList");
    await expect(app.locator("#clearList")).toHaveText("Clear list", { timeout: 6000 });
    await expect(rows(app)).toHaveCount(16);
  });
});

test.describe("JSON backup", () => {
  test("copy puts the list on the clipboard or in the box, and import restores it", async ({ app }) => {
    await app.click("#loadSamples");
    const original = await app.evaluate(() => JSON.stringify(list));
    await app.click("#copyJson");
    await expect(toast(app)).toHaveText(/Copied|Clipboard blocked/);
    await app.evaluate((json) => { document.getElementById("importBox").value = json; list = []; persist(); renderList(); }, original);
    await app.click("#importBtn");
    await expect(toast(app)).toHaveText("Imported 16");
    expect(await app.evaluate(() => JSON.stringify(list))).toBe(original);
    await expect(rows(app)).toHaveCount(16);
  });

  test("rejects text that is not a JSON list", async ({ app }) => {
    await app.click("#addList");
    for (const bad of ["not json", '{"a":1}', ""]) {
      await app.fill("#importBox", bad);
      await app.click("#importBtn");
      await expect(toast(app)).toHaveText("That isn't a valid list");
    }
    await expect(rows(app)).toHaveCount(1);   // the existing list is untouched
  });
});

test.describe("printer controls", () => {
  test("Bluetooth is labelled experimental, with a tooltip explaining why", async ({ app }) => {
    await expect(app.locator("#ptBt")).toHaveText("Connect Bluetooth (experimental)");
    await expect(app.locator("#ptBt")).toHaveAttribute("title", /re-paired|re-pair|more reliable/);
    await expect(app.locator("#ptUsb")).toHaveText("Connect USB");
  });

  test("the fixed settings have no controls", async ({ app }) => {
    for (const id of ["ptMargin", "ptPadR", "ptTrim"]) await expect(app.locator(`#${id}`)).toHaveCount(0);
    await expect(app.locator("#ptLenMM")).toHaveCount(1);
  });

  test("nothing is connected at first, so printing is off", async ({ app }) => {
    await expect(app.locator("#ptState")).toHaveText("Not connected.");
    await expect(app.locator("#ptPrintCur")).toBeDisabled();
    await expect(app.locator("#ptPrintList")).toBeDisabled();
    await expect(app.locator("#ptDisc")).toBeHidden();
    await expect(app.locator("#ptStop")).toBeHidden();
  });

  test("a browser without WebUSB and Web Serial gets an explanation and no connect buttons", async ({ page, errors }) => { // eslint-disable-line no-unused-vars
    await page.addInitScript(() => { delete Navigator.prototype.usb; delete Navigator.prototype.serial; });
    await load(page);
    await expect(page.locator("#ptSupport")).toContainText("This browser can’t talk to the printer");
  });
});
