import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: "@bridge/ui-kit/tokens.css", replacement: path.resolve(import.meta.dirname, "../../ui-kit/src/tokens.css") },
      { find: "@bridge/ui-kit/ui-kit.css", replacement: path.resolve(import.meta.dirname, "../../ui-kit/src/ui-kit.css") },
      { find: "@bridge/ui-kit", replacement: path.resolve(import.meta.dirname, "../../ui-kit/src/index.ts") },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
