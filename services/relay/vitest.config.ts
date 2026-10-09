import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests exercise the no-binding path (graceful no-op) except where a test installs its own limiter.
          ratelimits: {},
          bindings: {
            TEST_MIGRATIONS: migrations,
            ALLOWED_ORIGINS: "https://app.test",
            PUBLIC_URL: "",
            WEBAUTHN_RP_ID: "relay.test",
            WEBAUTHN_ORIGIN: "https://relay.test",
            IP_HASH_SECRET: "test-ip-secret",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  };
});
