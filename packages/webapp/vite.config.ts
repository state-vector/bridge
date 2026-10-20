import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@bridge/specs": path.resolve(import.meta.dirname, "../specs/src/index.ts"),
    },
  },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
