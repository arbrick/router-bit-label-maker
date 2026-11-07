# AGENTS.md

Guidance for coding agents working on this repository. Read the README for the user-facing picture. This file covers how the code is put together and which constraints must not be broken.

## What this is

A single-page web app that designs standard labels for router bits and prints them. The labels go on **12 mm TZe tape** on a Brother **PT-P710BT (P-touch Cube Plus)**. The printer prints at **180 dpi**, and the label is exactly **64 dots tall** (9 mm, the full printable band on 12 mm tape). The page can print directly over **WebUSB** (primary) or **Web Serial** (Bluetooth SPP), and can export PNG, ZIP, PDF, CSV and JSON.

The owner prints from a **Mac**. Brother has no macOS system driver for this printer, so the PDF export only helps on a Windows PC. Direct printing from the browser is the real path.

## Commands

```sh
npm install        # deps: fonts + qrcode-generator + jszip (no dev deps, no framework)
npm run build      # src/index.html -> dist/index.html (inlines fonts/libs)
npm run dev        # build + serve http://localhost:8000 + rebuild on src/ change (PORT, HOST env vars)
npm start          # serve without watching
docker compose up -d --build   # nginx on :8080
```

There is no test suite, linter or bundler. `scripts/build.mjs` does placeholder string substitution and nothing else.

## Layout

```
src/index.html      the whole app: HTML, CSS, JS in one file (~750 lines)
scripts/build.mjs   replaces placeholders with base64 fonts and inlined JS
scripts/dev.mjs     tiny node:http server; sends Permissions-Policy: usb=(self), serial=(self)
Dockerfile          node:26-alpine build stage -> nginxinc/nginx-unprivileged:1.27-alpine on 8080
nginx.conf          serves index.html with the same Permissions-Policy header
```

`dist/` and `node_modules/` are git-ignored. Never edit `dist/index.html` by hand.

### Build placeholders (must stay in `src/index.html`)

`build.mjs` throws if any of these are missing:

- `__FONT700__`, `__FONT800__`: Roboto Condensed, weights 700 and 800 (font family `"RC"`)
- `__FONTAZ__`: Atkinson Hyperlegible Next, weight 700 (family `"AZ"`), used only for **slashed zeros**
- `/*QRLIB*/`: qrcode-generator, which provides the global `qrcode()`
- `/*ZIPLIB*/`: JSZip, which provides the global `JSZip`

The built page must stay **fully self-contained**. Load nothing from a CDN or the network at runtime: it is used offline and on a LAN.

## Code map (`src/index.html`)

**Catalog and drawing**
- `TYPES` / `TYPE`: the bit-type catalog. Each entry has `id` (the code in the QR, e.g. `STR`, `SFTC`, `PTR`), `name`, `kind` (`dia` | `rad` | `ang`, which picks the Ø / R / ∠ key prefix) and `note`.
- `MODE` maps the spiral trim/pattern ids to `up` / `down` / `cmp`.
- `drawProfile(c, id, ox)`: pictograms in a 52×64 box, cutter area from row 24 down. Helpers: `bearing`, `stripes`, `arrow`, `spiralCut`, `poly`, `rect`.
- `drawShank` / `shankW`: the shank bar in rows 0–21. Bar width encodes the size. Metric shanks print the number only.
- Text helpers:
  - `rich` / `fitRich`: stacked fractions, a chunky decimal point and small `mm` units.
  - `prefixGlyph`: Ø, R and ∠.
  - `ibeam`: the cut-length icon.
  - `zText` / `zW`: Roboto Condensed text, but every `0` is drawn in Atkinson so it shows a slashed zero.
- `threshold(c, w, h)`: forces pure black and white. Every label goes through this before the QR is drawn.

**Layout and fitting**
- `renderAt(cv, b, w)` draws one label at width `w`. Zones from left to right:
  - shank and profile (x 0–51)
  - text block from x=55: key size, then secondary (Ø / cut length), then brand/model
  - an optional vertical bit ID column, 16 dots wide
  - a 6-dot quiet zone, then the QR flush right at 2 dots per module

  It stores its layout in `cv._lay`.
- `renderLabel(cv, b, opt)` is the entry point everything uses. It fits the design to `budgetDots()` and trims blank edges with `ptCrop` and `cropCanvas`. Passing `{fixedW}` skips fitting.
- `budgetDots()` = `(S.lenMM − 2·(margin_mm + S.extraMM)) × 180/25.4`, minus the right padding that `renderLabel` adds. `S.extraMM` is the feed the printer adds at each end, on top of the requested margin; it defaults to 0 (a real print with no feed margin measured 31.08 mm from a 31.3 mm design). The old 1.3 mm default came from a print with 2 mm margins. `S.cal` marks settings saved after that change.

**QR**
- `payloadFor(b)` returns:
  - in data mode, `autoPayload` (uppercase alphanumeric, e.g. `RO D1-1/4 R3/8 CL5/8 OL2-1/2 SH1/2 FREUD 34-118`)
  - in link mode, `S.pfx + b.id`
  - a manual override when `b.qrManual` is set
- `makeQR` prefers ECC Q, then M, at v1–v2, and falls back to v3. **v3 (29 modules = 58 dots) is the largest that fits 64 dots tall at 2 dots/module.** Never use 1 dot/module: phones can't read it off thermal tape.

**State and UI**
- `S` holds settings and is persisted in `localStorage["rbl-settings"]`: `qrmode`, `pfx`, `showId`, `lenMM`, `marginDots`, `padR`, `extraMM`, `cal`, `trim`, `orient`. `marginDots` (0), `padR` (14 dots, 2 mm of white after the QR) and `trim` (true) are forced on every load and have no UI: the printer keeps about 2 mm on the leading edge regardless, so the right padding is what centres the label.
- `list` is the bit list in `localStorage["rbl-list"]`. Each bit has `{id, type, sh, kind, key, dia, cl, ol, brand, model, qr?, qrManual}`.
- Wrap all storage access in try/catch: it can be missing.
- `refresh()` re-renders the preview. `renderList()` re-renders the list.
- Editing: `setEdit(i)` and `editIdx`. **Add** always appends. **Update** replaces only the entry being edited.
- In diameter mode, the Cutter Ø field is locked and mirrors the key value.
- `save(filename, data)` goes through the claude.ai `downloads` capability when the page is hosted there, and falls back to a message otherwise.
- `buildPdf`: one label per page, a 1-bit image with `/Interpolate false`, Flate-compressed through `CompressionStream`.

## Printer protocol: do not change casually

`ptJob(cv, {chain, orient, trim, margin})` builds the raster job. The sequence matches what Brother's SDK sends for the PT-P710BT. The printer **silently accepts and ignores** jobs that differ from it.

1. Status request `1B 69 53` (sent separately by `ptStatus` before every label). The 32-byte reply starts `80 20 42`; the model code at byte 4 is `0x76`.
2. `00` ×100 (invalidate) → `1B 69 61 01` (raster mode) → `1B 40` (init) → `1B 69 21 00` (status notifications on)
3. `1B 69 7A 84 01 0C 00 <lines LE32> 00 00`: print info. **The page byte must be `00`**; `02` makes the P710BT ignore the job.
4. `1B 69 4B 00|08`: chain on / off. Only the last label of a batch uses `08`.
5. `1B 69 4D 40` (auto cut) → `1B 69 41 01` (cut every label) → `1B 69 64 <margin LE16>` (margin in dots; fixed at 0 here, Brother's default is 14)
6. `4D 02` (TIFF/PackBits) → one `47 11 00 0F <16 bytes>` per raster line (a PackBits literal run). **Never send `5A`** (zero raster): send blank lines in full.
7. `1A` (print with feed). After a completion report (status byte 18 = `0x01`), wait about 1 s, then send `1B 69 61 FF`.

**Raster geometry:** a 128-pin head, 16 bytes per line, MSB first (pin 0 = bit 7 of byte 0). On 12 mm tape, pins 29–98 are printable. The 64-dot label is centered at **pins 32–95** (`OFF = 32`). One raster line is one column along the tape. `orient` (`normal` / `rot180` / `mirror` / `flip`) is a user fallback, because the mapping from image to head has **not yet been confirmed on hardware**.

**Transports:**
- `PtUsb`: vendor `0x04F9`, product `0x20AF`. It finds the interface with class 7, uses bulk OUT and IN, and writes in 4096-byte chunks.
- `PtSerial`: Web Serial with the SPP UUID. It paces writes at 512 bytes + 25 ms. Bluetooth is labelled experimental: on macOS the printer only answered right after a fresh pairing, then needed a forget and re-pair (see the README).
- Both extend `PtLink`, a buffered reader with `read32(timeoutMs)`.
- USB reports completion. Bluetooth may not, so `ptPrintOne` falls back to a timed wait there.
- Don't send status requests in the middle of a job.

Error bits are decoded in `ptErrText`:
- byte 8: no tape, cutter jam, weak battery
- byte 9: replace tape, cover open, overheating
- byte 10: tape width in mm (labels require 12)

**Secure context:** WebUSB and Web Serial need `https://` or `http://localhost`, plus `Permissions-Policy` allowing `usb` and `serial`. `file://` and plain-HTTP LAN addresses don't work, and the claude.ai preview iframe blocks them too.

## Design rules

- **Pixel-exact output.** Draw at 1 dot = 1 pixel and threshold before the QR. Never scale a label with smoothing; upscale only with nearest-neighbor (`pngBlob`, `bits1`).
- **The minimum legible sizes at 180 dpi have already been tuned:**
  - row-2 text floor: 12 px, beyond which units are dropped
  - brand/model floor: 9 px, beyond which only the model is shown
  - key size: never shrink much below 14–16 px

  Check legibility visually after any layout change.
- **Sorting priority drives the layout:** shank (A) → type (B) → key size (C) → cut length (D). Don't demote the shank bar or the key size.
- Keep the zero/O distinction (`zText`) on the ID and brand/model lines. **Don't** use slashed zeros in the key size: they could be mistaken for the Ø symbol.
- Metric values: a fraction means inches, a whole number means mm. The shank bar shows the number only.
- Keep it one file with no framework and no runtime network.

## Verifying changes

There are no automated tests. The checks used so far, all run headless in Chrome (Playwright) against `dist/index.html`:

1. **Render a grid** of the sample labels (`SAMPLES`, via "Load sample set") at 4× and look at it.
2. **Decode every QR** with OpenCV (`cv2.QRCodeDetector`) on 4× renders with a white border added.
3. **Decode `ptJob` output** back into a bitmap:
   - Parse the header bytes against the sequence above.
   - Unpack the PackBits lines and compare them with the label canvas. Expect 0 differing dots and no ink outside pins 32–95.
4. **Run `ptPrint` against a mock `PtLink`** that answers status requests and emits `06/01 → 01 → 06/00`. Also check the error path, e.g. byte 9 = `0x10` gives "cover open".
5. **Check the PDF** with `qpdf --check`, render it at 180 dpi with `pdftoppm`, and compare it with the label (0 differing pixels on the 9 mm page).

**Hardware:** confirmed on a real PT-P710BT so far:
- it prints
- the label length (which is why length fitting and calibration exist)
- Bluetooth printing, with the caveat above

Orientation is not yet confirmed. Don't claim hardware behavior that hasn't been observed.

## Credits and licensing

- Approach and protocol knowledge come from [Ircama/PT-P300BT](https://github.com/Ircama/PT-P300BT) (Web Serial printing, chaining), [Kunkles/brother-ptouch-printer-use](https://github.com/Kunkles/brother-ptouch-printer-use) (P710BT job sequence, status, USB, pitfalls), Brother's Raster Command Reference for the PT-E550W/P750W/P710BT, and ptouch-print.
- **No code was copied** from those projects. Keep it that way, or add proper attribution and license compliance if that ever changes.
- Bundled: qrcode-generator (MIT), JSZip (MIT or GPL-3.0-or-later), Roboto Condensed and Atkinson Hyperlegible Next (SIL OFL 1.1).
- The project is licensed **AGPL-3.0-only** (`LICENSE`); `THIRD_PARTY_NOTICES.md` carries the bundled packages' notices. Keep both accurate when dependencies change.
- Keep the README's credits section accurate when anything changes.
