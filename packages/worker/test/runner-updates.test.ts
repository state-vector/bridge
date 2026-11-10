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
  const sha = "a".repeat(40);
  const sha2 = "b".repeat(40); // verified runs, but the release manifest is 503 (Retry-After: 12)
  const sha3 = "c".repeat(40); // verified runs, but the release manifest is 503 (Retry-After: 90000)
  const runs: Record<string, [string, string]> = {
    "10": [sha, "ci.yml"], "11": [sha, "dev-build.yml"],
    "20": [sha2, "ci.yml"], "21": [sha2, "dev-build.yml"],
    "30": [sha3, "ci.yml"], "31": [sha3, "dev-build.yml"],
  };
  const bundle = realpathSync(new URL("../../../.kb-bundle/index.js", import.meta.url).pathname);

  async function makeUpdates() {
    const mf = new Miniflare({ port: 0, workers: [{ name: "updates", scriptPath: bundle, modules: true,
      modulesRoot: bundle.slice(0, bundle.lastIndexOf("/")), compatibilityDate: "2025-09-06",
      durableObjects: { RUNNER_UPDATES: { className: "RunnerUpdates", useSQLite: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.hostname === "api.github.com") {
          if (request.headers.get("authorization") !== "Bearer short-lived-job-token") return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "45" } });
          const entry = runs[url.pathname.split("/").pop() ?? ""] ?? [sha, "dev-build.yml"];
          return Response.json({ repository: { full_name: "state-vector/bridge" }, head_sha: entry[0], head_branch: "main", event: "push",
            status: "completed", conclusion: "success", path: `.github/workflows/${entry[1]}` });
        }
        if (request.headers.has("authorization")) return new Response("credential leaked outside API", { status: 500 });
        if (url.pathname.endsWith(`/releases/download/runner-${sha2}/manifest.json`)) return new Response("manifest unavailable", { status: 503, headers: { "retry-after": "12" } });
        if (url.pathname.endsWith(`/releases/download/runner-${sha3}/manifest.json`)) return new Response("manifest unavailable", { status: 503, headers: { "retry-after": "90000" } });
        return Response.json({ schema_version: 1, commit: sha, artifacts: { "aarch64-unknown-linux-gnu": {
          url: `https://github.com/state-vector/bridge/releases/download/runner-${sha}/bridge-aarch64-unknown-linux-gnu.tar.gz`, sha256: "b".repeat(64) } } });
      },
    }] });
    const ns = await mf.getDurableObjectNamespace("RUNNER_UPDATES");
    const stub = ns.get(ns.idFromName("channels")) as unknown as { fetch(input: string, init?: RequestInit): Promise<Response> };
    return { mf, stub };
  }

  const publish = (stub: Awaited<ReturnType<typeof makeUpdates>>["stub"], commit: string, ci_run: number, build_run: number, extraHeaders: Record<string, string> = { authorization: "Bearer short-lived-job-token" }) =>
    stub.fetch("https://updates/publish", { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify({ channel: "main", commit, ci_run, build_run }) });

  it("exposes the bounded github_verification stage and provider timing when quota is exhausted", async () => {
    // The token-free canonical hint from the BR#9305 incident: GitHub 403 with
    // the quota exhausted must surface stage + retry timing, not a bare error.
    const { mf, stub } = await makeUpdates();
    try {
      const response = await publish(stub, sha, 10, 11, { authorization: "Bearer not-the-job-token" });
      expect(response.status, await response.clone().text()).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ stage: "github_verification", retry_after_secs: 45 });
      expect(String(body.error)).toContain("GitHub verification temporarily unavailable");
      expect(response.headers.get("retry-after")).toBe("45");
      // Authority preserved: a failed publication leaves no channel state.
      expect((await stub.fetch("https://updates/manifest?channel=main")).status).toBe(404);
    } finally { await mf.dispose(); }
  });

  it("exposes the manifest_fetch stage with the provider's retry timing", async () => {
    const { mf, stub } = await makeUpdates();
    try {
      const response = await publish(stub, sha2, 20, 21);
      expect(response.status).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ stage: "manifest_fetch", retry_after_secs: 12 });
      expect(response.headers.get("retry-after")).toBe("12");
      expect(String(body.error)).toContain("verified build manifest not available");
    } finally { await mf.dispose(); }
  });

  it("caps provider timing exposure at 3600 seconds", async () => {
    const { mf, stub } = await makeUpdates();
    try {
      const response = await publish(stub, sha3, 30, 31);
      expect(response.status).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(body.stage).toBe("manifest_fetch");
      expect(body.retry_after_secs).toBe(3600);
      expect(response.headers.get("retry-after")).toBe("3600");
    } finally { await mf.dispose(); }
  });

  it("keeps semantic rejections at 400 without any retry timing", async () => {
    const { mf, stub } = await makeUpdates();
    try {
      const response = await publish(stub, sha, 20, 21); // runs verify sha2, not the claimed commit
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(String(body.error)).toContain("unverified ci.yml build");
      expect(body.stage).toBeUndefined();
      expect(body.retry_after_secs).toBeUndefined();
      expect(response.headers.get("retry-after")).toBeNull();
    } finally { await mf.dispose(); }
  });

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
