import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("./src/shared", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  test: {
    testTimeout: 15000,
    projects: [
      { extends: true, test: { name: "server", environment: "node", include: ["tests/server/**/*.test.ts"] } },
      { extends: true, test: { name: "web", environment: "jsdom", include: ["tests/web/**/*.test.{ts,tsx}"] } },
    ],
  },
});
