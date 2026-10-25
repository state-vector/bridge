/** PR provenance (BR#3287): sha → PR → task → verify-verdict → agent session.
 *  Storage of record is the BOARD (ruling: decision BR#3291, accepted) —
 *  this module is the pure decision helpers; the DO owns the sweep, the
 *  provenance table, meta.provenance stamping, and the lookup endpoint.
 *  GitHub receives at most a derived, non-authoritative mirror. */

export interface ProvenanceRow {
  repo: string;
  pr: number;
  merge_sha: string;
  head_sha: string;
  task_id: string | null;
  verdict_id: string | null;
  session: string | null;
  signer: string;
  merged_at: number;
  stamped_at: number;
}

/** Extract the linked bridge card from the PR head branch, then the PR text.
 *  Branch naming is the authoritative join key (bridge/BR-<id>); body text is
 *  the fallback. Returns "BR#<n>" or null (no bridge provenance). */
export function prCardRef(branch: string | null | undefined, text: string | null | undefined): string | null {
  const br = /(?:^|[/\-_])BR-?(\d{1,6})(?:[/\-_]|$)/i.exec(branch ?? "");
  if (br) return `BR#${br[1]}`;
  const tx = /BR#(\d{1,6})/.exec(text ?? "");
  return tx ? `BR#${tx[1]}` : null;
}

/** Signer class from the PR's commit verifications. The worker class signs as
 *  detached-cody (BR#3181); rayh signs via 1Password; unsigned = the 5c
 *  violation class (should never merge, recorded honestly if it did). */
export function signerFromCommits(commits: { verified: boolean; committer_email?: string | null }[]): string {
  if (!commits.length) return "unknown";
  if (commits.some((c) => c.verified && /detached-cody|297316395\+/.test(c.committer_email ?? ""))) return "detached-cody";
  if (commits.every((c) => c.verified)) return "signed";
  if (commits.some((c) => c.verified)) return "partially-signed";
  return "unsigned";
}

/** Validate the ?sha= lookup param: 7-40 lowercase hex. Returns the sha or
 *  throws a user-facing message (the GET arm's catch turns it into a 400). */
export function parseProvenanceSha(sp: URLSearchParams): string {
  const sha = String(sp.get("sha") ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("provenance lookup needs ?sha=<7-40 hex chars>");
  return sha;
}

/** A merged PR is in the backfill window if merged_at is recent enough
 *  (default 30 days). Pure so the drill and the sweep agree on the window. */
export function withinBackfillWindow(mergedAtIso: string | null | undefined, now: number, backfillDays: number): number | null {
  if (!mergedAtIso) return null;
  const t = Date.parse(mergedAtIso);
  if (!Number.isFinite(t)) return null;
  if (t < now - backfillDays * 86_400_000) return null;
  return t;
}
