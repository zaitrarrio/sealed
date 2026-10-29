#!/usr/bin/env node
/**
 * Start or reuse the relay and Expo development-server tunnels, then configure local env files.
 * Tunnels stay up after this process exits. Stop them with `node tools/dev-down.mjs`.
 */
import fs from "node:fs";
import {
  getMobileEnv,
  getWebEnv,
  isProcessAlive,
  printAddressReport,
  startOrReuseTunnel,
  tunnels,
  updateAllConfigs,
} from "./dev-env-helpers.mjs";

function readPid(pidFile) {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  return raw ? Number(raw) : null;
}

async function run() {
  console.log("\x1b[36m[tunnel]\x1b[0m Checking for existing Cloudflare tunnels...");
  const relayUrl = await startOrReuseTunnel(tunnels.relay, { verbose: true });
  const devServerUrl = await startOrReuseTunnel(tunnels.devServer, { verbose: true });
  updateAllConfigs({ relayUrl, devServerUrl });

  const mobileEnv = getMobileEnv();
  const webEnv = getWebEnv();
  printAddressReport({
    title: "SEALED CLOUDFLARE TUNNELS",
    relayTunnelUrl: relayUrl,
    devServerTunnelUrl: devServerUrl,
    mobileRelayUrl: mobileEnv.EXPO_PUBLIC_RELAY_URL,
    webRelayUrl: webEnv.VITE_RELAY_URL,
  });

  const relayPid = readPid(tunnels.relay.pidFile);
  console.log("\x1b[36m[tunnel]\x1b[0m Tunnels are forwarding. Monitoring the relay tunnel. Ctrl+C leaves them running; `task dev:down` stops them.");
  while (relayPid && isProcessAlive(relayPid)) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("\x1b[33m[tunnel] ⚠ Relay tunnel process exited.\x1b[0m");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

run().catch((err) => {
  console.error("\x1b[31m[tunnel] ✖ " + (err.message || String(err)) + "\x1b[0m");
  process.exit(1);
});
