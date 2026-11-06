import { describe, expect, it } from "vitest";
import { eligibleRun, ManifestSchema } from "../src/runner-updates.ts";
import { Miniflare } from "miniflare";
import { realpathSync } from "node:fs";

describe("runner update publication authority", () => {
  const commit = "a".repeat(40);
  const run = { repository: { full_name: "state-vector/bridge" }, head_sha: commit, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/ci.yml" };
  it("requires the exact repository, source SHA, branch, workflow and successful completion", () => {
    expect(eligibleRun(run, commit, "ci.yml")).toBe(true);
    for (const delta of [{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" }, { conclusion: "failure" }, { status: "in_progress" }, { path: ".github/workflows/fake.yml" }, { repository: { full_name: "attacker/bridge" } }]) {
      expect(eligibleRun({ ...run, ...delta }, commit, "ci.yml")).toBe(false);
    }
  });
  it("stable promotion requires the separate versioned release gate", () => {
    const release = { ...run, path: ".github/workflows/release.yml", head_branch: "v0.2.0" };
    expect(eligibleRun(release, commit, "release.yml", true)).toBe(true);
    expect(eligibleRun({ ...release, head_branch: "main" }, commit, "release.yml", true)).toBe(false);
  });
  it("rejects manifests without a full commit and SHA256 artifact digests", () => {
    expect(ManifestSchema.safeParse({ schema_version: 1, commit: "a", artifacts: {} }).success).toBe(false);
    expect(ManifestSchema.safeParse({ schema_version: 1, commit, artifacts: { linux: { url: "https://example.com", sha256: "bad" } } }).success).toBe(false);
  });
});

describe("real update-channel durable object", () => {
  it("publishes only verified builds, persists the manifest and rejects replay/downgrade", async () => {
    const sha = "a".repeat(40);
    const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);
    const mf = new Miniflare({ port: 0, workers: [{ name: "updates", scriptPath: bundle, modules: true,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), compatibilityDate: "2025-09-06",
      durableObjects: { RUNNER_UPDATES: { className: "RunnerUpdates", useSQLite: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.hostname === "api.github.com") {
          if (request.headers.get("authorization") !== "Bearer short-lived-job-token") return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
          const ci = url.pathname.endsWith("/10");
          return Response.json({ repository: { full_name: "state-vector/bridge" }, head_sha: sha, head_branch: "main", event: "push",
            status: "completed", conclusion: "success", path: `.github/workflows/${ci ? "ci.yml" : "dev-build.yml"}` });
        }
        if (request.headers.has("authorization")) return new Response("credential leaked outside API", { status: 500 });
        return Response.json({ schema_version: 1, commit: sha, artifacts: { "aarch64-unknown-linux-gnu": {
          url: `https://github.com/state-vector/bridge/releases/download/runner-${sha}/bridge-aarch64-unknown-linux-gnu.tar.gz`, sha256: "b".repeat(64) } } });
      },
    }] });
    try {
      const ns = await mf.getDurableObjectNamespace("RUNNER_UPDATES");
      const stub = ns.get(ns.idFromName("channels")) as unknown as { fetch(input: string, init?: RequestInit): Promise<Response> };
      const publish = (ci_run: number) => stub.fetch("https://updates/publish", { method: "POST", headers: { authorization: "Bearer short-lived-job-token" }, body: JSON.stringify({ channel: "main", commit: sha, ci_run, build_run: 11 }) });
      expect((await stub.fetch("https://updates/manifest?channel=main")).status).toBe(404);
      const result = await publish(10);
      expect(result.status, await result.text()).toBe(200);
      const manifest = await (await stub.fetch("https://updates/manifest?channel=main")).json();
      expect(manifest).toMatchObject({ channel: "main", commit: sha, ci_run: 10 });
      expect(JSON.stringify(manifest)).not.toContain("job-token");
      const replay = await publish(9);
      expect(await replay.json()).toMatchObject({ unchanged: true });
      expect((await stub.fetch("https://updates/manifest?channel=unknown")).status).toBe(400);
      const controller = new AbortController();
      const events = await fetch(new URL("/api/runner-updates/events", await mf.ready), { signal: controller.signal });
      const reader = events.body!.getReader();
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain("runner.update.available");
      expect(frame).toContain(sha); // reconnect gets persisted state, not just a transient wake
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally { await mf.dispose(); }
  });
});
