import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
  /** Vite's static glob import (transformed at build time by the test runner). */
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, unknown>;
  }
}
