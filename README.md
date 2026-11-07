# Router Bit Label Maker

Standard labels for router bits, sized for **12 mm TZe tape** on Brother P-touch Cube printers. Every label shows what you need to put a bit back in the right spot (shank size, bit type, key dimension, cut length), plus a QR code with the rest. Labels can print straight from the browser to a **PT-P710BT (Cube Plus)** over USB (recommended) or Bluetooth (experimental). No Brother driver or P-touch Editor needed.

The whole app is a single self-contained HTML page: fonts and libraries are inlined at build time, so it works offline and can be hosted anywhere.

## The label

The label is 64 dots tall (9 mm, the full print area on 12 mm tape at 180 dpi). Its length is fitted to a target, 34 mm by default.

| Zone | Content |
|---|---|
| **A · Shank** | Black bar with the shank size in white. The bar's width also encodes it: narrow ¼″, medium metric, wide ½″. A fraction means inches; a whole number means mm. |
| **B · Profile** | Pictogram of the cutter's side profile. A hollow box means a bearing. Spiral flutes show their direction and chip-flow arrows. There are 34 types, including downcut and compression variants of the trim/pattern bits. |
| **C · Key size** | The number that tells bits of the same type apart: **Ø** diameter, **R** radius (roundover, cove, beading) or **∠** angle (chamfer, V-groove). Fractions are stacked. |
| **D · Secondary** | Cut length, plus cutter Ø when the key size is a radius or angle. |
| **E · Brand/model** | Small caps, with slashed zeros so 0 and O stay distinct. Falls back to the model number alone if both won't fit. |
| **Bit ID** | Optional. Printed vertically beside the QR code. |
| **F · QR** | Either **specs** (type, Ø, cut length, overall length, shank, brand, model) or a **link**: your prefix + the bit ID, e.g. `HTTP://B.LAN/ABC123`, pointing at your inventory app. QR v1–v3 at 2 dots per module. |

## Using it

1. Pick a bit type, then fill in the shank, sizes, brand and model.
2. Add the bit to the list. Press **Edit** on an entry to change it, then **Update entry** to save over it, or **Add as new** to keep both.
3. Print, or export your labels:
   - **Print directly** (Chrome or Edge on desktop): connect over USB (Bluetooth is experimental, see below), then press **Print current label** or **Print whole list**. "Chain labels" cuts between labels and only feeds after the last one, which saves tape.
   - **PNG / ZIP** for the phone app (P-touch Design&Print 2).
   - **PDF**, one label per page. This only helps on a Windows PC with Brother's printer driver; on macOS the printer can't be added as a system printer.
   - **CSV / JSON** to import into an inventory app or back up your list.

The list and settings are saved in the browser (`localStorage`), so each origin (localhost, your server) keeps its own copy. Use **Copy list as JSON** → **Import** to move a list between them.

### Getting the length right

Set **Label length on tape** (default 34 mm), print one label, measure it, and enter the measurement under **Calibrate length**. After that, the design re-fits so labels match your target. The default assumes the printer adds no feed of its own at each end (with the feed margin at none, one measured PT-P710BT label came out 31.08 mm from a 31.3 mm design); calibrate if yours differs.

These are fixed rather than settings: no feed margin, blank edges trimmed, and 2 mm of padding after the QR code. The PT-P710BT keeps about 2 mm on the leading edge regardless, while the trailing edge gets no extra space, so the right padding centres the label, including with "Chain labels".

## Direct printing: requirements

- **Browser:** desktop Chrome or Edge. Safari and Firefox don't support WebUSB or Web Serial.
- **Secure origin:** browsers only allow USB and serial access from `https://` pages or `http://localhost`. Opening the file from disk (`file://`) won't work, and neither will a plain-HTTP LAN address like `http://192.168.1.10:8080`. Use the local dev server, or put the container behind HTTPS (see below).
- **One connection at a time:** close P-touch Editor and the phone app before connecting.
- **Printer:** built for and tested against the protocol of the **PT-P710BT** with 12 mm tape. Other models in the same protocol family (PT-E550W, PT-P750W) may work but are untested. USB is the more reliable route; over Bluetooth the printer may not report when a label is done, so the page waits a fixed time.
- **Bluetooth (experimental), on macOS:** pair the printer in System Settings first, then pick the plain **`cu.PT-P…`** entry in Chrome's chooser. If the entry reads **`cu.PT-P… - Paired`**, there is no live link: the port opens but the printer never answers ("didn't answer … 0 bytes received"). On the tested setup the link only worked right after pairing, and once a session ended the only fix was **Forget This Device** and pairing again. Disconnect/Connect in System Settings and restarting the printer didn't help. Use USB for regular printing.
- **First print:** if it comes out mirrored or upside down, open **If the first test label prints mirrored or upside down** under the print buttons and pick the fix. The choice is remembered.

## Hosted copy (GitHub Pages)

Every push to `main` builds the page and publishes it to <https://arbrick.github.io/router-bit-label-maker/> through `.github/workflows/pages.yml`. It is served over HTTPS, so direct printing works from any computer without a local server or reverse proxy. Your list and settings stay in your browser's `localStorage` for that origin.

## Local development (no container)

Requires Node.js 18 or newer.

```sh
npm install
npm run dev      # builds dist/index.html, serves http://localhost:8000, rebuilds when src/ changes
```

- Change the port or host with `PORT=9000 npm run dev` or `HOST=0.0.0.0 npm run dev`.
- `npm run build` only writes `dist/index.html`.
- `npm start` serves it without watching.

Because the dev server runs on `localhost`, direct printing works with it.

## Deploy with Docker

```sh
docker compose up -d --build     # http://<host>:8080
# or
docker build -t router-bit-label-maker .
docker run -d -p 8080:8080 --name router-bit-labels router-bit-label-maker
```

The image is a two-stage build. A `node:26-alpine` stage inlines the assets, and an unprivileged `nginx-unprivileged:1.27-alpine` stage serves the single page on port 8080, with a `Permissions-Policy` header that allows `usb` and `serial`.

**HTTPS is needed for printing from other machines.** Put the container behind a reverse proxy with a certificate, for example with Caddy:

```
labels.home.example.com {
    reverse_proxy router-bit-labels:8080
}
```

Without HTTPS, the page still designs and exports labels; only direct printing is disabled.

## Project layout

```
src/index.html       the app: markup, styles and all logic (fonts/libs are placeholders)
scripts/build.mjs    inlines fonts and libraries → dist/index.html
scripts/dev.mjs      local server + rebuild on change
Dockerfile           build stage + nginx stage
nginx.conf           static serving, Permissions-Policy header
compose.yaml         one-service compose file
```

## Credits

The direct-printing feature was inspired by other people's work and is built on their published notes. No code was copied from these projects; the implementation here is original JavaScript.

- **[Ircama/PT-P300BT](https://github.com/Ircama/PT-P300BT)** showed that a P-touch Cube can be driven straight from a web page using the **Web Serial API** over Bluetooth SPP. This project borrows that approach for its Bluetooth option, and borrows the idea of chaining labels by turning off the end-of-print feed. Its live web app is at <https://ircama.github.io/PT-P300BT/>.
- **[Kunkles/brother-ptouch-printer-use](https://github.com/Kunkles/brother-ptouch-printer-use)** is the source for the PT-P710BT specifics this project follows: the exact job sequence Brother's SDK sends (including page byte `00`), the 32-byte status layout and error bits, the USB interface and endpoints, and the pitfalls (TIFF-only zero-raster lines, the head-to-cutter distance).
- **Brother, [Software Developer's Manual: Raster Command Reference PT-E550W/P750W/P710BT](https://download.brother.com/welcome/docp100064/cv_pte550wp750wp710bt_eng_raster_102.pdf)** is the command reference and the source of the 12 mm tape pin table (29 / 70 / 29).
- **[ptouch-print](https://git.familie-radermacher.ch/linux/ptouch-print.git)** by Dominic Radermacher was the reference for how image rows map onto the print head.

### Bundled libraries and fonts

These are inlined into `dist/index.html` at build time:

| Package | License |
|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | MIT |
| [JSZip](https://github.com/Stuk/jszip) | MIT or GPL-3.0-or-later |
| [Roboto Condensed](https://fonts.google.com/specimen/Roboto+Condensed) via @fontsource | SIL OFL 1.1 |
| [Atkinson Hyperlegible Next](https://www.brailleinstitute.org/freefont/) via @fontsource (slashed zero) | SIL OFL 1.1 |

## License

Copyright (c) 2026 Alex Brick. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

You can use, modify and deploy this project, including commercially. If you distribute a modified version, or let others use one over a network (for example a hosted copy), you must offer them the corresponding source under the same license, and keep this copyright notice. Bundled third-party code and fonts keep their own licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Brother, P-touch and P-touch Cube are trademarks of Brother Industries, Ltd. This project is not affiliated with Brother.
