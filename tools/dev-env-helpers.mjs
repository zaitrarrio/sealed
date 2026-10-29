/**
 * Cloudflare tunnel lifecycle and local configuration.
 * Same model as murmur-expo `scripts/dev-env-helpers.mjs`: detached cloudflared,
 * pid/url files, reuse when the edge is still forwarding, and env updates in
 * gitignored local files (not eas.json).
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const relayDir = path.join(rootDir, "services", "relay");
export const mobileDir = path.join(rootDir, "apps", "mobile");
export const webDir = path.join(rootDir, "apps", "web");

export const mobileEnvFile = path.join(mobileDir, ".env");
export const mobileEnvLocalFile = path.join(mobileDir, ".env.local");
export const mobileEnvExample = path.join(mobileDir, ".env.example");

export const webEnvLocalFile = path.join(webDir, ".env.local");
export const webEnvExample = path.join(webDir, ".env.example");

export const relayDevVarsFile = path.join(relayDir, ".dev.vars");
export const relayDevVarsExample = path.join(relayDir, ".env.example");

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Relay (API) and the Expo development server the development build loads from. */
export const tunnels = {
  relay: {
    name: "relay",
    port: 8787,
    urlFile: path.join(rootDir, ".tunnel.url"),
    pidFile: path.join(rootDir, ".tunnel.pid"),
    localUrl: "http://127.0.0.1:8787",
  },
  devServer: {
    name: "development server",
    port: 8081,
    urlFile: path.join(rootDir, ".tunnel.dev-server.url"),
    pidFile: path.join(rootDir, ".tunnel.dev-server.pid"),
    localUrl: "http://127.0.0.1:8081",
  },
};

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

export function getMobileEnv() {
  return { ...parseEnv(mobileEnvFile), ...parseEnv(mobileEnvLocalFile) };
}

export function getWebEnv() {
  return parseEnv(webEnvLocalFile);
}

export function updateEnv(filePath, updates, examplePath) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf-8");
  } else if (examplePath && fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, "utf-8");
  }

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null) continue;
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content = content.trimEnd() + `\n${key}=${val}\n`;
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

function readPidFile(pidFile) {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  return raw ? Number(raw) : null;
}

function pgrepCloudflared(port) {
  try {
    const pgrep = execSync(`pgrep -f 'cloudflared.*${port}'`, { encoding: "utf-8" }).trim();
    if (!pgrep) return null;
    return Number(pgrep.split("\n")[0]);
  } catch {
    return null;
  }
}

function unlinkQuiet(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export async function checkRunningTunnel(spec) {
  const existingUrl = fs.existsSync(spec.urlFile) ? fs.readFileSync(spec.urlFile, "utf-8").trim() : null;
  const existingPid = readPidFile(spec.pidFile);
  const pgrepPid = pgrepCloudflared(spec.port);
  const pid = existingPid || pgrepPid;

  if (pid && isProcessAlive(pid) && existingUrl && existingUrl.startsWith("http")) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(existingUrl, { signal: controller.signal });
      clearTimeout(timer);
      // Status < 530 means the Cloudflare edge is forwarding to the local tunnel agent.
      if (res.status < 530) return { url: existingUrl, pid };
    } catch {
      // network / DNS timeout
    }
  }

  for (const stale of [pgrepPid, existingPid]) {
    if (stale && isProcessAlive(stale)) {
      try {
        process.kill(stale, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  unlinkQuiet(spec.pidFile);
  unlinkQuiet(spec.urlFile);
  return null;
}

export async function startOrReuseTunnel(spec, { verbose = true } = {}) {
  const existing = await checkRunningTunnel(spec);
  if (existing) {
    if (verbose) {
      console.log(`\x1b[32m[tunnel] ✔ Reusing active Cloudflare tunnel (${spec.name}): ${existing.url} (PID ${existing.pid})\x1b[0m`);
    }
    return existing.url;
  }

  try {
    execSync("which cloudflared", { stdio: "ignore" });
  } catch {
    console.error("\x1b[31m[tunnel] ✖ cloudflared is not installed or not in PATH.\x1b[0m");
    console.log("Install via: brew install cloudflared");
    process.exit(1);
  }

  if (verbose) {
    console.log(`\x1b[36m[tunnel]\x1b[0m Starting Cloudflare tunnel (${spec.name}) to ${spec.localUrl}...`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--url", spec.localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.unref();

    let resolved = false;
    let pending = "";
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error(`Timed out waiting for the ${spec.name} Cloudflare tunnel URL`));
    }, 45_000);

    function handleData(chunk) {
      pending = (pending + chunk.toString()).slice(-8000);
      const match = pending.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const url = match[0];
        fs.writeFileSync(spec.urlFile, url, "utf-8");
        fs.writeFileSync(spec.pidFile, String(child.pid), "utf-8");
        if (verbose) {
          console.log(`\x1b[32m[tunnel] ✔ Cloudflare tunnel (${spec.name}) live at: ${url} (PID ${child.pid})\x1b[0m`);
        }
        resolve(url);
      }
    }

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);
    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared (${spec.name}) exited early with code ${code}`));
      }
    });
  });
}

function mergeCommaList(current, extras) {
  const items = (current || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const extra of extras) {
    if (extra && !items.includes(extra)) items.push(extra);
  }
  return items.join(",");
}

/**
 * Point local clients and the relay at the active tunnel URLs.
 * Writes gitignored `.env.local` / `.dev.vars` files. eas.json stays on its stable profile URLs.
 */
export function updateAllConfigs({ relayUrl, devServerUrl }) {
  const mobileEnv = getMobileEnv();
  const relayVars = parseEnv(relayDevVarsFile);
  const webOrigin = mobileEnv.EXPO_PUBLIC_WEB_ORIGIN || "https://sealed.to";

  updateEnv(
    mobileEnvLocalFile,
    {
      EXPO_PUBLIC_RELAY_URL: relayUrl,
      EXPO_PUBLIC_WEB_ORIGIN: webOrigin,
    },
    fs.existsSync(mobileEnvFile) ? mobileEnvFile : mobileEnvExample,
  );

  updateEnv(
    webEnvLocalFile,
    {
      VITE_RELAY_URL: relayUrl,
    },
    webEnvExample,
  );

  const allowedOrigins = mergeCommaList(relayVars.ALLOWED_ORIGINS, [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    relayUrl,
  ]);
  updateEnv(
    relayDevVarsFile,
    {
      PUBLIC_URL: relayUrl,
      ALLOWED_ORIGINS: allowedOrigins,
    },
    relayDevVarsExample,
  );

  fs.writeFileSync(tunnels.relay.urlFile, relayUrl, "utf-8");
  if (devServerUrl) fs.writeFileSync(tunnels.devServer.urlFile, devServerUrl, "utf-8");
}

export function applyLocalDatabaseMigrations() {
  try {
    execFileSync("pnpm", ["exec", "--", "wrangler", "d1", "migrations", "apply", "sealed-meta-dev", "--local", "--env", "dev"], {
      cwd: relayDir,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
  } catch (err) {
    console.warn("\x1b[33m[dev-env] ⚠ Local D1 migration warning:\x1b[0m", err.message || String(err));
  }
}

export async function waitForServer(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function isRelayListening() {
  try {
    const res = await fetch("http://127.0.0.1:8787/v1/health");
    return res.ok;
  } catch {
    return false;
  }
}

export async function isWebListening() {
  try {
    const res = await fetch("http://127.0.0.1:5173");
    return res.status < 500;
  } catch {
    return false;
  }
}

export function stopTunnels() {
  for (const spec of Object.values(tunnels)) {
    const pid = readPidFile(spec.pidFile);
    if (pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    try {
      execSync(`pkill -f 'cloudflared.*${spec.port}'`, { stdio: "ignore" });
    } catch {
      /* none running */
    }
    unlinkQuiet(spec.pidFile);
    unlinkQuiet(spec.urlFile);
  }
}

export function printAddressReport({
  title = "SEALED DEVELOPMENT SERVERS",
  relayTunnelUrl,
  devServerTunnelUrl,
  mobileRelayUrl,
  webRelayUrl,
  localRelayUrl = "http://127.0.0.1:8787",
  mobileDevUrl = "http://localhost:8081",
  webDevUrl = "http://localhost:5173",
}) {
  const reset = "\x1b[0m";
  const cyan = "\x1b[36m";
  const green = "\x1b[32m";
  const bold = "\x1b[1m";
  const yellow = "\x1b[33m";

  const rows = [
    ["Relay tunnel", relayTunnelUrl || "(pending)", green],
    ["Dev server tunnel", devServerTunnelUrl || "(pending)", green],
    ["Configured mobile relay", mobileRelayUrl || relayTunnelUrl || "(not set)", green],
    ["Configured web relay", webRelayUrl || relayTunnelUrl || "(not set)", green],
    ["Local relay", localRelayUrl, yellow],
    ["Mobile dev client", mobileDevUrl, yellow],
    ["Web dev server", webDevUrl, yellow],
  ];

  const labelWidth = 24;
  const valueWidth = Math.max(49, ...rows.map(([, value]) => value.length));
  const rowInner = 1 + labelWidth + valueWidth;
  const rule = "═".repeat(rowInner);
  const titleText = title.length > rowInner ? title.slice(0, rowInner) : title;
  const titlePad = rowInner - titleText.length;
  const leftPad = Math.floor(titlePad / 2);
  const rightPad = titlePad - leftPad;

  const line = (label, value, color) => {
    const shown = value.length > valueWidth ? value.slice(0, valueWidth) : value.padEnd(valueWidth);
    return `${cyan}║ ${bold}${label.padEnd(labelWidth)}${reset}${color}${shown}${cyan}║${reset}`;
  };

  const lines = [
    `${bold}${cyan}╔${rule}╗${reset}`,
    `${bold}${cyan}║${" ".repeat(leftPad)}${titleText}${" ".repeat(rightPad)}║${reset}`,
    `${bold}${cyan}╠${rule}╣${reset}`,
    ...rows.map(([label, value, color]) => line(label, value, color)),
    `${bold}${cyan}╚${rule}╝${reset}`,
  ];
  console.log("\n" + lines.join("\n") + "\n");
}
