import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * BR#4164 — the test rig's miniflare pin guard.
 *
 * Ten rig files (do, kb-throughput, closure-sweep, verdict-supersede,
 * kb-web-plane, stop-line, rotation, train-hub, provenance, models-route)
 * are written to the Miniflare-3 API and pin `miniflare@^3.20250718.3` as a
 * DIRECT devDependency (BR#2841 recipe: realpath + modulesRoot + useSQLite).
 *
 * The hazard: wrangler 4.151.2 (the lockfile regen 3126c2b10 pulled it in)
 * depends on miniflare 5.20261019.0-beta, which npm HOISTS to the root
 * node_modules. While the lockfile lacked the worker's nested entry
 * (2026-10-20..23 — repaired in passing by 51fb665), installs resolved the
 * rig's `import "miniflare"` to the hoisted 5.x-beta and every rig file died
 * with `MiniflareCoreError [ERR_VALIDATION]: Unexpected options passed to
 * `new Miniflare()` constructor`. Stale trees from that window are NOT
 * reliably repaired by `npm install` — only `npm ci` — and CI never sees it
 * (fresh `npm ci` every run), so the drift is invisible to CI-watching
 * (BR#3044's standing rule: local receipts beat CI-watching).
 *
 * This guard converts that failure mode from ten confusing ERR_VALIDATION
 * files into one loud, self-explaining red naming the repair.
 */

const workerRequire = createRequire(new URL("../package.json", import.meta.url).pathname);

function resolvedMiniflare(): { version: string; path: string } {
  const pkgPath = workerRequire.resolve("miniflare/package.json");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = workerRequire(pkgPath) as { version: string };
  return { version: pkg.version, path: pkgPath };
}

describe("BR#4164 — test rig resolves the pinned miniflare (3.x direct devDep)", () => {
  it("resolves miniflare 3.x — the API the rig is written against", () => {
    const { version, path } = resolvedMiniflare();
    const major = Number.parseInt(version.split(".")[0] ?? "NaN", 10);
    expect(
      major,
      `The worker test rig imports "miniflare" and pins ^3.20250718.3 as a direct ` +
        `devDependency (BR#2841 recipe — Miniflare-3 API), but resolution found ` +
        `${version} at ${path}. The hoisted wrangler miniflare (5.x) is shadowing the ` +
        `rig: every rig file will die with MiniflareCoreError [ERR_VALIDATION].\n` +
        `Your node_modules is stale (BR#4164: trees installed 2026-10-20..23 predate ` +
        `the nested-entry repair 51fb665; npm install does NOT reliably repair it).\n` +
        `REPAIR: npm ci at the repo root (fresh tree from the lockfile), then ` +
        `npm rebuild workerd in packages/worker if the workerd postinstall was ` +
        `blocked (BR#3044).`,
    ).toBe(3);
  });

  it("resolves INSIDE this checkout — not an ancestor checkout's node_modules", () => {
    const { path } = resolvedMiniflare();
    // npm resolves by walking up from the importing file. A git worktree
    // without its own install (this repo's .worktrees/ layout) silently
    // escapes to the PARENT checkout's node_modules — stale hoisted 5.x-beta
    // included — and the rig fails ten ways with no hint why (BR#4164).
    const repoRoot = new URL("../../", import.meta.url).pathname;
    expect(
      path.replaceAll("\\", "/"),
      `miniflare resolved OUTSIDE this checkout (${repoRoot}) — your worktree has ` +
        `no (or an incomplete) node_modules and npm escaped to an ancestor ` +
        `checkout's install. See the repair note in the 3.x assertion above (BR#4164).`,
    ).toContain(repoRoot.replaceAll("\\", "/"));
  });
});
