import { getKbHubConfig } from "./config";

/** Knowledge-layer REST + realtime client.
 *  Auth: the human session cookie — browser (webapp) sends it same-origin via
 *  credentials:"include"; native shells route through the host process
 *  (setKbTransport → Tauri invoke → reqwest with the Cookie header).
 *  ZERO bearer on this plane: a gateway-class token stamps actor `gateway`,
 *  and human-authoritative acts (decision acceptance, role:human sign-off)
 *  are rejected by design — misconfigured UI paths fail loudly (ADR BR#2673). */

export interface KbArtefact {
  id: string;
  type: string;
  title: string;
  status: string;
  tags?: string[] | null;
  /** dispatch/gating lanes (review/unblock/analysis/…) — structural, never tags (BR#2983) */
  roles?: string[] | null;
  board?: string | null;
  owner?: string;
  body_md?: string;
  meta?: Record<string, unknown>;
  created_ts: number;
  updated_ts: number;
  status_ts?: number;
  /** hub-stamped canonical permalink (/card/BR-NNNN on CANONICAL_ORIGIN,
   *  BR#3990 stamper + BR#4695 canonical emission) — present on rows served
   *  by the worker's MCP/API boundary, absent on locally-projected rows. */
  url?: string;
  /** parent task id, projected by board() from child_of relations */
  part_of?: string;
  /** proposed decisions only — the open feedback round + agent consensus tally (BR#903) */
  consensus?: KbConsensus;
  /** BR#3942 — addressee presence for ask rows (question nodes only):
   *  projected by board() so the human planes can show
   *  "asked to X (offline, N min ago)" with no extra permission. */
  ask_target?: { online: boolean; last_seen_ts: number | null; source: "token" | "gateway" | "unknown" };
}

/** Consensus round of a proposed decision: contributions are log_progress notes on the round task. */
export interface KbConsensus {
  round_id: string;
  round_title: string;
  round_status: string;
  round_ts: number;
  contributions: number;
  agree: number;
  disagree: number;
  other: number;
  contributors: string[];
}

export interface KbEvent {
  seq: number;
  ts: number;
  actor: string;
  op: string;
  artefact_id: string | null;
  detail: Record<string, unknown>;
}

export interface KbSession {
  token_id: string;
  label: string | null;
  name: string;
  first_seen_ts: number;
  last_seen_ts: number;
}

export interface KbAuthToken {
  id: string;
  label: string;
  tags: string[];
  transport?: string;
  created_ts: number;
  last_seen_ts?: number | null;
  revoked_ts?: number | null;
}

/** gateway → dispatched-agent attribution edge (Connect grouping, BR#2455) */
export interface KbGatewayAgentEdge {
  gateway: string;
  agent: string;
  last_seen_ts: number;
}

export interface KbProgress {
  seq: number;
  ts: number;
  actor: string;
  artefact_id: string;
  detail: { note?: string; sentiment?: string };
}

/** One point of a task's self-reported gauge series (from version history). */
export interface KbSeriesPoint {
  artefact_id: string;
  ts: number;
  actor: string;
  note?: string;
  sentiment?: string;
  completion_pct?: number;
  confidence_pct?: number;
  risk_pct?: number;
  context_pct?: number;
}

/** Task-done throughput (BR#2937): done transitions per bucket + cumulative. */
export interface KbThroughput {
  bucket: string;
  range_days: number;
  from_ts: number;
  to_ts: number;
  total: number;
  buckets: Array<{ t: number; n: number; cumulative: number }>;
}

/** Reports view (BR#5126): tasks-done + PR merge throughput, one shared grid. */
export interface KbReportBucket {
  /** bucket start, epoch ms */
  t: number;
  /** events in this bucket */
  n: number;
  /** cumulative within the range */
  cumulative: number;
  /** PR series only: gate bounces in this bucket */
  bounced?: number;
}

export interface KbReports {
  bucket: string;
  range_days: number;
  from_ts: number;
  to_ts: number;
  tasks: { total: number; buckets: KbReportBucket[] };
  prs: { total: number; bounced_total: number; buckets: KbReportBucket[] };
}

/** One entry of an artefact's version history: every mutation, who/when/what. */
export interface KbVersion {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  summary: string;
  data: Record<string, unknown>;
}

/** An open ask (agent → human decision request) that may be blocking a task. */
export interface KbAsk {
  id: string;
  /** human handle: ASK-<subject>-<ordinal> ("ASK-BR-2466-2") */
  display?: string;
  to: string;
  question: string;
  options: string[];
  urgency: string;
  status: string;
  artefact_id?: string;
  answer?: string;
  answered_by?: string;
  answered_ts?: number;
  created_ts: number;
}

export interface KbBoard {
  tasks: KbArtefact[];
  sessions: KbSession[];
  progress: KbProgress[];
  series: KbSeriesPoint[];
  agents?: Array<{ label: string; score: number; grade: string; hints: string[] } & Record<string, number | string>>;
}

/** One merge-train lane of the train.status snapshot (GET /api/kb/train):
 *  executor-fed CAS lease + in-flight phase, hub-computed derived queue. */
export interface KbTrainLease {
  holder: string;
  heartbeat_ts: number;
  expires_ts: number;
}

export interface KbTrainLane {
  lane: string;
  card: string;
  lease: KbTrainLease | null;
  currently: { phase?: string; merge_sha?: string; pr?: number; head_sha?: string; merged_at?: number; task_id?: string; burst_merged?: number; burst_cap?: number } | null;
  stop: { sha?: string; reason?: string; at?: number; pr?: number; culprit_task?: string } | null;
  /** BR#4981: a gate-bounced head blocked on branch protection (review /
   *  required checks) — cleared by the typed self-clear when the PR lands. */
  bypass_wait?: { pr: number; task_id?: string; at: number } | null;
  required_workflows?: string[];
  reason?: string;
  /** BR#4977 lane lifecycle: true when the lane's card is done/superseded
   *  (base deleted or lane retired) — the tick never touches it; queue is
   *  always empty and the reason names the retirement. */
  retired?: boolean;
  last_capable_lease_ts?: number | null;
  /** last merge-capable gateway tick — the machine the train will hand to
   *  (Ray 2026-10-29): ready=true inside the 15-min window, so an idle lane
   *  still names WHO is driving it and that merges will start when work lands. */
  capable?: { holder: string; at: number; age_ms: number; ready: boolean } | null;
  now_action?: { note: string; holder: string; at: number } | null;
  /** BR#5114 round 2 (Ray: "remove jargon — make it clear"): the current
   *  attempt in plain words — which card the train is on and WHY it is or
   *  isn't moving. hold: "awaiting-review" = the PR branch changed after
   *  its last review (a fresh review unblocks it); "merge-checks" = review,
   *  signatures and CI being checked before the merge. */
  attempt?: { card: string; hold: "awaiting-review" | "merge-checks"; note: string } | null;
  /** how many queued cards are waiting on a fresh review (the honest
   *  explanation behind a "0/h" rate with a full queue). */
  queue_awaiting_review?: number;
  queue: { id: string; priority: "critical" | "normal"; pr?: number }[];
  /** cards parked Awaiting review on this lane's unlanded legs, OLDEST FIRST
   *  (BR#4962, per accepted BR#4960 — the ask-era review_asks chips are
   *  gone: zero asks ride the lanes): one chip per parked card — amber
   *  (aging) at the awaiting TTL, red (lapsed) past TTL + grace; a lapsed
   *  park still lists (visibility without interruption). Force-review from
   *  the backlog acts on them; the TTL stays hub-side (train.awaiting_ttl_h). */
  awaiting?: { task: string; pr?: number; at: number; head_sha: string | null; verdict: string | null; age_ms: number; aging: boolean; lapsed: boolean }[];
  /** executor activity (hub-computed over the train_events ledger) */
  activity?: {
    merged_1h: number;
    merged_24h: number;
    last_merge_ts: number | null;
    last_event: { ts: number; kind: string; pr?: number; task_id?: string; gateway?: string } | null;
  };
}

const base = () => getKbHubConfig().url;

/** Thrown when auth fails (missing/expired cookie or bad token) — the shell funnels these into its sign-in gate. */
export class KbAuthError extends Error {}

/** Shell transport hook: native shells replace the webview fetch entirely —
 *  cross-origin fetches can neither carry the HttpOnly session cookie
 *  (SameSite=Lax) nor pass CORS reliably, so the desktop routes KB calls
 *  through its Rust host which attaches the Cookie header itself. Browser
 *  callers (webapp) keep plain same-origin fetch. */
export type KbTransport = (path: string, init?: { method?: string; body?: string }) => Promise<unknown>;
let transport: KbTransport | null = null;
export function setKbTransport(t: KbTransport | null) {
  transport = t;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  if (transport) {
    return (await transport(path, {
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })) as T;
  }
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const r = await fetch(`${base()}${path}`, { ...(init ?? {}), credentials: "include", headers });
  if (r.status === 401) throw new KbAuthError("unauthorized");
  if (!r.ok) throw new Error(`${r.status} ${await r.text().then((t) => t.slice(0, 200))}`);
  return (await r.json()) as T;
}

export const kbApi = {
  board: () => j<KbBoard>("/api/kb/board"),
  throughput: (q?: { bucket?: "hour" | "day" | "week"; range?: string }) => {
    const p = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return j<KbThroughput>(`/api/kb/metrics/throughput${p.size ? `?${p}` : ""}`);
  },
  // BR#5126 Reports view: tasks-done + PR merge series on one shared bucket grid
  reports: (q?: { bucket?: "hour" | "day" | "week"; range?: string }) => {
    const p = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return j<KbReports>(`/api/kb/metrics/reports${p.size ? `?${p}` : ""}`);
  },
  events: (since: number) => j<{ events: KbEvent[]; last_seq: number }>(`/api/kb/events?since=${since}&limit=200`),
  artefacts: (q?: { type?: string; status?: string; limit?: number }) => {
    const p = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return j<{ artefacts: KbArtefact[] }>(`/api/kb/artefacts${p.size ? `?${p}` : ""}`);
  },
  artefact: (id: string) => j<KbArtefact & { relations: { relation: string; artefact_id: string; dir: string }[] }>(`/api/kb/artefact?id=${encodeURIComponent(id)}`),
  ask: (id: string) => j<KbAsk>(`/api/kb/ask?id=${encodeURIComponent(id)}`),
  askAnswer: (id: string, answer: string) =>
    j<{ id: string; status: string; artefact_id?: string; task_status?: string }>("/api/kb/ask_answer", { method: "POST", body: JSON.stringify({ id, answer }) }),
  askReframe: (id: string, feedback?: string) =>
    j<{ id: string; reframe: { by: string; feedback: string; ts: number } }>("/api/kb/ask_reframe", { method: "POST", body: JSON.stringify({ id, feedback }) }),
  // BR#3911: human-claim hold on a question — claim ≠ answer; a 10-minute
  // "in hand" hold that dismisses the question from the agent pool and
  // auto-reopens on expiry. Server rejects gateway bearers (human plane only).
  questionClaim: (id: string, minutes?: number) =>
    j<{ id: string; human_claimed: { by: string; ts: number; expires_ts: number } }>("/api/kb/question_claim", { method: "POST", body: JSON.stringify({ id, ...(minutes ? { minutes } : {}) }) }),
  questionRelease: (id: string) =>
    j<{ id: string; released: boolean }>("/api/kb/question_release", { method: "POST", body: JSON.stringify({ id }) }),
  search: (q: string) => j<{ artefacts: any[] }>(`/api/kb/search?q=${encodeURIComponent(q)}`),
  related: (id: string) => j<{ artefacts: KbArtefact[] }>(`/api/kb/related?id=${encodeURIComponent(id)}`),
  history: (id: string) => j<{ artefact_id: string; versions: KbVersion[] }>(`/api/kb/history?id=${encodeURIComponent(id)}`),
  // merge-train snapshot (all lanes) — lease holders + derived queue for the Top panel
  train: () => j<{ lanes: KbTrainLane[] }>("/api/kb/train"),
  // human replies on a question thread — the same log_progress door agents use
  progress: (id: string, note: string, extra?: { will?: string; sentiment?: string }) =>
    j<{ ok: boolean }>("/api/kb/progress", { method: "POST", body: JSON.stringify({ id, note, ...extra }) }),
  progressGauges: (body: { id: string; note: string; sentiment?: string; completion_pct?: number; confidence_pct?: number; risk_pct?: number }) =>
    j<{ ok: boolean }>("/api/kb/progress", { method: "POST", body: JSON.stringify(body) }),
  create: (body: { type: string; title: string; body_md?: string; meta?: object; owner?: string; tags?: string[]; roles?: string[] }) =>
    j<{ id: string }>("/api/kb/create", { method: "POST", body: JSON.stringify(body) }),
  boost: (id: string, on = true) =>
    j<{ id: string; boosted: string[]; on: boolean }>("/api/kb/boost", { method: "POST", body: JSON.stringify({ id, boost: on }) }),
  transition: (id: string, to: string, extra?: { note?: string; unblock_condition?: string; sentiment?: string }) =>
    j<{ id: string; status: string }>(`/api/kb/transition`, { method: "POST", body: JSON.stringify({ id, to, ...extra }) }),
  // BR#3910: one-click human supersede — the server composes the two-step
  // (blocked → release → todo → superseded) and enforces the web-session-only
  // gate; replacement is optional but validated server-side when given.
  supersede: (id: string, replacement_id?: string, note?: string) =>
    j<{ id: string; status: string; replacement_id?: string }>(`/api/kb/supersede`, {
      method: "POST",
      body: JSON.stringify({ id, ...(replacement_id ? { replacement_id } : {}), ...(note ? { note } : {}) }),
    }),
  // BR#4962 (per accepted BR#4960): human force-review on an Awaiting park —
  // approve re-anchors the accepted verdict at the parked head and re-queues
  // the train; request_changes bounces impl. Web/human-only server-side
  // (bearers 403): the parked card in the backlog IS the human leg, no ask.
  forceReview: (id: string, decision: "approve" | "request_changes", note?: string) =>
    j<{ ok: boolean; id: string; decision: string }>(`/api/kb/force_review`, {
      method: "POST",
      body: JSON.stringify({ id, decision, ...(note ? { note } : {}) }),
    }),
  update: (id: string, patch: { title?: string; body_md?: string; meta?: object; tags?: string[]; roles?: string[] }) =>
    j<{ id: string }>("/api/kb/update", { method: "POST", body: JSON.stringify({ id, ...patch }) }),

  // admin (connect page) — cookie-session only; tokens are rejected by design
  tokens: () => j<{ tokens: KbAuthToken[]; sessions: KbSession[]; gateway_agents?: KbGatewayAgentEdge[] }>("/api/kb/admin/tokens"),
  mint: (label: string, tags: string[], transport?: string) =>
    j<{ id: string; label: string; tags: string[]; transport?: string; secret: string }>("/api/kb/admin/tokens", { method: "POST", body: JSON.stringify({ label, tags, transport }) }),
  revoke: (id: string) => j<{ id: string }>("/api/kb/admin/tokens/revoke", { method: "POST", body: JSON.stringify({ id }) }),
  updateTokenTags: (id: string, tags: string[]) =>
    j<{ id: string; label: string; tags: string[] }>("/api/kb/admin/tokens/tags", { method: "POST", body: JSON.stringify({ id, tags }) }),
  settings: () => j<{ settings: Record<string, any> }>("/api/kb/admin/settings"),
  saveSettings: (settings: Record<string, unknown>) =>
    j<{ settings: Record<string, any> }>("/api/kb/admin/settings", { method: "POST", body: JSON.stringify({ settings }) }),
};

/** Realtime KB events. Browser (webapp): WS authenticated by the human
 *  session cookie — ZERO tokens on this plane (credential-class ADR BR#2673;
 *  the ?token= leg is gateway-class only, agents poll REST instead). Native
  *  shells (desktop; transport set): cross-origin WS can neither carry the
  *  HttpOnly cookie nor pass CORS, so tail the events mirror through the
  *  shell transport instead — ADAPTIVELY (BR#4362: no fixed short poll):
  *  2s while events flow, backing off to 30s when idle, reset on activity.
  *  Browser shells get the real socket, which now carries state: kb.event
  *  frames per mutation plus coalesced kb.board snapshots. */
export function wsPushAvailable(): boolean {
  return !transport;
}
export function connectKbWs(
  onEvent: (e: KbEvent) => void,
  onBoard: (b: { tasks: any[]; sessions: any[]; progress?: any[]; series?: any[]; agents?: any[] }) => void,
  onStatus: (s: "open" | "closed") => void,
  sinceRef: () => number,
) {
  if (transport) {
    const viaTransport = transport;
    let since = 0;
    let open = false;
    let stopped = false;
    let backoff = 2000;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = (await viaTransport(`/api/kb/events?since=${since}&limit=200`)) as { events?: KbEvent[]; last_seq?: number };
        const got = (r.events ?? []).length > 0;
        for (const e of r.events ?? []) onEvent(e);
        if (typeof r.last_seq === "number") since = r.last_seq;
        if (!open) {
          open = true;
          onStatus("open");
        }
        // adaptive: busy → 2s; idle doubles up to 30s (activity resets)
        backoff = got ? 2000 : Math.min(backoff * 2, 30000);
      } catch {
        if (open) {
          open = false;
          onStatus("closed");
        }
        backoff = Math.min(backoff * 2, 30000);
      }
      if (!stopped) setTimeout(poll, backoff);
    };
    poll();
    return () => {
      stopped = true;
    };
  }
  let stopped = false;
  let backoff = 2000;
  let ws: WebSocket | null = null;
  const dial = () => {
    if (stopped) return;
    // since=lastSeq: reconnect catch-up replays exactly once (BR#4362)
    const url = base().replace(/^http/, "ws") + "/kb-ws?since=" + (sinceRef() || 0);
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 2000;
      onStatus("open");
    };
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        if (f.type === "kb.event") onEvent(f.event);
        else if (f.type === "kb.board") onBoard(f.board); // the socket carries state
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (stopped) return;
      onStatus("closed");
      setTimeout(dial, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => ws?.close();
  };
  dial();
  return () => {
    stopped = true;
    ws?.close();
  };
}
