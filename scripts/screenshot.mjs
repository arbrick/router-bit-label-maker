// Regenerates docs/screenshot.png (the README picture) from the built page, using the installed Google Chrome.
//   npm run screenshot
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { build } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build();

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 1.5 });
await page.goto(pathToFileURL(join(root, "dist", "index.html")).href);
await page.waitForFunction(() => document.getElementById("ptLen")?.textContent);

// a recognisable design, plus the sample set so the list is populated
await page.click("#loadSamples");
await page.click('.pick[data-id="RO"]');
await page.selectOption("#sh", "1/2");
await page.fill("#key", '3/8"');
await page.fill("#dia", '1-1/4"');
await page.fill("#cl", '5/8"');
await page.fill("#ol", '2-1/2"');
await page.fill("#brand", "Freud");
await page.fill("#model", "34-118");
await page.fill("#bid", "017");
await page.evaluate(() => document.activeElement.blur());
await page.waitForTimeout(2400); // let the "Samples loaded" toast fade

await page.screenshot({ path: join(root, "docs", "screenshot.png"), clip: { x: 0, y: 0, width: 1240, height: 1210 }, fullPage: true });
await browser.close();
console.log("wrote docs/screenshot.png");
