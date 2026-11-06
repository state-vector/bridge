import { z } from "zod";
const commit = z.string().regex(/^[0-9a-f]{40}$/);
export const RunnerManifestSchema = z.object({
  schema_version: z.literal(1), commit,
  artifacts: z.record(z.string(), z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
export const RunnerPublishSchema = z.object({ channel: z.enum(["main", "stable"]), commit,
  ci_run: z.number().int().positive(), build_run: z.number().int().positive(), release_run: z.number().int().positive().optional() });
export const RunnerGithubRunSchema = z.looseObject({ repository: z.object({ full_name: z.string() }), head_sha: z.string(),
  head_branch: z.string(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), path: z.string() });
export type RunnerGithubRun = z.infer<typeof RunnerGithubRunSchema>;
