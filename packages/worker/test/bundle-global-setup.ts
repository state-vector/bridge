import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Real-bundled-worker tests (reconcile-hub, train-hub, br5370-reconcile-duties,
 * kb-web-plane, verdict-supersede, …) load `../../.kb-bundle/index.js` — the
 * worker bundled by `wrangler deploy --dry-run`. A stale or missing bundle
 * failed 39 tests as spurious "regressions" (BR#5419): only `npm test`
 * regenerated the bundle before vitest, so a standalone `vitest run` read the
 * last build, whatever it was.
 *
 * globalSetup regenerates the bundle before the suite, making a standalone
 * `vitest run` identical to `npm test`'s sequence. Degrades gracefully:
 * a failed regen (no wrangler in the environment) falls back to the existing
 * bundle with a loud warning; only a missing bundle AND a failed regen
 * aborts — the per-file guards keep their guidance message.
 */
const HERE = dirname(fileURLToPath(import.meta.url)); // packages/worker/test
const WRANGLER_TOML_CWD = resolve(HERE, ".."); // packages/worker — wrangler.toml lives here
const OUTDIR = resolve(HERE, "../../../.kb-bundle"); // repo/.kb-bundle — same target as npm test
const WRANGLER_BIN = resolve(HERE, "../../../node_modules/.bin/wrangler");

export default async function setup(): Promise<void> {
  const missingBefore = !existsSync(OUTDIR);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        WRANGLER_BIN,
        ["deploy", "--dry-run", "--outdir", "../../.kb-bundle"],
        { cwd: WRANGLER_TOML_CWD },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  } catch (err) {
    if (existsSync(OUTDIR)) {
      console.warn(
        `[bundle-global-setup] wrangler regen failed (${String((err as Error).message).slice(0, 200)}) — ` +
          `falling back to the EXISTING .kb-bundle, which may be stale. ` +
          `Run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle`,
      );
      return;
    }
    throw new Error(
      `bundle missing and regen failed (${String((err as Error).message).slice(0, 200)}) — ` +
        `run: npx wrangler deploy --dry-run --outdir ../../.kb-bundle (before vitest)`,
    );
  }
  if (missingBefore) console.warn("[bundle-global-setup] .kb-bundle was missing — regenerated it fresh");
}