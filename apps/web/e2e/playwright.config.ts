import { defineConfig } from "@playwright/test";
import { register } from "node:module";

// See resolve-hook.mjs: lets Node load @sealed/core's extensionless qrcode deep import.
register("./resolve-hook.mjs", import.meta.url);

const APP = process.env["SEALED_E2E_APP_URL"] ?? "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: APP,
    headless: true,
    trace: "retain-on-failure",
    // WebCrypto, WebAuthn and OPFS require a secure context; http://localhost qualifies.
    permissions: [],
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  outputDir: "../test-results",
});
