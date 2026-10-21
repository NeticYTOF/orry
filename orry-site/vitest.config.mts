/* Vitest: node environment, the "@/" alias from tsconfig.json, tests in test/. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.dirname(fileURLToPath(import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: { ORRY_FIXTURES: "1", ORRY_SITE_URL: "http://localhost:3200" }
  }
});
