import { defineConfig } from "vitest/config";

// BR#6921 verify scratch config: run the ask-presentation suite without the
// wrangler bundle regen (this suite imports ui-kit sources directly and does
// not load .kb-bundle). DELETE BEFORE END OF RUN.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/ask-presentation.test.mjs"],
  },
});
