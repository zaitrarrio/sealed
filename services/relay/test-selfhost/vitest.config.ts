import { defineConfig } from "vitest/config";

/** Plain Node runner for tests against a live relay (no Workers pool). */
export default defineConfig({ test: { root: import.meta.dirname, include: ["**/*.e2e.ts"], testTimeout: 120_000 } });
