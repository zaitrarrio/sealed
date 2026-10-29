#!/usr/bin/env node
/**
 * Development target.
 *
 * 1. Start or reuse Cloudflare tunnels for the relay and the Expo development server.
 * 2. Write those URLs into local env files (not eas.json).
 * 3. Migrate the local relay database.
 * 4. Start the relay and web client if they are not already up.
 * 5. Launch the Expo development server so the development build uses both tunnels.
 */
import { spawn } from "node:child_process";
import {
  applyLocalDatabaseMigrations,
  getMobileEnv,
  getWebEnv,
  isRelayListening,
  isWebListening,
  mobileDir,
  printAddressReport,
  relayDir,
  startOrReuseTunnel,
  tunnels,
  updateAllConfigs,
  waitForServer,
  webDir,
} from "./dev-env-helpers.mjs";

const children = new Set();
let stopping = false;

function log(msg) {
  console.log(`\x1b[36m[sealed-dev]\x1b[0m ${msg}`);
}

function logSuccess(msg) {
  console.log(`\x1b[32m[sealed-dev] ✔ ${msg}\x1b[0m`);
}

function logWarn(msg) {
  console.log(`\x1b[33m[sealed-dev] ⚠ ${msg}\x1b[0m`);
}

function logError(msg) {
  console.error(`\x1b[31m[sealed-dev] ✖ ${msg}\x1b[0m`);
}

function cleanup(code = 0) {
  if (stopping) return;
  stopping = true;
  log("Shutting down child processes...");
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

function prefixOutput(proc, name) {
  const bind = (stream, out) => {
    if (!stream) return;
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  };
  bind(proc.stdout, process.stdout);
  bind(proc.stderr, process.stderr);
}

function track(child) {
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function spawnLogged(name, args, { cwd, env }) {
  const child = track(spawn("pnpm", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
  prefixOutput(child, name);
  return child;
}

async function ensureRelayRunning() {
  if (await isRelayListening()) {
    logSuccess("Relay is already active at http://127.0.0.1:8787");
    logWarn("Restart the relay if it was started before this tunnel, so PUBLIC_URL picks up the new address.");
    return;
  }

  log("Starting local relay on port 8787...");
  spawnLogged("relay", ["exec", "--", "wrangler", "dev", "--env", "dev", "--port", "8787", "--ip", "127.0.0.1"], {
    cwd: relayDir,
    env: process.env,
  });

  const healthy = await waitForServer("http://127.0.0.1:8787/v1/health", 30_000);
  if (healthy) logSuccess("Relay is ready at http://127.0.0.1:8787");
  else logWarn("Relay is taking longer than expected to answer /v1/health");
}

async function ensureWebRunning(relayUrl) {
  if (await isWebListening()) {
    logSuccess("Web client is already active at http://127.0.0.1:5173");
    logWarn("Restart the web client if it was started before this tunnel, so it reads VITE_RELAY_URL.");
    return;
  }

  log("Starting web client on port 5173...");
  spawnLogged("web", ["exec", "--", "vite"], {
    cwd: webDir,
    env: { ...process.env, VITE_RELAY_URL: relayUrl },
  });

  const healthy = await waitForServer("http://127.0.0.1:5173", 30_000);
  if (healthy) logSuccess("Web client is ready at http://127.0.0.1:5173");
  else logWarn("Web client is taking longer than expected to answer");
}

function launchDevServer(relayUrl, devServerUrl) {
  log("Launching Expo development server for the development build...");
  const child = spawn("pnpm", ["exec", "--", "expo", "start", "--dev-client", "--port", String(tunnels.devServer.port)], {
    cwd: mobileDir,
    stdio: "inherit",
    env: {
      ...process.env,
      EXPO_PUBLIC_RELAY_URL: relayUrl,
      EXPO_PACKAGER_PROXY_URL: devServerUrl,
    },
  });
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    cleanup(code ?? 0);
  });
}

async function main() {
  console.log("\n======================================================");
  console.log("  Sealed Development Target");
  console.log("======================================================\n");

  const relayUrl = await startOrReuseTunnel(tunnels.relay, { verbose: true });
  const devServerUrl = await startOrReuseTunnel(tunnels.devServer, { verbose: true });

  log("Updating configuration with the active tunnel URLs...");
  updateAllConfigs({ relayUrl, devServerUrl });
  applyLocalDatabaseMigrations();

  const mobileEnv = getMobileEnv();
  const webEnv = getWebEnv();
  printAddressReport({
    title: "SEALED DEVELOPMENT SERVERS",
    relayTunnelUrl: relayUrl,
    devServerTunnelUrl: devServerUrl,
    mobileRelayUrl: mobileEnv.EXPO_PUBLIC_RELAY_URL,
    webRelayUrl: webEnv.VITE_RELAY_URL,
  });

  await ensureRelayRunning();
  log(`Verifying tunnel routing to the relay (${relayUrl}/v1/health)...`);
  const tunnelHealthy = await waitForServer(`${relayUrl}/v1/health`, 15_000);
  if (tunnelHealthy) logSuccess(`Tunnel routing verified: ${relayUrl}/v1/health answered 200 OK`);
  else logWarn(`Tunnel routing verification pending: ${relayUrl}`);

  await ensureWebRunning(relayUrl);
  launchDevServer(relayUrl, devServerUrl);
}

main().catch((err) => {
  logError(err.message || String(err));
  cleanup(1);
});
