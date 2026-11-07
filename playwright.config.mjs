import { defineConfig } from "@playwright/test";

// Browser tests run against the built page in the installed Google Chrome (no browser download needed).
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  timeout: 45_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", channel: "chrome" },
  webServer: {
    command: "node scripts/dev.mjs --no-watch",
    env: { PORT: "4173" },
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
