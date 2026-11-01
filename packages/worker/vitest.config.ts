import { defineConfig } from "vitest/config";

/**
 * Vitest config (BR#5419): the real-bundled-worker test files load
 * `../../.kb-bundle/index.js`, previously regenerated only by `npm test`'s
 * script chain — a standalone `vitest run` read a stale bundle and failed 39
 * tests spuriously. globalSetup regenerates it before the suite.
 */
export default defineConfig({
  test: {
    globalSetup: ["./test/bundle-global-setup.ts"],
  },
});