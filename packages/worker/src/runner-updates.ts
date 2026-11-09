import { RunnerManifestSchema as ManifestSchema, RunnerPublishSchema as PublishSchema, RunnerGithubRunSchema as GithubRunSchema, type RunnerGithubRun } from "@bridge/contracts";
import { boundedWakeStream } from "./kb/sse.ts";
export { ManifestSchema };
const repo = "state-vector/bridge";
type PublicationStage = "verify_ci" | "verify_build" | "verify_release" | "fetch_manifest" | "publication_rate" | "publish";

function integerHeader(value: string | null | undefined): number | undefined {
  return value && /^[0-9]{1,12}$/.test(value) ? Number(value) : undefined;
}

function retryAfterSeconds(value: string | null | undefined): number {
  const seconds = integerHeader(value);
  if (seconds !== undefined) return seconds;
  if (!value || !/^[A-Za-z]{3}, /.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 0;
}

class PublicationUnavailable extends Error {
  constructor(readonly stage: PublicationStage, readonly upstream?: Response) {
    super("publication temporarily unavailable");
  }

  reply(status = 503, localDelay = 0): Response {
    const headers = this.upstream?.headers;
    const rateResetAt = headers?.get("x-ratelimit-remaining") === "0"
      ? integerHeader(headers.get("x-ratelimit-reset")) : undefined;
    const delay = Math.max(localDelay, retryAfterSeconds(headers?.get("retry-after")),
      rateResetAt ? Math.ceil(rateResetAt - Date.now() / 1000) : 0);
    return Response.json({
      error: this.message, stage: this.stage, upstream_status: this.upstream?.status, rate_reset_at: rateResetAt,
    }, { status, headers: delay > 0 ? { "retry-after": String(delay) } : undefined });
  }
}

function transportUnavailable(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}

async function publicationFetch(stage: PublicationStage, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (transportUnavailable(error)) throw new PublicationUnavailable(stage);
    throw error;
  }
}

/** Public build metadata only. Publication accepts hints, never caller-supplied
 * manifests or URLs. GitHub independently proves every gate and source SHA. */
export class RunnerUpdates {
  private clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private enc = new TextEncoder();
  private lastProbe = 0;
  constructor(private state: DurableObjectState, private env: { GITHUB_TOKEN?: string }) {}

  private async github(stage: PublicationStage, path: string, jobToken?: string): Promise<RunnerGithubRun> {
    // The publisher's job-scoped read-only token raises API quota without a
    // long-lived hub secret. Never persist, log, or forward it anywhere except
    // this fixed GitHub repository API. The supplied facts still prove nothing:
    // every run/commit/workflow is independently checked below.
    const token = jobToken || this.env.GITHUB_TOKEN;
    const response = await publicationFetch(stage, `https://api.github.com/repos/${repo}/${path}`, { headers: {
      "user-agent": "bridge-runner-updates", accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const quotaLimited = response.status === 403
        && (response.headers.get("x-ratelimit-remaining") === "0" || retryAfterSeconds(response.headers.get("retry-after")) > 0);
      if (response.status >= 500 || response.status === 429 || quotaLimited) throw new PublicationUnavailable(stage, response);
      throw new Error(`GitHub verification ${response.status}`);
    }
    return GithubRunSchema.parse(await response.json());
  }

  private send(frame: string): void {
    for (const writer of this.clients) writer.write(this.enc.encode(frame)).catch(() => { this.clients.delete(writer); void writer.close().catch(() => {}); });
  }

  async alarm(): Promise<void> {
    this.send(": keepalive\n\n");
    if (this.clients.size) await this.state.storage.setAlarm(Date.now() + 30000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events") && request.method === "GET") {
      if (this.clients.size >= 64) return new Response("subscriber capacity reached", { status: 503 });
      let initial = "retry: 10000\n\ndata: {\"type\":\"runner.update.hello\"}\n\n";
      // Every connection receives persisted revisions. A missed wake never
      // requires polling the manifest on every bounded-stream reconnect.
      for (const channel of ["main", "stable"]) {
        const manifest = await this.state.storage.get<{ commit: string }>(`channel:${channel}`);
        if (manifest) initial += `data: ${JSON.stringify({ type: "runner.update.available", channel, commit: manifest.commit })}\n\n`;
      }
      await this.state.storage.setAlarm(Date.now() + 30000);
      return boundedWakeStream(request, this.clients, initial);
    }
    if (url.pathname.endsWith("/manifest") && request.method === "GET") {
      const channel = url.searchParams.get("channel");
      if (channel !== "main" && channel !== "stable") return new Response("invalid channel", { status: 400 });
      const manifest = await this.state.storage.get(`channel:${channel}`);
      return manifest ? Response.json(manifest, { headers: { "cache-control": "no-store" } }) : new Response("no verified build published yet", { status: 404 });
    }
    if (!url.pathname.endsWith("/publish") || request.method !== "POST") return new Response("not found", { status: 404 });
    if (Number(request.headers.get("content-length")) > 2048) return new Response("too large", { status: 413 });
    try {
      const body = await request.text();
      if (body.length > 2048) return new Response("too large", { status: 413 });
      const input = PublishSchema.parse(JSON.parse(body));
      const jobToken = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const current = await this.state.storage.get<{ ci_run: number; release_run?: number }>(`channel:${input.channel}`);
      if (current && (input.channel === "main" ? current.ci_run >= input.ci_run : (current.release_run ?? 0) >= (input.release_run ?? 0))) return Response.json({ unchanged: true });
      const now = Date.now();
      const validationDelay = 10000 - (now - this.lastProbe);
      if (validationDelay > 0) return new PublicationUnavailable("publication_rate").reply(429, Math.ceil(validationDelay / 1000));
      this.lastProbe = now;
      for (const [id, path, stage] of [[input.ci_run, "ci.yml", "verify_ci"], [input.build_run, "dev-build.yml", "verify_build"]] as const) {
        const run = await this.github(stage, `actions/runs/${id}`, jobToken);
        if (!eligibleRun(run, input.commit, path)) throw new Error(`unverified ${path} build`);
      }
      if (input.channel === "stable") {
        if (!input.release_run) throw new Error("stable requires a successful versioned release run");
        const release = await this.github("verify_release", `actions/runs/${input.release_run}`, jobToken);
        if (!eligibleRun(release, input.commit, "release.yml", true)) throw new Error("unverified stable release");
      }
      const download = `https://github.com/${repo}/releases/download/runner-${input.commit}/manifest.json`;
      const response = await publicationFetch("fetch_manifest", download, { headers: { "user-agent": "bridge-runner-updates" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new PublicationUnavailable("fetch_manifest", response);
      const manifest = ManifestSchema.parse(await response.json());
      if (manifest.commit !== input.commit) throw new Error("manifest commit mismatch");
      for (const [target, artifact] of Object.entries(manifest.artifacts)) {
        if (!/^(aarch64|x86_64)-(unknown-linux-gnu|apple-darwin)$/.test(target) || artifact.url !== `https://github.com/${repo}/releases/download/runner-${input.commit}/bridge-${target}.tar.gz`) throw new Error("artifact source mismatch");
      }
      // CAS under the DO transaction: two verified publications may overlap I/O.
      await this.state.storage.transaction(async tx => {
        const latest = await tx.get<{ ci_run: number; release_run?: number }>(`channel:${input.channel}`);
        const rank = (value: { ci_run: number; release_run?: number }) => input.channel === "main" ? value.ci_run : value.release_run ?? 0;
        if (!latest || rank(input) > rank(latest)) await tx.put(`channel:${input.channel}`, { ...manifest, ...input, published_at: Date.now() });
      });
      this.send(`data: ${JSON.stringify({ type: "runner.update.available", channel: input.channel, commit: input.commit })}\n\n`);
      return Response.json({ published: input.channel, commit: input.commit });
    } catch (error) {
      if (error instanceof PublicationUnavailable) return error.reply();
      if (transportUnavailable(error)) return new PublicationUnavailable("publish").reply();
      return Response.json({ error: String(error) }, { status: 400 });
    }
  }
}

export function eligibleRun(run: { conclusion?: string | null; status?: string; path?: string; event?: string; head_sha?: string; head_branch?: string; repository?: { full_name?: string } }, commit: string, path: string, release = false): boolean {
  return run.repository?.full_name === repo && run.head_sha === commit && run.status === "completed" && run.conclusion === "success"
    && run.path === `.github/workflows/${path}` && run.event === "push"
    && (release ? /^v\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(run.head_branch ?? "") : run.head_branch === "main");
}
