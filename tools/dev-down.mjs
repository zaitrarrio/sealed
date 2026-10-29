#!/usr/bin/env node
import { stopTunnels } from "./dev-env-helpers.mjs";

console.log("\x1b[36m[stack]\x1b[0m Stopping Cloudflare tunnels...");
stopTunnels();
console.log("\x1b[32m[stack] ✔ Tunnels stopped and pid/url files removed\x1b[0m");
