import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setLogSink } from "../src/log";

// The worker runs in the test isolate; capture structured logs instead of printing them.
export const logRecords: Record<string, unknown>[] = [];
setLogSink((r) => {
  logRecords.push(r);
  if (logRecords.length > 5000) logRecords.splice(0, 1000);
});

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
