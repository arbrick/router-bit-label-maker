import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFile(join(root, p), "utf8");
const pkg = JSON.parse(await read("package.json"));
const exists = (p) => access(join(root, p)).then(() => true, () => false);
const major = (s) => Number(s.match(/(\d+)/)[1]);

test.describe("license", () => {
  test("LICENSE is the AGPL v3 text", async () => {
    const t = await read("LICENSE");
    assert.match(t, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
    assert.ok(t.length > 30_000);
  });

  test("package.json, the README and the notices agree", async () => {
    assert.equal(pkg.license, "AGPL-3.0-only");
    const readme = await read("README.md");
    assert.match(readme, /## License[\s\S]*Copyright \(c\) 2026 Alex Brick[\s\S]*AGPL-3\.0-only/);
    assert.match(readme, /THIRD_PARTY_NOTICES\.md/);
  });

  test("every production dependency has a third-party notice", async () => {
    const notices = await read("THIRD_PARTY_NOTICES.md");
    for (const dep of Object.keys(pkg.dependencies)) {
      const name = dep.startsWith("@fontsource/") ? dep.split("/")[1].replace(/-/g, " ") : dep;
      const words = name.split(/[ -]/).filter((w) => w.length > 3);
      assert.ok(words.every((w) => new RegExp(w, "i").test(notices)), `no notice for ${dep}`);
    }
  });
});

test.describe("node version", () => {
  test("the engines minimum is a supported Node release", () => {
    assert.ok(major(pkg.engines.node) >= 22);
  });

  test("Docker, the dev stack and CI use the same Node", async () => {
    const docker = major((await read("Dockerfile")).match(/FROM node:(\d+)/)[1]);
    const dev = major((await read("compose.dev.yaml")).match(/image: node:(\d+)/)[1]);
    const ci = major((await read(".github/workflows/ci.yml")).match(/node-version: (\d+)/)[1]);
    const pages = major((await read(".github/workflows/pages.yml")).match(/node-version: (\d+)/)[1]);
    assert.deepEqual([dev, ci, pages], [docker, docker, docker]);
    assert.ok(docker >= major(pkg.engines.node));
  });

  test("the version that builds the page is the version running these tests, or newer than the minimum", () => {
    assert.ok(process.versions.node.split(".")[0] >= major(pkg.engines.node));
  });
});

test.describe("docker", () => {
  test("nginx serves on 8080 and allows USB and serial printing", async () => {
    const conf = await read("nginx.conf");
    assert.match(conf, /listen 8080;/);
    assert.match(conf, /Permissions-Policy "usb=\(self\), serial=\(self\)"/);
    assert.match(conf, /X-Content-Type-Options "nosniff"/);
  });

  test("the image copies its files with readable permissions", async () => {
    const d = await read("Dockerfile");
    assert.match(d, /COPY --chmod=644 nginx\.conf/);
    assert.match(d, /COPY --chmod=644 --from=build \/app\/dist\/index\.html/);
    assert.match(d, /nginx-unprivileged/);
    assert.match(d, /EXPOSE 8080/);
  });

  test("the production stack publishes 8080", async () => {
    assert.match(await read("compose.yaml"), /"8080:8080"/);
  });

  test("the dev stack publishes 8000, polls for changes and keeps its own node_modules", async () => {
    const c = await read("compose.dev.yaml");
    assert.match(c, /"8000:8000"/);
    assert.match(c, /WATCH_POLL: "1"/);
    assert.match(c, /HOST: 0\.0\.0\.0/);
    assert.match(c, /node_modules:\/app\/node_modules/);
    assert.match(c, /npm run dev/);
  });

  test("the image build context leaves out what it does not need", async () => {
    const i = (await read(".dockerignore")).split("\n");
    for (const x of ["node_modules", "dist", ".git"]) assert.ok(i.includes(x), `${x} missing from .dockerignore`);
  });
});

test.describe("repository hygiene", () => {
  test("generated output is git-ignored", async () => {
    const g = (await read(".gitignore")).split("\n");
    for (const x of ["node_modules/", "dist/", "test-results/", "playwright-report/"]) assert.ok(g.includes(x), `${x} missing from .gitignore`);
  });

  test("the npm scripts exist and point at real files", async () => {
    for (const s of ["build", "dev", "start", "test", "test:node", "test:browser", "screenshot"]) assert.ok(pkg.scripts[s], `missing script ${s}`);
    for (const f of ["scripts/build.mjs", "scripts/dev.mjs", "scripts/screenshot.mjs", "playwright.config.mjs"]) assert.ok(await exists(f), `${f} missing`);
  });

  test("the node tests run one file at a time (they share dist/)", () => {
    assert.match(pkg.scripts["test:node"], /--test-concurrency=1/);
  });

  test("test tooling is a dev dependency only, so the image build stays lean", () => {
    assert.ok(pkg.devDependencies["@playwright/test"] && pkg.devDependencies.jsqr);
    assert.ok(!pkg.dependencies["@playwright/test"] && !pkg.dependencies.jsqr);
  });

  test("dependencies are pinned exactly", () => {
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} is not pinned`);
  });

  test("the lockfile covers every dependency", async () => {
    const lock = JSON.parse(await read("package-lock.json"));
    for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) assert.ok(lock.packages[`node_modules/${name}`], `${name} missing from the lockfile`);
  });
});

test.describe("README", () => {
  test("leads with the hosted app, a screenshot and a build badge", async () => {
    const r = await read("README.md");
    const tryIt = r.indexOf("## Try it out");
    assert.ok(tryIt > 0 && tryIt < r.indexOf("## The label"), "Try it out comes before the details");
    assert.match(r, /https:\/\/arbrick\.github\.io\/router-bit-label-maker\//);
    assert.match(r, /\]\(docs\/screenshot\.png\)/);
    assert.match(r, /actions\/workflows\/pages\.yml\/badge\.svg/);
    assert.ok(r.indexOf("badge.svg") < tryIt, "the badge sits above the Try it out section");
  });

  test("the screenshot is a real, recent-size PNG", async () => {
    const png = await readFile(join(root, "docs", "screenshot.png"));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.ok(png.readUInt32BE(16) >= 1200 && png.readUInt32BE(20) >= 800, "too small to read");
    assert.ok(png.length < 1_500_000, "keep the README image light");
  });

  test("local links point at files that exist", async () => {
    const r = await read("README.md");
    for (const [, target] of r.matchAll(/\]\((?!https?:|#)([^)#]+)\)/g)) assert.ok(await exists(target), `README links to missing ${target}`);
  });

  test("documents the dev stack, the tests and the minimum Node version", async () => {
    const r = await read("README.md");
    assert.match(r, /docker compose -f compose\.dev\.yaml up/);
    assert.match(r, /npm test/);
    assert.match(r, /Node\.js 22 or newer/);
  });
});

test.describe("workflows", () => {
  test("deploys only after the tests pass", async () => {
    const p = await read(".github/workflows/pages.yml");
    assert.match(p, /test:\s+uses: \.\/\.github\/workflows\/ci\.yml/);
    assert.match(p, /deploy:\s+needs: test/);
  });

  test("the test workflow runs both suites and can be called by others", async () => {
    const c = await read(".github/workflows/ci.yml");
    assert.match(c, /workflow_call:/);
    assert.match(c, /pull_request:/);
    assert.match(c, /npm run test:node/);
    assert.match(c, /npm run test:browser/);
  });

  test("the Pages build installs only production dependencies", async () => {
    assert.match(await read(".github/workflows/pages.yml"), /npm ci --omit=dev/);
  });
});
