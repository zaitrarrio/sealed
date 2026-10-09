/**
 * Metro for the pnpm monorepo (symlinks are followed by default). @sealed/core and @sealed/tokens are TypeScript sources linked from packages/*
 * through an `exports` map, and their own dependencies (@noble/*, fflate, jsqr, qrcode, zod) live in
 * packages/core/node_modules. Metro therefore has to: watch the workspace root, follow pnpm symlinks, honour
 * package `exports`, and keep hierarchical node_modules lookup enabled so packages resolve their own deps.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = false;
config.resolver.unstable_enablePackageExports = true;

// Keep other apps' build output, the relay's local state and native build folders out of the haste map.
const escape = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blocked = [
  path.join(workspaceRoot, "apps", "web"),
  path.join(workspaceRoot, "services"),
  path.join(workspaceRoot, "deploy"),
  path.join(projectRoot, "ios"),
  path.join(projectRoot, "android"),
  path.join(projectRoot, "dist"),
].map((p) => new RegExp(`^${escape(p)}([/\\\\].*)?$`));
const existing = config.resolver.blockList;
config.resolver.blockList = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), ...blocked, /[/\\]\.wrangler[/\\].*/];

module.exports = config;
