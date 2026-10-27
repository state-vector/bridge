/**
 * Ambient type for the deploy-provenance stamp the [build] hook writes to
 * src/__version.json (gitignored — a build ARTIFACT, never committed). The
 * file exists at bundle/deploy time, not on a clean checkout, so tsc needs
 * this wildcard declaration to typecheck imports of it (evalProxyAtom's
 * "deployed" atom). Shape mirrors index.js's /__version route.
 */
declare module "*/__version.json" {
  const stamp: { commit?: string; built_at?: string | null };
  export default stamp;
}
