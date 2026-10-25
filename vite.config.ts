import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./web", import.meta.url));
const shared = fileURLToPath(new URL("./src/shared", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
  },
});
