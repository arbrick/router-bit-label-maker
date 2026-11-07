// Builds dist/index.html: one self-contained page with fonts and libraries inlined.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const b64 = async (p) => (await readFile(nm(p))).toString("base64");
// keep "</script" inside inlined libraries from closing the tag early
const js = async (p) => (await readFile(nm(p), "utf8")).replaceAll("</script", "<\\/script");

export async function build() {
  let html = await readFile(join(root, "src", "index.html"), "utf8");
  const swaps = {
    __FONT700__: await b64("@fontsource/roboto-condensed/files/roboto-condensed-latin-700-normal.woff2"),
    __FONT800__: await b64("@fontsource/roboto-condensed/files/roboto-condensed-latin-800-normal.woff2"),
    __FONTAZ__: await b64("@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff2"),
    "/*QRLIB*/": await js("qrcode-generator/qrcode.js"),
    "/*ZIPLIB*/": await js("jszip/dist/jszip.min.js"),
  };
  for (const [k, v] of Object.entries(swaps)) {
    if (!html.includes(k)) throw new Error(`placeholder ${k} missing from src/index.html`);
    html = html.split(k).join(v);
  }
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), html);
  return html.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = await build();
  console.log(`dist/index.html written (${(n / 1024).toFixed(0)} KB)`);
}
