/**
 * Self-hosted Sealed relay (spec §9.5, ADR-0012). Runs the exact Worker bundle that `wrangler deploy` ships,
 * on workerd through Miniflare, with Durable Objects (SQLite), R2 and D1 persisted under $SEALED_DATA_DIR.
 *
 *   - D1 migrations in $SEALED_MIGRATIONS_DIR are applied at start, idempotently (tracked in d1_migrations).
 *   - The hourly expiry sweep (spec §9.4) runs on a timer, calling the Worker's scheduled() handler.
 *   - Rate-limit bindings are not configured: the relay treats them as a no-op; put your own edge in front.
 *
 * Configuration comes from the environment; see deploy/selfhost/.env.example.
 */
import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";

const env = process.env;
const DATA_DIR = path.resolve(env.SEALED_DATA_DIR ?? "/data");
const BUNDLE = path.resolve(env.SEALED_BUNDLE ?? "/app/relay/index.js");
const MIGRATIONS_DIR = path.resolve(env.SEALED_MIGRATIONS_DIR ?? "/app/migrations");
const HOST = env.HOST ?? "0.0.0.0";
const PORT = Number(env.PORT ?? "8787");
const COMPATIBILITY_DATE = env.SEALED_COMPATIBILITY_DATE ?? "2026-08-15";
const SWEEP_INTERVAL_MS = Number(env.SEALED_SWEEP_INTERVAL_SECONDS ?? "3600") * 1000;

/** Worker vars/secrets passed through from the container environment when set. */
const PASSTHROUGH = [
  "ALLOWED_ORIGINS",
  "PUBLIC_URL",
  "ENVIRONMENT",
  "WEBAUTHN_RP_ID",
  "WEBAUTHN_RP_NAME",
  "WEBAUTHN_ORIGIN",
  "TURN_KEY_ID",
  "TURN_KEY_API_TOKEN",
  "TURN_URLS",
  "TURN_SHARED_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "FCM_SERVICE_ACCOUNT_JSON",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_KEY_P8",
  "APNS_BUNDLE_ID",
  "APNS_ENVIRONMENT",
  "IP_HASH_SECRET",
];

function bindings() {
  const out = { ENVIRONMENT: "selfhost" };
  for (const k of PASSTHROUGH) if (env[k] !== undefined && env[k] !== "") out[k] = env[k];
  if (!out.IP_HASH_SECRET) {
    console.warn("[sealed] IP_HASH_SECRET is not set; IP hashes use a built-in default key. Set a random secret in production.");
  }
  return out;
}

/** Splits a migration file into statements (no procedural SQL is used in Sealed migrations). */
function splitSql(sql) {
  const withoutComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);");
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const name of files) {
    const done = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(name).first();
    if (done) continue;
    const statements = splitSql(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
    await db.batch([...statements.map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    console.log(`[sealed] applied migration ${name}`);
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  // Miniflare 5 accepts the stable V4 option shape through convertV4MiniflareOptions.
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: HOST,
    port: PORT,
    log: new Log(LogLevel.INFO),
    // The relay emits its own ADR-0015 structured log; Miniflare's access log would print full URLs.
    logRequests: false,
    // Isolated networks: never fetch Cloudflare's request.cf template; requests carry no `cf` object.
    cf: false,
    resourcePersistencePath: DATA_DIR,
    workers: [
      {
        name: "sealed-relay",
        modules: true,
        modulesRoot: path.dirname(BUNDLE),
        scriptPath: BUNDLE,
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [],
        bindings: bindings(),
        durableObjects: {
          TRANSFER: { className: "TransferDO", useSQLite: true },
          IDENTITY: { className: "IdentityDO", useSQLite: true },
        },
        r2Buckets: { BUCKET: "sealed-transfers" },
        d1Databases: { DB: "sealed-meta" },
        cronTriggers: ["17 * * * *"],
      },
    ],
  }));
  const url = await mf.ready;
  await migrate(await mf.getD1Database("DB"));
  console.log(`[sealed] relay listening on ${url.href.replace("127.0.0.1", HOST)} (data: ${DATA_DIR})`);

  const worker = await mf.getWorker();
  const sweep = async () => {
    try {
      await worker.scheduled({ cron: "17 * * * *", scheduledTime: new Date() });
    } catch (e) {
      console.error("[sealed] sweep failed", e);
    }
  };
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[sealed] ${signal}: shutting down`);
    clearInterval(timer);
    await mf.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((e) => {
  console.error("[sealed] failed to start", e);
  process.exit(1);
});
