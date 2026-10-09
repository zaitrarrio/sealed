#!/usr/bin/env node
/**
 * Runs the web end-to-end suite against a real relay:
 *   1. applies D1 migrations to a fresh local state directory and starts `wrangler dev --env dev` on :8787,
 *   2. starts the Vite dev server on :5173 (the relay's dev env trusts http://localhost:5173 for CORS and WebAuthn),
 *   3. runs Playwright, then stops both servers.
 * Set SEALED_E2E_RELAY_URL / SEALED_E2E_APP_URL to use servers you started yourself.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const relayDir = resolve(web, "../../services/relay");
const RELAY = process.env.SEALED_E2E_RELAY_URL ?? "";
const APP = process.env.SEALED_E2E_APP_URL ?? "";
const children = [];

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  const tag = (d) => process.stderr.write(`[${name}] ${d}`);
  if (process.env.SEALED_E2E_VERBOSE) {
    p.stdout.on("data", tag);
    p.stderr.on("data", tag);
  } else {
    p.stdout.resume();
    p.stderr.on("data", (d) => /error/i.test(String(d)) && tag(d));
  }
  children.push(p);
  return p;
}

async function waitFor(url, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function stopAll() {
  for (const p of children) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

let state = null;
let code = 1;
try {
  const relayUrl = RELAY || "http://127.0.0.1:8787";
  const appUrl = APP || "http://localhost:5173";
  if (!RELAY) {
    state = mkdtempSync(join(tmpdir(), "sealed-e2e-"));
    await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "sealed-meta-dev", "--local", "--env", "dev", "--persist-to", state], { cwd: relayDir });
    start("relay", "pnpm", ["exec", "wrangler", "dev", "--env", "dev", "--port", "8787", "--ip", "127.0.0.1", "--persist-to", state, "--var", `ALLOWED_ORIGINS:${appUrl}`, "--var", `WEBAUTHN_ORIGIN:${appUrl}`], { cwd: relayDir });
  }
  if (!APP) {
    start("vite", "pnpm", ["exec", "vite", "--host", "localhost", "--port", "5173", "--strictPort"], { cwd: web, env: { ...process.env, VITE_RELAY_URL: relayUrl } });
  }
  await waitFor(`${relayUrl}/v1/health`);
  await waitFor(appUrl);
  await run("pnpm", ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
    cwd: web,
    env: { ...process.env, SEALED_E2E_RELAY_URL: relayUrl, SEALED_E2E_APP_URL: appUrl },
  });
  code = 0;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  stopAll();
  if (state) rmSync(state, { recursive: true, force: true });
}
process.exit(code);
