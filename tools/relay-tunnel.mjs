#!/usr/bin/env node

/**
 * Cloudflare Tunnel relay connector and configurator.
 *
 * 1. Opens a Cloudflare Tunnel pointing to the local relay (port 8787).
 * 2. Extracts the public trycloudflare.com URL.
 * 3. Configures the relay (.dev.vars, PUBLIC_URL, ALLOWED_ORIGINS).
 * 4. Configures the mobile app (.env and eas.json EXPO_PUBLIC_RELAY_URL).
 * 5. Configures the web client (.env.local VITE_RELAY_URL).
 * 6. Optionally starts the relay Worker alongside the tunnel.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RELAY_DIR = path.join(ROOT_DIR, "services", "relay");
const MOBILE_DIR = path.join(ROOT_DIR, "apps", "mobile");
const WEB_DIR = path.join(ROOT_DIR, "apps", "web");

const args = process.argv.slice(2);
const startRelay = args.includes("--start-relay");
const configureOnly = args.includes("--configure-only");

const portArgIdx = args.indexOf("--port");
const port = portArgIdx !== -1 && args[portArgIdx + 1] ? Number(args[portArgIdx + 1]) : 8787;

const urlArgIdx = args.indexOf("--url");
const explicitUrl = urlArgIdx !== -1 && args[urlArgIdx + 1] ? args[urlArgIdx + 1] : process.env.TUNNEL_URL;

function updateEnvFile(filePath, key, value, examplePath = null) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf-8");
  } else if (examplePath && fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content ? `${content.trimEnd()}\n${key}=${value}\n` : `${key}=${value}\n`;
  }
  fs.writeFileSync(filePath, content, "utf-8");
}

export function configureRelay(tunnelUrl) {
  const trimmedUrl = tunnelUrl.replace(/\/+$/, "");
  console.log(`\n[relay-tunnel] Configuring relay and apps with tunnel URL: ${trimmedUrl}`);

  // 1. Configure services/relay/.dev.vars
  const relayDevVars = path.join(RELAY_DIR, ".dev.vars");
  const relayEnvExample = path.join(RELAY_DIR, ".env.example");
  updateEnvFile(relayDevVars, "PUBLIC_URL", trimmedUrl, relayEnvExample);
  updateEnvFile(relayDevVars, "ALLOWED_ORIGINS", `http://localhost:5173,http://127.0.0.1:5173,${trimmedUrl}`, relayEnvExample);
  console.log(`  ✓ Updated ${path.relative(ROOT_DIR, relayDevVars)} (PUBLIC_URL=${trimmedUrl})`);

  // 2. Configure apps/mobile/.env
  const mobileEnv = path.join(MOBILE_DIR, ".env");
  const mobileEnvExample = path.join(MOBILE_DIR, ".env.example");
  updateEnvFile(mobileEnv, "EXPO_PUBLIC_RELAY_URL", trimmedUrl, mobileEnvExample);
  console.log(`  ✓ Updated ${path.relative(ROOT_DIR, mobileEnv)} (EXPO_PUBLIC_RELAY_URL=${trimmedUrl})`);

  // 3. Configure apps/mobile/eas.json
  const easJsonPath = path.join(MOBILE_DIR, "eas.json");
  if (fs.existsSync(easJsonPath)) {
    try {
      const easConfig = JSON.parse(fs.readFileSync(easJsonPath, "utf-8"));
      if (easConfig.build?.development) {
        easConfig.build.development.env = easConfig.build.development.env || {};
        easConfig.build.development.env.EXPO_PUBLIC_RELAY_URL = trimmedUrl;
      }
      if (easConfig.build?.["development:simulator"]) {
        easConfig.build["development:simulator"].env = easConfig.build["development:simulator"].env || {};
        easConfig.build["development:simulator"].env.EXPO_PUBLIC_RELAY_URL = trimmedUrl;
      }
      fs.writeFileSync(easJsonPath, JSON.stringify(easConfig, null, 2) + "\n", "utf-8");
      console.log(`  ✓ Updated ${path.relative(ROOT_DIR, easJsonPath)} build profiles with EXPO_PUBLIC_RELAY_URL`);
    } catch (err) {
      console.warn(`  ! Could not update eas.json: ${err.message}`);
    }
  }

  // 4. Configure apps/web/.env.local
  const webEnv = path.join(WEB_DIR, ".env.local");
  const webEnvExample = path.join(WEB_DIR, ".env.example");
  updateEnvFile(webEnv, "VITE_RELAY_URL", trimmedUrl, webEnvExample);
  console.log(`  ✓ Updated ${path.relative(ROOT_DIR, webEnv)} (VITE_RELAY_URL=${trimmedUrl})`);

  // 5. Store in repository root for convenience
  const rootRelayUrlFile = path.join(ROOT_DIR, ".relay-url");
  fs.writeFileSync(rootRelayUrlFile, trimmedUrl + "\n", "utf-8");
  console.log(`  ✓ Saved active tunnel URL to .relay-url\n`);
}

if (explicitUrl) {
  configureRelay(explicitUrl);
  if (configureOnly) {
    process.exit(0);
  }
}

let relayProc = null;
let tunnelProc = null;

function cleanup() {
  if (tunnelProc) {
    try {
      tunnelProc.kill("SIGTERM");
    } catch {}
    tunnelProc = null;
  }
  if (relayProc) {
    try {
      relayProc.kill("SIGTERM");
    } catch {}
    relayProc = null;
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Run migrations and optionally start relay
if (startRelay) {
  console.log("[relay-tunnel] Ensuring local D1 database migrations are applied...");
  try {
    execSync("pnpm --filter @sealed/relay db:migrate:local", {
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
  } catch (err) {
    console.warn("[relay-tunnel] Migration check completed with status:", err.status);
  }

  console.log(`[relay-tunnel] Starting relay Worker locally on port ${port}...`);
  relayProc = spawn("pnpm", ["--filter", "@sealed/relay", "exec", "wrangler", "dev", "--env", "dev", "--port", String(port)], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
  });

  relayProc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[relay-tunnel] Relay worker exited with code ${code}`);
    }
    cleanup();
    process.exit(code || 0);
  });
}

// Start cloudflared tunnel
console.log(`[relay-tunnel] Opening Cloudflare Tunnel to http://127.0.0.1:${port}...`);
tunnelProc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

let configured = Boolean(explicitUrl);

function handleOutput(data) {
  const text = data.toString();
  process.stdout.write(text);

  if (!configured) {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const tunnelUrl = match[0];
      configured = true;
      configureRelay(tunnelUrl);
      console.log(`\n======================================================`);
      console.log(`  🎉 Cloudflare Tunnel Relay is Live!`);
      console.log(`  Public Relay URL: ${tunnelUrl}`);
      console.log(`  Local Address:    http://127.0.0.1:${port}`);
      console.log(`======================================================\n`);
    }
  }
}

tunnelProc.stdout.on("data", handleOutput);
tunnelProc.stderr.on("data", handleOutput);

tunnelProc.on("exit", (code) => {
  console.log(`[relay-tunnel] Cloudflare tunnel exited with code ${code}`);
  cleanup();
  process.exit(code || 0);
});
