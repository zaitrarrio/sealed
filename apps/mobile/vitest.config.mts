/**
 * Unit tests for the app's pure and storage logic, run in Node. Native and Expo modules are replaced by
 * in-memory stand-ins (test/mocks); screens and camera code are exercised on devices, not here.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const mock = (name: string) => fileURLToPath(new URL(`./test/mocks/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^expo-file-system$/, replacement: mock("expo-file-system") },
      { find: /^expo-secure-store$/, replacement: mock("expo-secure-store") },
      { find: /^expo-sharing$/, replacement: mock("expo-sharing") },
      { find: /^expo-device$/, replacement: mock("expo-device") },
      { find: /^expo$/, replacement: mock("expo") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
