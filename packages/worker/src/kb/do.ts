/**
 * KnowledgeHub Durable Object — the coordination layer's storage + rules.
 *
 * One DO per project ("global" for now). SQLite: artefacts, typed relations,
 * audit events, FTS5 over title+body. Every mutation writes an audit event and
 * bumps updated_ts. Lifecycle transitions and relation rules are enforced HERE,
 * not in clients.
 *
 * Transport: the worker forwards JSON op requests via fetch("https://kb/<op>").
 * Ops: create | get | list | search | update | transition | link | stats
 */
import {
  issueRef,
  scaffoldBody,
  EMBED_MODEL,
  TRIGRAM_DIM,
  cosine,
  trigramVec,
  embedText,
  hybridMerge,
  composeBootstrap,
  scoreAgent,
  AgentSignals,
  TRANSPORTS,
  ARTEFACT_TYPES,
  ArtefactType,
  DEFAULT_BOARD,
  DEFAULT_CRON_PLAYBOOK,
  DEFAULT_ROLE_PLAYBOOKS,
  DEFAULT_WS_SLUG,
  doWs,
  INITIAL_STATUS,
  verifyVerdictStatement,
  LIMITS,
  SETTINGS_KEYS,
  ASK_ANSWERED,
  ASK_OPEN,
  checkLimits,
  ftsQuery,
  formatId,
  generateAuthToken,
  hashAuthToken,
  idSeq,
  isArtefactType,
  isRelation,
  isSentiment,
  isQuestionTask,
  KIND_TYPE,
  KIND_ROLE,
  KIND_TAG,
  parseRolesInput,
  splitSystemTags,
  isWsSlug,
  isValidAskTarget,
  tagsSayGateway,
  parseTags,
  resolveRolePlaybook,
  selfProvisionLabel,
  sanitizeTags,
  stopLineAskTitle,
  classifyMainCheckRuns,
  classifyHeadChecks,
  decideMergeAction,
  decidePrDisposition,
  mergeSweepHumanLegTitle,
  validateRelation,
  type MainCheckVerdict,
  type PrDisposition,
} from "./core.ts";
import { aggregateThroughput, parseThroughputParams } from "./throughput.ts";
import { parseProvenanceSha, prCardRef, signerFromCommits, withinBackfillWindow } from "./provenance.ts";
import {
  decide,
  invariants as checkInvariants,
  detectBreaches,
  replayStatus,
  BREACH_WINDOW_MS,
  UNBLOCK_FLOOD_MS,
  RuleCtx,
} from "./machine.ts";
import {
  parseProxyCondition,
  parseCloseLegs,
  parseClosureReceipt,
  doneWhenSection,
  legLabel,
  RECEIPT_CONTRACT,
  type CloseLeg,
  type ProxyAtom,
} from "./closure.ts";

/** The standing ask sink for the destination-green stop-the-line sweep
 *  (BR#3008) — asks bind to it, so askCreate's identical-open-ask guard can
 *  dedupe per red episode. Override with the `stop_line_artefact_id` setting
 *  if the sink card is ever re-issued. */
const STOP_LINE_SINK_ID = "BR#3124";

import {
  ROOT_BLOCKER_TAG,
  planRootBlockers,
  rootBlockerBody,
  rootBlockerTitle,
} from "./rollup.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState, private env: any) {}

  /** ensureSchema runs once per isolate, not per request — its migration
   *  queries are full-table scans, and the free-tier DO row-read quota
   *  dies under per-request schema checks (2026-10-18 outage). */

  // ---------- realtime (hibernating websockets) ----------

  async handleWs(request: Request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
    const recent = await this.eventsSince(since, 100);
    pair[1].send(JSON.stringify({ type: "kb.events", events: recent.events }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, message: string) {
    try {
      const m = JSON.parse(message);
      if (m?.type === "ping") _ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore */ }
  }

  webSocketClose() {}

  private broadcastEvent(ev: unknown) {
    const frame = JSON.stringify({ type: "kb.event", event: ev });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch { /* hibernated client gone */ }
    }
  }

  // Watchdog: silence on in_progress means the agent is gone — unless the
  // silence was DECLARED (grace window, subprocess block). Block it as
  // abandoned; the same agent re-claims it by logging progress again.
  /** Alarm entry point — fail-soft AND self-healing. Two failure modes here:
   *  (1) a throwing alarm() loses its schedule (the runtime consumes it);
   *  (2) a POISONED schedule: next_alarm_ts stuck in the past — the runtime
   *  keeps "firing" it, but if the handler throws before re-arming (old class
   *  version, quota error, whatever), the alarm never moves forward and the
   *  sweep never runs (the Oct-19 dead-watchdog incident: next_alarm_ts stuck
   *  15h in the past, last_tick zero, 12-24h stale rows). So: re-arm FIRST to
   *  now+60s unconditionally (this jumps past any poisoned timestamp), then
   *  run the sweep inside a catch-all that logs. The alarm can never go
   *  silent, and can never stay stuck in the past. */
  async alarm() {
    await this.state.storage.setAlarm(Date.now() + 60_000);
    try {
      await this.alarmSweep();
    } catch (e) {
      try {
        this.audit("system:watchdog", "alarm_error", "watchdog", { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* even auditing failed — next tick retries */ }
    }
  }

  private async alarmSweep() {
    await this.ensureSchema();
    const now0 = Date.now();
    // (0) expire stale open asks. An open ask pauses the watchdog (rule 6) —
    // but an ask to an agent that never answers would pause its task FOREVER
    // (the 19h+ in_progress rows were this). TTL: 24h. Expiry clears the ask
    // and any awaiting_ask marker, so the sweep below judges the task on its
    // own silence.
    const askTtlMs = 24 * 60 * 60_000;
    for (const a of this.state.storage.sql.exec(
      `SELECT id, artefact_id, to_target, created_ts FROM asks WHERE status = 'open' AND created_ts < ?`,
      now0 - askTtlMs,
    ).toArray() as any[]) {
      this.state.storage.sql.exec(
        `UPDATE asks SET status = 'expired', answered_by = 'system:watchdog', answered_ts = ? WHERE id = ?`,
        now0, a.id,
      );
      if (a.artefact_id) {
        const t = this.one(`SELECT meta FROM artefacts WHERE id = ?`, a.artefact_id);
        if (t) {
          const m = JSON.parse(t.meta ?? "{}");
          if (m.awaiting_ask?.ask_id === a.id) {
            delete m.awaiting_ask;
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), a.artefact_id);
          }
        }
      }
      this.audit("system:watchdog", "ask_expired", String(a.id), {
        to: a.to_target ?? "", artefact: a.artefact_id ?? "",
        age_h: Math.round((now0 - Number(a.created_ts ?? 0)) / 3_600_000),
      });
    }
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
    const staleMs = staleMin * 60_000;
    const now = Date.now();
    const rows = this.state.storage.sql.exec(
      `SELECT id, status, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_progress'`,
    ).toArray();
    for (const r of rows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      if (meta.awaiting_ask) {
        // aging escalation: a task parked on a human answer must show its
        // age, or the wait is invisible and unbounded. Annotate hourly;
        // the release stays human-owned (an answered ask un-blocks it).
        try {
          let ask: { to_target?: string; created_ts: number } | undefined;
          const derived = this.one(
            `SELECT c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta FROM relations r
             JOIN artefacts c ON c.id = r.src_id
              WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
                AND c.type = 'question' ORDER BY c.created_ts DESC LIMIT 1`, r.id,
          );
          if (derived) {
            const nm = JSON.parse(derived.cmeta ?? "{}");
            ask = { to_target: nm.ask?.to, created_ts: derived.created_ts };
          } else if (/^BR#\d+$/.test(String(meta.awaiting_ask.ask_id))) {
            const node = this.one(`SELECT meta, created_ts, status FROM artefacts WHERE id = ? AND status IN ('todo','in_progress','blocked')`, meta.awaiting_ask.ask_id);
            if (node) {
              const nm = JSON.parse(node.meta ?? "{}");
              ask = { to_target: nm.ask?.to, created_ts: node.created_ts };
            }
          } else {
            const row = this.one(`SELECT to_target, created_ts FROM asks WHERE id = ? AND status = 'open'`, meta.awaiting_ask.ask_id);
            if (row) ask = { to_target: row.to_target, created_ts: row.created_ts };
          }
          if (ask) {
            const hours = Math.floor((now - ask.created_ts) / 3_600_000);
            if (meta.awaiting_ask.annotated_h !== hours) {
              meta.awaiting_ask.annotated_h = hours;
              const base = String(meta.blocked?.reason ?? "").replace(/^⏳ blocked \d+h — .*? · /, "");
              meta.blocked = { ...(meta.blocked ?? {}), reason: `⏳ blocked ${hours}h — awaiting ${ask.to_target ?? "human"} on ask ${meta.awaiting_ask.ask_id} · ${base}` };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
            }
          }
        } catch { /* annotation is best-effort */ }
        continue;
      }
      // (A) declared grace: the agent stated a silence window — honor it until it lapses
      if (typeof meta.grace_until === "number" && meta.grace_until > now) continue;
      // (A2) declared subprocess window: the task is still in_progress, just
      // quiet while a subprocess runs — watchdog paused until the budget lapses
      if (meta.subprocess && typeof meta.subprocess.deadline_ts === "number") {
        if (meta.subprocess.deadline_ts > now) continue;
        // lapsed: the declaration is a lie — fall through to abandoned below
      }
      const lastTs = Math.max(
        meta.last_progress?.ts ?? 0, r.status_ts ?? 0, r.updated_ts ?? 0,
        meta.session_alive_ts ?? 0, // runner vouches the session is alive (stdout/ACP movement) — quiet work is not dead work
      );
      if (now - lastTs <= staleMs) continue;
      const openAsk = this.one(
        `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id,
      );
      if (openAsk) continue;
      const will = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      const lapsedSub = meta.subprocess ? ` (declared subprocess window of ${meta.subprocess.budget_minutes ?? "?"}m lapsed)` : "";
      // STALLED, not blocked: silence means "we haven't heard from the agent"
      // — blocked is reserved for the agent's own explicit "I cannot continue
      // until X". Release straight to todo: the claim drops, the attempted tag
      // records the try, and the next orient reassigns it. No blocked
      // intermediate, no unblock-child spawn for silence.
      await this.transition({
        id: r.id, to: "todo",
        note: `stalled — no update for >${staleMin}m${lapsedSub}; released to the pool by watchdog${will}`,
      }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (A3) stale in_review: an impl owner parks in in_review awaiting a verify
    // verdict. If no verifier ever picks the verification round up, the park is
    // permanent — the watchdog used to sweep only in_progress, so in_review
    // rows accumulated indefinitely. Past the review-stale threshold with no
    // verify child actively running, bounce: in_review → in_progress (findings
    // note) → todo (released to the pool). The bounce supersedes the stale
    // verify round automatically.
    const rs = this.one(`SELECT value FROM settings WHERE key = 'review_stale_minutes'`);
    const reviewStaleMin = rs ? Math.max(30, Math.min(2880, parseInt(rs.value, 10) || 360)) : 360;
    const reviewRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_review'`,
    ).toArray();
    for (const r of reviewRows as any[]) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        if (meta.awaiting_ask) continue;
        const age = now - Math.max(r.status_ts ?? 0, r.updated_ts ?? 0);
        if (age <= reviewStaleMin * 60_000) continue;
        const openAsk = this.one(`SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id);
        if (openAsk) continue;
         const activeVerify = this.one(
           `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
            WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'in_progress'
              AND c.roles LIKE '%"review"%' LIMIT 1`, r.id,
         );
        if (activeVerify) continue; // a verifier is on it — give them time
        const hours = Math.round(age / 3_600_000);
        const findings = `watchdog: review stalled ${hours}h — no verifier picked up the verification round. No adverse findings; resolve whatever the last gate/review named and hand off again, or let the work re-enter the pool.`;
        await this.transition({ id: r.id, to: "in_progress", note: findings }, "system:watchdog");
        await this.transition({ id: r.id, to: "todo", note: "released to the pool after a stalled review round (watchdog)" }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (B) subprocess blocks (legacy shape: blocked + meta.blocked.class) are gone —
    // subprocess silence now lives on in_progress tasks (A2 above). Nothing to sweep here.
    // (B) subprocess blocks: watchdog paused while the declared budget runs;
    // past the budget the declaration is a lie — convert to abandoned.
    // (Legacy shape only — new subprocess silence lives on in_progress tasks.)
    const subRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray();
    for (const r of subRows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      const b = meta.blocked;
      if (b?.class !== "subprocess" || typeof b.deadline_ts !== "number") continue;
      if (b.deadline_ts > now) continue;
      const wasDoing = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      // legacy lapsed window: stalled, not blocked — straight to todo
      delete meta.blocked;
      delete meta.subprocess;
      const tags: string[] = parseTags(r.meta ? JSON.parse(r.meta).tags ?? "[]" : "[]");
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      meta.attempt = { by: r.owner || "unknown", at: now, attempts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, r.id,
      );
      this.audit("system:watchdog", "transition", r.id, { from: "blocked", to: "todo", note: `stalled — declared subprocess window (${b.budget_minutes ?? "?"}m) lapsed${wasDoing}` });
      this.version(r.id, "system:watchdog", "transition", `stalled — declared subprocess window lapsed, released to the pool`, { from: "blocked", to: "todo" });
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (C) verification nudge: an unclaimed verify task parks its parent's owner —
    // never reaped (you can't be "abandoned" from work you never picked up). Past
    // the threshold, nudge once per hour: audit line (Log + ws broadcast) for the
    // role:review agents and the waiting owner. The score signal does the rest.
    const nudgeRows = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, c.updated_ts AS age_ts, p.owner AS parent_owner
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'`,
    ).toArray() as any[];
    for (const v of nudgeRows) {
      const age = now - (v.age_ts ?? now);
      if (age <= 60 * 60_000) continue;
      const lastNudge = this.one(
        `SELECT ts FROM events WHERE artefact_id = ? AND op = 'nudge' ORDER BY ts DESC LIMIT 1`, v.verify_task,
      );
      if (lastNudge && now - Number(lastNudge.ts) <= 60 * 60_000) continue;
      const mins = Math.round(age / 60_000);
      this.audit("system:pool", "nudge", v.verify_task, {
        note: `verify task unclaimed ${mins}m — this blocks ${v.parent_id}'s owner (${v.parent_owner || "unknown"}). Pick it up: check receipts, close or bounce the parent.`,
        parent: v.parent_id, parent_owner: v.parent_owner ?? "", age_min: mins,
      });
    }
    // (B) standing merge-queue sweep (BR#3198): the deterministic executor of
    // the BR#3033 standing merge order — drains mergeable, verified, green
    // PRs every tick, FIRST, before anything else claims attention. Isolated:
    // a GitHub outage must never take the watchdog down with it.
    try {
      await this.mergeQueueSweep(now);
    } catch (e) {
      try {
        this.audit("system:merge-sweep", "sweep_error", null, { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* next tick retries */ }
    }

    // (C) destination-green stop-the-line (BR#3008): one sweep on a slow
    // cadence, failures isolated — an alarm-layer outage in GitHub's API must
    // never take the watchdog down with it.
    try {
      await this.stopTheLineSweep(now);
    } catch (e) {
      try {
        this.audit("hub:stop-the-line", "sweep_error", null, { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* next tick retries */ }
    }

    // (D) PR provenance indexing (BR#3287): sha → PR → task → verify-verdict
    // → agent session, stamped on task cards (board-side storage of record
    // per decision BR#3291). Isolated like its siblings — a GitHub outage or
    // a bad PR payload must never take the watchdog down with it.
    try {
      await this.provenanceSweep(now);
    } catch (e) {
      try {
        this.audit("hub:provenance", "sweep_error", null, { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* next tick retries */ }
    }

    // (E) blocker rollup: blocked cards sharing one machine-detectable root
    // cause (one unmerged PR; red main — BR#551) collapse into ONE boosted
    // ROOT BLOCKER task, and the queued cards point at it. The human sees a
    // single approval surface instead of N identical parked cards (BR#2645).
    let rollup: { created: string[]; stamped: number } | undefined;
    try {
      rollup = await this.rootBlockerRollup(now);
    } catch (e) {
      // the rollup must never take the watchdog down — log and keep going
      this.audit("system:watchdog", "sweep_error", "root_blocker_rollup", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (F) unblock-proxy watch (BR#3361a): blocked cards with machine-checkable
    // unblock conditions re-evaluated periodically; the unblock duty
    // auto-spawns when the proxy flips TRUE. Isolated like its siblings.
    try {
      await this.unblockProxySweep(now);
    } catch (e) {
      this.audit("hub:proxy-watch", "sweep_error", "unblock_proxy_sweep", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (G) closure-receipt audit (BR#3361c): done cards' receipted close legs
    // live-verified after the done; false claims get a correction duty. Isolated.
    try {
      await this.closureAuditSweep(now);
    } catch (e) {
      this.audit("hub:closure-audit", "sweep_error", "closure_audit_sweep", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // observability: the board can answer "is the watchdog alive?" via
    // /api/kb/stats — last tick, next alarm ts (poison detection: a
    // next_alarm_ts stuck in the past means the schedule is jammed), stale
    // in-flight count, open asks.
    const nextAlarm = await this.state.storage.getAlarm();
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.last_tick', ?)`,
      String(now),
    );
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.next_alarm', ?)`,
      String(nextAlarm ?? 0),
    );
    const staleNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_progress'
       AND COALESCE(json_extract(meta, '$.last_progress.ts'), 0) < ?`,
      now - staleMs,
    )?.n ?? 0;
    const staleReviewNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_review' AND status_ts < ?`,
      now - reviewStaleMin * 60_000,
    )?.n ?? 0;
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.sweep', ?)`,
      JSON.stringify({ ts: now, stale_in_progress: staleNow, stale_in_review: staleReviewNow, review_stale_minutes: reviewStaleMin, open_asks: openAsks, root_blocker_rollup: rollup ?? null }),
    );
  }

  // ---------- destination-green stop-the-line sweep (BR#3008) ----------
  // The loud half of BR#3009's destination-green precondition. The mechanical
  // half is the required `main-green gate` check (workflow +
  // scripts/main-green-gate.sh); this sweep pages the board when the line is
  // stopped EVEN IF nobody opens a PR — a red main must be loud on its own.
  //
  // Reads main's HEAD check runs from the public GitHub API (the repo is
  // public; no token lives in the worker), classifies with the same rule as
  // the gate (classifyMainCheckRuns), and on RED files — per red episode,
  // deduped per main-HEAD sha, so ten PRs observing one red sha produce one
  // of each, not ten:
  //   1. ONE urgent ask per red episode into the BR#3124 sink — the
  //      ATTENTION channel; and
  //   2. ONE claimable P0 episode task (BR#3284) — the WORK channel: title
  //      `STOP-THE-LINE: bridge main RED @ <short-sha> — fix main first`,
  //      body carrying the red checks, the first-failing sha/PR (bisect
  //      walk), the remediation exception and the done-when, boosted
  //      (priority 0) so it tops the board's ranked queue. A new red sha
  //      supersedes the prior open episode task.
  //
  // Settings: `stop_line_sweep_minutes` (default 5, 0 = off),
  // `stop_line_artefact_id` (ask sink; the standing card the asks and episode
  // tasks bind to), `stop_line_repo` (default state-vector/bridge),
  // `stop_line_gh_api_base` (default https://api.github.com — point at a
  // GHES/mock for drills).
  private settingValue(key: string, fallback: string): string {
    const row = this.one(`SELECT value FROM settings WHERE key = ?`, key);
    if (!row) return fallback;
    const raw = String(row.value);
    // settingsSet stores JSON-encoded values ("\"BR#123\""); the sweep's own
    // pacing writes store raw — tolerate both shapes.
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string" || typeof v === "number") return String(v);
    } catch { /* raw */ }
    return raw;
  }

  private async stopTheLineSweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("stop_line_sweep_minutes", "5"), 10) || 5));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("stop_line_last_sweep_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    // pace BEFORE the fetch: a hung GitHub call must not tight-loop the alarm
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('stop_line_last_sweep_ts', ?)`, String(ts));
    setLast(now);

    const repo = this.settingValue("stop_line_repo", "state-vector/bridge");
    const base = this.settingValue("stop_line_gh_api_base", "https://api.github.com").replace(/\/$/, "");
    const headers = { "User-Agent": "bridge-stop-the-line-sweep", "Accept": "application/vnd.github+json" };
    const ghGet = async (path: string): Promise<Response> => {
      const res = await fetch(`${base}/repos/${repo}${path}`, { headers });
      if (res.status === 403 || res.status === 429) {
        // unauthenticated GitHub quota is per egress IP and shared — back off
        // a full quota window rather than hammering; a skipped cycle only
        // delays an alert, it can never fake a green.
        setLast(now + 60 * 60_000);
        throw new Error(`github rate limited (HTTP ${res.status}) — backed off 60m`);
      }
      if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
      return res;
    };

    const head = await (await ghGet("/commits/main")).json() as any;
    const sha = String(head?.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`commits/main returned no sha`);
    const runsBody = await (await ghGet(`/commits/${sha}/check-runs?per_page=100`)).json() as any;
    const verdict = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []);

    if (verdict.verdict === "green") {
      this.audit("hub:stop-the-line", "green", null, { sha: sha.slice(0, 9), green: verdict.green });
      return;
    }
    if (verdict.verdict !== "red") {
      // unsettled/empty: CI still running (or nothing ran) — the gate blocks
      // merges on its own; here we only wait. A red line pages, a running
      // line does not.
      this.audit("hub:stop-the-line", "quiet", null, { sha: sha.slice(0, 9), verdict: verdict.verdict, unsettled: verdict.unsettled.slice(0, 5) });
      return;
    }

    const names = verdict.red.map((r) => r.name);
    const title = stopLineAskTitle(sha, names);
    const sinkId = this.settingValue("stop_line_artefact_id", STOP_LINE_SINK_ID);
    // the guilty chain rides the page (BR#3307, residue of BR#3287 spec
    // item 4): the ask names not just the red checks but the attributed
    // merge — PR · task · verdict · session · signer — from the provenance
    // index; honest absence when the sweep has not stamped it yet
    const chain = await this.guiltyChain(sha);
    // explicit open-ask check (same rule askCreate enforces) — keeps the
    // audit trail honest about skips. Questions are a TYPE in the ask
    // contract (the legacy `question` tag is stripped on write), so match
    // on type — a tag match would never fire and every re-sweep would fall
    // through to askCreate's guard and 400 instead of deduping quietly.
    const dup = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' AND c.title = ? LIMIT 1`,
      sinkId, title.slice(0, 200),
    );
    if (dup) {
      this.audit("hub:stop-the-line", "already_alerted", String(dup.id), { sha: sha.slice(0, 9), red: names });
    } else {
      const details = [
        `**STOP THE LINE — bridge main is RED.** Destination-green precondition (accepted decision BR#3009): merges halt until main is green. The \`main-green gate\` required check blocks every PR merge mechanically; this ask is the loud half.`,
        ``,
        `**Red checks on main ${sha.slice(0, 9)}:**`,
        ...verdict.red.map((r) => `- ${r.name} (${r.conclusion}) — ${r.url || "run URL unavailable"}`),
        ``,
        `**Guilty chain:** ${this.guiltyChainLine(chain, sha)}`,
        ``,
        `**The one exception — the remediation merge:** a PR green on the exact failing checks (receipted by the \`main-green gate\` carve-out) may merge as the remediation. The alert stands until the merge commit's checks come back green.`,
        ``,
        `_Filed once per red episode by the hub sweep (BR#3008), deduped per main-HEAD sha — not per PR._`,
      ].join("\n");
      const created = await this.askCreate(
        {
          to: "rayh",
          urgency: "time-sensitive",
          question: title,
          details,
          reason: "destination-green precondition (accepted BR#3009): main's HEAD has failing checks; every merge onto main is mechanically blocked until green",
          options: ["Acknowledge — on it", "Line stays stopped until green"],
          artefact_id: sinkId,
        },
        "hub:stop-the-line",
      );
      this.audit("hub:stop-the-line", "alert", String(created.id), { sha: sha.slice(0, 9), red: names });
    }
    // the claimable half (BR#3284): the ask above is ATTENTION; the episode
    // task is the WORK — one P0 task per red episode, deduped per sha,
    // superseding the prior open episode task when a new red sha arrives.
    await this.stopLineEpisodeTask(sha, verdict, sinkId, ghGet);
  }

  // ---------- the P0 episode task (BR#3284) ----------
  // The ask pages; the task claims. When main's HEAD is RED the sweep files,
  // alongside the ask, ONE claimable P0 task per red episode:
  //   - deduped per main-HEAD sha (same rule as the ask — one live episode
  //     task at a time; a re-sweep of the same sha audits and skips);
  //   - child_of the sink (BR#3124) — the episode family under one anchor;
  //   - body: red check names + run links, the first failing sha (the merge
  //     that broke the line — bisect walk below) + the PR that landed it,
  //     the remediation-merge exception (BR#3009/BR#3010), and the done-when;
  //   - priority is STRUCTURAL, not vibes: meta.boosted (the existing human-
  //     boost mechanism — priority 0 in the pickup ranking, first on the
  //     board's ranked queue) + the p0/stop-the-line/gtm-blocker tag chips;
  //   - when a NEW red sha arrives, the prior OPEN episode task is superseded
  //     (direct audited write, the same mechanical pattern the separation
  //     guard and the smoke purge use — a system actor filing machinery, not
  //     a session claiming; the supersedes relation + superseded_reason point
  //     the old card's readers at the replacement).
  private async stopLineEpisodeTask(
    sha: string,
    verdict: MainCheckVerdict,
    sinkId: string,
    ghGet: (path: string) => Promise<Response>,
  ): Promise<void> {
    const shortSha = sha.slice(0, 9);
    const title = `STOP-THE-LINE: bridge main RED @ ${shortSha} — fix main first`;
    // dedupe: exactly one LIVE episode task per red episode (per main-HEAD sha)
    const dup = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'task' AND c.title = ? LIMIT 1`,
      sinkId, title.slice(0, 200),
    );
    if (dup) {
      this.audit("hub:stop-the-line", "already_tasked", String(dup.id), { sha: shortSha, red: verdict.red.map((r) => r.name) });
      return;
    }

    // attribution: which merge broke the line? One bounded walk per episode
    // (the dedupe above keeps this off the re-sweep path) — never per sweep.
    const bisect = await this.stopLineBisect(ghGet, sha);
    // the guilty chain (BR#3307): the bisect names the breaking sha; the
    // provenance index turns it into PR → task → verdict → session → signer
    const chain = await this.guiltyChain(bisect.first_failing_sha);
    const culprit = bisect.first_failing_sha
      ? bisect.first_failing_pr
        ? `**First failing sha:** ${bisect.first_failing_sha.slice(0, 9)} — PR [#${bisect.first_failing_pr.number}](${bisect.first_failing_pr.html_url}) "${bisect.first_failing_pr.title}" (merged ${bisect.first_failing_pr.merged_at ?? "unknown"}) landed the break.`
        : `**First failing sha:** ${bisect.first_failing_sha.slice(0, 9)} — the PR that landed it could not be resolved (bisect walked ${bisect.walked} commit(s)); check merge history.`
      : `**First failing sha:** bisect unavailable (${bisect.note ?? "history walk failed"}) — check the run history of recent merges manually.`;
    const body = [
      `**STOP-THE-LINE episode task** — bridge main HEAD ${shortSha} is RED. Merges are mechanically halted by the \`main-green gate\` (accepted decision BR#3009, destination-green precondition). This task is the claimable priority item for putting the line back up. Work continues on branches (worktrees) — only the line stops.`,
      ``,
      `**Red checks on ${shortSha}:**`,
      ...verdict.red.map((r) => `- ${r.name} (${r.conclusion}) — ${r.url || "run URL unavailable"}`),
      ``,
      culprit,
      ``,
      `**Guilty chain:** ${this.guiltyChainLine(chain, bisect.first_failing_sha)}`,
      ``,
      `**The one exception — the remediation merge:** a PR green on the exact failing checks (receipted by the \`main-green gate\` carve-out) may merge as the remediation — precedent BR#3010 (PR #168, the 2026-10-24 do.test.ts rig fix). The alert stands until the merge commit's checks come back green.`,
      ``,
      `**Done when:** main tip has ALL check-runs settled green (0 red, 0 unsettled) and the \`main-green gate\` reopens — close this task citing the green run receipts.`,
      ``,
      `_Filed once per red episode by the hub sweep (BR#3008 + BR#3284), deduped per main-HEAD sha. The ask in the sink (BR#3124) is the attention channel; this task is the work._`,
    ].join("\n");
    const created = await this.create(
      {
        type: "task",
        title,
        body_md: body,
        // sanitizeTags lowercases (board tags are canonically lowercase — the
        // chip renders "p0"); role:impl declares the intended work kind for
        // pickup per the task-publishing norm (Ray's impl cards carry it).
        tags: ["stop-the-line", "p0", "gtm-blocker", "role:impl"],
        // the sweep KNOWS the scope, culprit and done-when — it analyzed the
        // episode as it filed it; publish claimable, not gate-throttled
        qualified: true,
        meta: {
          purpose: "stop-the-line episode task",
          stop_line: {
            sha,
            short_sha: shortSha,
            red: verdict.red.map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.url })),
            green_checks: verdict.green,
            unsettled: verdict.unsettled,
            first_failing_sha: bisect.first_failing_sha ?? undefined,
            first_failing_pr: bisect.first_failing_pr,
            // the resolved guilty chain (BR#3307): null when the provenance
            // sweep has not stamped the breaking merge yet — honest absence
            guilty_chain: chain.rec ? {
              repo: chain.rec.repo, pr: chain.rec.pr,
              task_id: chain.rec.task?.id ?? null, verdict_id: chain.rec.verdict_id,
              session: chain.rec.session, signer: chain.rec.signer,
            } : null,
            sink_id: sinkId,
          },
          // priority 0 — the existing urgent handling: first on the board's
          // ranked queue, top of the pickup ranking (same shape the human
          // boost endpoint writes; audited once below as part of the filing)
          boosted: Date.now(),
        },
      },
      "hub:stop-the-line",
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, sinkId, Date.now(),
    );
    // one live episode task at a time: the prior OPEN episode task (a
    // DIFFERENT red sha — same-sha re-sweeps deduped above) is over by
    // definition; its sha is no longer main's HEAD. Supersede it with a
    // supersedes relation so the old card's readers land on the replacement.
    const prior = this.one(
      `SELECT id, status, meta FROM artefacts
       WHERE type = 'task' AND status IN ('todo','in_progress','blocked') AND id != ?
         AND title LIKE 'STOP-THE-LINE: bridge main RED @ %'
       ORDER BY created_ts DESC LIMIT 1`,
      created.id,
    );
    if (prior) {
      const ts = Date.now();
      const pm = JSON.parse(prior.meta ?? "{}");
      pm.superseded_reason = `new red main episode @ ${shortSha} — superseded by ${created.id} (one live episode task at a time)`;
      pm.superseded_by = created.id;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(pm), ts, ts, prior.id,
      );
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
        created.id, prior.id, ts,
      );
      this.version(prior.id, "hub:stop-the-line", "transition", `superseded — new red main episode ${shortSha} (${created.id})`, { from: prior.status, to: "superseded" });
      this.audit("hub:stop-the-line", "episode_superseded", prior.id, { by: created.id, from: prior.status, new_sha: shortSha });
    }
    this.audit("hub:stop-the-line", "episode_task", String(created.id), {
      sha: shortSha, red: verdict.red.map((r) => r.name),
      first_failing: bisect.first_failing_sha?.slice(0, 9) ?? "unresolved", boosted: true,
    });
  }

  // ---------- episode attribution walk (bisect) ----------
  // Walk main's recent history (newest → oldest, bounded) to the first
  // failing sha: the newest commit back from HEAD whose parent settles green
  // is the merge that broke the line. Unauthenticated GitHub quota is shared
  // per egress IP, so the walk is CAPPED and any error downgrades to
  // "bisect unavailable" on the card — a failed attribution never blocks the
  // filing, and the settled-green boundary always stops the walk.
  private async stopLineBisect(
    ghGet: (path: string) => Promise<Response>,
    headSha: string,
  ): Promise<{ first_failing_sha?: string; first_failing_pr?: { number: number; title: string; html_url: string; merged_at: string | null }; walked: number; note?: string }> {
    const WALK = 10;
    try {
      const listBody = await (await ghGet(`/commits?per_page=${WALK}`)).json() as any;
      const commits: string[] = (Array.isArray(listBody) ? listBody : [])
        .map((c: any) => String(c?.sha ?? ""))
        .filter((s: string) => /^[0-9a-f]{40}$/.test(s));
      for (let i = 1; i < commits.length; i++) {
        const runsBody = await (await ghGet(`/commits/${commits[i]}/check-runs?per_page=100`)).json() as any;
        const v = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []);
        if (v.verdict !== "green") continue; // red/unsettled/empty — still inside the red episode, keep walking
        // commits[i] settles green → its child (commits[i-1], or HEAD itself
        // when the walk finds green immediately) broke the line
        const firstFailing = commits[i - 1] || headSha;
        let pr: { number: number; title: string; html_url: string; merged_at: string | null } | undefined;
        try {
          const pullsBody = await (await ghGet(`/commits/${firstFailing}/pulls`)).json() as any;
          const pulls: any[] = Array.isArray(pullsBody) ? pullsBody : [];
          const pick = pulls.find((p) => p?.merged_at) ?? pulls[0];
          if (pick) pr = {
            number: Number(pick.number),
            title: String(pick.title ?? ""),
            html_url: String(pick.html_url ?? ""),
            merged_at: pick.merged_at ?? null,
          };
        } catch { /* pulls lookup failed — the sha is still reported */ }
        return { first_failing_sha: firstFailing, first_failing_pr: pr, walked: i };
      }
      return { walked: commits.length, note: `no settled-green commit within ${WALK} commits of main` };
    } catch (e) {
      return { walked: 0, note: String((e as Error).message ?? e).slice(0, 200) };
    }
  }

  // ---------- standing merge-queue sweep (BR#3198) ----------
  // The deterministic executor of the BR#3033 standing merge order ("merge
  // when green") — the run-side complement of BR#3008's stop-the-line gate.
  // Every tick (paced by `merge_sweep_minutes`, default 15, 0 = off), for each
  // OPEN PR on both repos, oldest first:
  //   superseded-check → 5c mechanical gate (mergeable + clean + every commit
  //   GitHub-verified + base green + head checks green) + an ACCEPTED
  //   verify-verdict decision covering the current head → merge (squash per
  //   repo norm). Mechanical defects auto-bounce the linked card with the
  //   exact defect; human-leg defects (externals, signing environment) are
  //   collected into ONE class ask per repo per episode, never one per PR.
  //
  // Identity: merges as the token's identity — deploy GH_TOKEN as the
  // detached-cody credential per BR#3181, never rayh's personal credentials.
  // Settings: `merge_sweep_minutes` (default 15), `merge_sweep_repos` (JSON
  // array, default both repos), `merge_sweep_methods` (JSON map repo →
  // "merge" | "squash", default bridge=merge / superpositional=squash),
  // `merge_sweep_artefact_id` (class-ask sink, default BR#3198),
  // `merge_sweep_gh_api_base` (drills/tests only).
  /** PR provenance sweep (BR#3287): index recent merges — sha → PR → task →
   *  verify-verdict → agent session — stamp task cards (meta.provenance,
   *  board-side storage of record per decision BR#3291) and mirror
   *  best-effort to GitHub (derived, never read back). Dedupe per (repo, pr)
   *  via the provenance table; backfill window bounds the cold-start scan. */
  private async provenanceSweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("provenance_sweep_minutes", "15"), 10) || 15));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("provenance_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('provenance_last_ts', ?)`, String(ts));
    setLast(now); // pace BEFORE the fetch — a hung GitHub call must not tight-loop the tick

    const token = this.env.GH_TOKEN;
    if (!token) {
      this.audit("hub:provenance", "no_identity", null, { note: "GH_TOKEN not configured — provenance sweep cannot read GitHub; skipping (endpoint + backfill resume when it returns)" });
      return;
    }
    const base = this.settingValue("provenance_gh_api_base", "https://api.github.com").replace(/\/$/, "");
    let repos: string[] = [];
    try {
      const parsed = JSON.parse(this.settingValue("provenance_repos", JSON.stringify(["state-vector/bridge", "state-vector/superpositional"])));
      if (Array.isArray(parsed)) repos = parsed.map(String);
    } catch { repos = []; }
    if (!repos.length) repos = ["state-vector/bridge", "state-vector/superpositional"];
    const backfillDays = Math.max(1, Math.min(365, parseInt(this.settingValue("provenance_backfill_days", "30"), 10) || 30));

    const ghGet = async (path: string): Promise<any> => {
      const res = await fetch(`${base}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "bridge-provenance-sweep (BR#3287)",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (res.status === 403 || res.status === 429) {
        setLast(now + 60 * 60_000); // quota exhausted — back off a full window
        throw new Error(`github rate limited (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
      return res.json();
    };

    let indexed = 0;
    for (const repo of repos) {
      let pulls: any[] = [];
      try {
        pulls = await ghGet(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`) as any[];
      } catch (e) {
        this.audit("hub:provenance", "repo_error", null, { repo, error: String((e as Error).message ?? e).slice(0, 200) });
        continue;
      }
      for (const pr of pulls) {
        if (!pr?.merged_at || !pr?.merge_commit_sha || !pr?.number) continue;
        const mergedAt = withinBackfillWindow(pr.merged_at, now, backfillDays);
        if (mergedAt === null) continue;
        const seen = this.one(`SELECT merge_sha FROM provenance WHERE repo = ? AND pr = ?`, repo, pr.number);
        if (seen) continue; // dedupe per (repo, pr) — provenance is immutable once stamped
        try {
          const detail = await ghGet(`/repos/${repo}/pulls/${pr.number}`);
          const headSha = String(detail?.head?.sha ?? "");
          const branch = String(detail?.head?.ref ?? "");
          const cardRef = prCardRef(branch, `${pr.title ?? ""}\n${pr.body ?? ""}\n${detail?.title ?? ""}\n${detail?.body ?? ""}`);
          const commitsBody = await ghGet(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
          const commits = (commitsBody ?? []).map((c: any) => ({
            verified: c?.commit?.verification?.verified === true,
            committer_email: String(c?.commit?.committer?.email ?? ""),
          }));
          const signer = signerFromCommits(commits);
          let taskId: string | null = cardRef;
          let verdictId: string | null = null;
          let session: string | null = null;
          if (taskId && /^[0-9a-f]{40}$/.test(headSha)) {
            // accepted verify lineage: decisions derived_from the linked card
            // citing the head sha (same join the merge sweep uses — body_md
            // is selected: citations live in the verdict body, not just meta)
            const decisions = this.state.storage.sql.exec(
              `SELECT d.id AS id, d.body_md AS body_md, d.meta AS meta FROM relations r
               JOIN artefacts d ON d.id = r.src_id
               WHERE r.relation = 'derived_from' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted'`,
              taskId,
            ).toArray() as any[];
            // verdict selection (BR#3307 residue): only a decision that
            // actually cites the head sha may vouch. Human merges and older
            // merges often have no accepted decision on the exact head —
            // falling back to decisions[0] would attach an arbitrary stale
            // verdict to the chain; verdict_id stays null instead (honest
            // "unverified", the same contract as a missing card link).
            const onHead = decisions.find((d: any) =>
              (String(d.body_md ?? "") + String(d.meta ?? "")).includes(headSha.slice(0, 9)),
            );
            if (onHead) {
              verdictId = String(onHead.id);
              try { session = String(JSON.parse(onHead.meta ?? "{}")?.session ?? "") || null; } catch { session = null; }
            }
          }
          this.state.storage.sql.exec(
            `INSERT OR REPLACE INTO provenance (repo, pr, merge_sha, head_sha, task_id, verdict_id, session, signer, merged_at, stamped_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            repo, pr.number, String(pr.merge_commit_sha), headSha, taskId, verdictId, session, signer, mergedAt, Date.now(),
          );
          indexed++;
          // board-side stamp: the card carries its own provenance (BR#3291)
          if (taskId) {
            const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, taskId);
            if (row) {
              const meta = JSON.parse(row.meta ?? "{}");
              meta.provenance = {
                pr: pr.number, repo, merge_sha: String(pr.merge_commit_sha).slice(0, 12), head_sha: headSha.slice(0, 12),
                verdict_id: verdictId, session, signer, merged_at: mergedAt,
              };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), Date.now(), taskId);
              this.audit("hub:provenance", "stamped", taskId, { pr: pr.number, repo, merge_sha: String(pr.merge_commit_sha).slice(0, 9), signer });
            }
          } else {
            // class-only record of absence — a merge with no bridge task is
            // itself a signal (BR#3291: "no bridge provenance" is honest data)
            this.audit("hub:provenance", "no_card", null, { repo, pr: pr.number, merge_sha: String(pr.merge_commit_sha).slice(0, 9), signer });
          }
          // derived GH mirror (BR#3291: non-authoritative, best-effort)
          if (taskId) {
            try {
              await fetch(`${base}/repos/${repo}/issues/${pr.number}/labels`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
                // label format per README/spec: bridge:BR-<id> (BR#3307 — the
                // raw card id renders "bridge:BR#3287"; normalize the #)
                body: JSON.stringify({ labels: [`bridge:${taskId.replace("#", "-")}`] }),
              });
            } catch { /* mirror is best-effort only */ }
          }
        } catch (e) {
          this.audit("hub:provenance", "pr_error", null, { repo, pr: pr.number, error: String((e as Error).message ?? e).slice(0, 200) });
        }
      }
    }
    if (indexed) this.audit("hub:provenance", "indexed", null, { indexed, repos: repos.join(",") });
  }

  /** sha → PR → task → verify-verdict → agent session (BR#3287). Matches by
   *  merge sha or head sha (7+ hex prefix). Returns null when nothing is
   *  known — an honest "no bridge provenance" (404) rather than a guess. */
  private async provenanceLookup(sp: URLSearchParams) {
    return this.provenanceBySha(parseProvenanceSha(sp));
  }

  private async provenanceBySha(sha: string) {
    const row = this.one(
      `SELECT * FROM provenance WHERE merge_sha = ? OR merge_sha LIKE ? OR head_sha = ? OR head_sha LIKE ? LIMIT 1`,
      sha, `${sha}%`, sha, `${sha}%`,
    ) as any;
    if (!row) return null;
    const task = row.task_id ? this.one(`SELECT id, title, status, owner FROM artefacts WHERE id = ?`, row.task_id) as any : null;
    return {
      sha,
      repo: row.repo, pr: row.pr,
      merge_sha: row.merge_sha, head_sha: row.head_sha,
      task: task ? { id: task.id, title: task.title, status: task.status, owner: task.owner } : null,
      verdict_id: row.verdict_id, session: row.session, signer: row.signer,
      merged_at: row.merged_at, stamped_at: row.stamped_at,
    };
  }

  /** The guilty-chain outcome for an alarm note (BR#3307, residue of
   *  BR#3287 spec item 4): explicitly typed — `rec` carries the resolved
   *  PR → task → verify verdict → agent session → signer chain when the
   *  provenance index has stamped the merge, and `error` is set ONLY when
   *  the lookup itself failed. Never throws — attribution must not break
   *  the filing (the same downgrade philosophy as the bisect walk) — but a
   *  failure is never converted into success: the caller distinguishes it
   *  (the note renders the error, not the honest-absence line) and the
   *  audit trail receipts it (hub:stop-the-line/guilty_chain_error — SP
   *  review round 1, PR #198: silence was the one thing it must not be). */
  private async guiltyChain(sha: string | null | undefined): Promise<{ rec: any; error?: string }> {
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return { rec: null };
    try {
      return { rec: await this.provenanceBySha(sha) };
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 200);
      this.audit("hub:stop-the-line", "guilty_chain_error", null, {
        sha: String(sha).slice(0, 9), error,
      });
      return { rec: null, error };
    }
  }

  /** One markdown chain segment: `PR #N · task BR#X · verdict BR#Y ·
   *  session s · signer class` — with honest fallback lines: the provenance
   *  sweep has not stamped the merge yet, or the lookup failed (withheld,
   *  never guessed). */
  private guiltyChainLine(chain: { rec: any; error?: string }, sha: string | null | undefined): string {
    if (chain.error) {
      return `_provenance lookup failed (${chain.error}) — the chain is withheld rather than guessed; receipted on the audit trail (hub:stop-the-line/guilty_chain_error)_`;
    }
    if (!chain.rec) {
      return `_no bridge provenance for ${sha ? sha.slice(0, 9) : "this sha"} yet — \`GET /api/kb/provenance?sha=\` returns the chain once the provenance sweep stamps the merge_`;
    }
    const rec = chain.rec;
    const prUrl = `https://github.com/${rec.repo}/pull/${rec.pr}`;
    return [
      `PR [#${rec.pr}](${prUrl})`,
      `task ${rec.task?.id ?? "none (no bridge card)"}`,
      `verdict ${rec.verdict_id ?? "none (unverified merge)"}`,
      `session ${rec.session ?? "—"}`,
      `signer ${rec.signer ?? "unknown"}`,
    ].join(" · ");
  }

  // ---------- unblock-proxy watch (BR#3361a) ----------
  // The BR#3129 class: a parked card's machine-checkable unblock_condition
  // flipped TRUE (its PR merged) and NOBODY noticed for ~20h — unblock duties
  // only re-ran when a human-dispatched sweep happened to look. This sweep
  // re-evaluates machine-checkable proxies periodically and auto-spawns the
  // unblock duty on the flip.
  //
  // Conservatism: the sweep is a TRIGGER, not an authority. It flips a card
  // only when parseProxyCondition extracted atoms for the WHOLE condition and
  // every atom evaluated TRUE against live state; anything it cannot fully
  // read is stamped unparseable/unresolvable and never auto-flips. The
  // spawned duty re-verifies first-hand (its contract says so).
  //
  // Settings: `unblock_proxy_sweep_minutes` (default 15, 0 = off),
  // `unblock_proxy_gh_api_base` (default https://api.github.com — drills),
  // `unblock_proxy_default_repo` (bare-number fallback for live checks).
  private proxyGhGet(base: string, token: string | undefined, setBackoff: (ts: number) => void, now: number) {
    return async (repo: string, path: string): Promise<{ ok: boolean; status: number; body: any }> => {
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bridge-proxy-watch (BR#3361)" }
        : { "User-Agent": "bridge-proxy-watch (BR#3361)", "Accept": "application/vnd.github+json" };
      const res = await fetch(`${base}/repos/${repo}${path}`, { headers });
      if (res.status === 403 || res.status === 429) {
        setBackoff(now + 60 * 60_000); // shared per-IP quota — back off a full window
        throw new Error(`github rate limited (HTTP ${res.status})`);
      }
      return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
    };
  }

  /** Live verdict for one proxy atom. `receipt` is the evidence line that
   *  rides the spawned duty's body (and the per-card stamp). */
  private async evalProxyAtom(
    atom: ProxyAtom,
    io: { ghGet: (repo: string, path: string) => Promise<{ ok: boolean; status: number; body: any }>; defaultRepo: string },
  ): Promise<{ ok: boolean; receipt: string }> {
    const unresolvable = { ok: false, receipt: "unresolvable (no repo in the condition text)" };
    const brBranch = (atom.brId ?? "").replace("#", "-");
    switch (atom.kind) {
      case "br_done": {
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, atom.brId);
        if (!row) return { ok: false, receipt: `${atom.brId} not found on this board` };
        const done = row.status === "done" || row.status === "superseded";
        return { ok: done, receipt: `${atom.brId} status=${row.status}` };
      }
      case "pr_merged": {
        if (!atom.repo) return unresolvable;
        const res = await io.ghGet(atom.repo, `/pulls/${atom.number}`);
        if (!res.ok) return { ok: false, receipt: `PR ${atom.repo}#${atom.number} lookup HTTP ${res.status}` };
        const merged = !!res.body?.merged_at;
        return { ok: merged, receipt: merged ? `PR ${atom.repo}#${atom.number} MERGED at ${res.body.merged_at}` : `PR ${atom.repo}#${atom.number} state=${res.body?.state ?? "?"}, not merged` };
      }
      case "br_pr_merged": {
        if (!atom.repo) return unresolvable;
        const res = await io.ghGet(atom.repo, `/pulls?head=${atom.repo}:bridge/${brBranch}&state=all&per_page=20`);
        if (!res.ok) return { ok: false, receipt: `PR lookup for ${atom.brId} HTTP ${res.status}` };
        const pr = (Array.isArray(res.body) ? res.body : []).find((p: any) => String(p.head?.ref ?? "") === `bridge/${brBranch}`);
        if (!pr) return { ok: false, receipt: `no PR with head branch bridge/${brBranch} (${atom.brId})` };
        const merged = !!pr.merged_at;
        return { ok: merged, receipt: merged ? `PR ${atom.repo}#${pr.number} for ${atom.brId} MERGED at ${pr.merged_at}` : `PR ${atom.repo}#${pr.number} for ${atom.brId} not merged` };
      }
      case "issue_closed": {
        if (!atom.repo) return unresolvable;
        const res = await io.ghGet(atom.repo, `/issues/${atom.number}`);
        if (!res.ok) return { ok: false, receipt: `issue ${atom.repo}#${atom.number} lookup HTTP ${res.status}` };
        const closed = res.body?.state === "closed";
        return { ok: closed, receipt: `issue ${atom.repo}#${atom.number} state=${res.body?.state ?? "?"}` };
      }
      case "run_success": {
        if (!atom.repo) return unresolvable;
        const res = await io.ghGet(atom.repo, `/actions/runs/${atom.runId}`);
        if (!res.ok) return { ok: false, receipt: `run ${atom.runId} lookup HTTP ${res.status}` };
        const ok = res.body?.status === "completed" && res.body?.conclusion === "success";
        return { ok, receipt: `run ${atom.runId} status=${res.body?.status ?? "?"} conclusion=${res.body?.conclusion ?? "?"}` };
      }
      case "pr_checks_green": {
        if (!atom.repo) return unresolvable;
        const pr = await io.ghGet(atom.repo, `/pulls/${atom.number}`);
        if (!pr.ok) return { ok: false, receipt: `PR ${atom.repo}#${atom.number} lookup HTTP ${pr.status}` };
        const sha = String(pr.body?.head?.sha ?? "");
        if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, receipt: `PR ${atom.repo}#${atom.number} head sha unavailable` };
        const runs = await io.ghGet(atom.repo, `/commits/${sha}/check-runs?per_page=100`);
        if (!runs.ok) return { ok: false, receipt: `check-runs lookup HTTP ${runs.status}` };
        const verdict = classifyMainCheckRuns(Array.isArray(runs.body?.check_runs) ? runs.body.check_runs : []).verdict;
        return { ok: verdict === "green", receipt: `PR ${atom.repo}#${atom.number} head ${sha.slice(0, 9)} checks verdict=${verdict}` };
      }
    }
  }

  /** Stamp meta.proxy_check on a blocked card; audit ONLY when the verdict
   *  changed (a stable false must not churn the Log every cycle). */
  private stampProxyCheck(
    id: string,
    meta: any,
    now: number,
    verdict: string,
    detail: string | null,
    prev: { verdict?: string } | undefined,
    extra?: Record<string, unknown>,
  ): void {
    meta.proxy_check = { at: now, verdict, ...(detail ? { detail } : {}), ...(extra ?? {}) };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
    if (!prev || prev.verdict !== verdict) {
      this.audit("hub:proxy-watch", "proxy_check", id, { verdict, detail: detail?.slice(0, 300) });
    }
  }

  private async unblockProxySweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("unblock_proxy_sweep_minutes", "15"), 10) || 15));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("unblock_proxy_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('unblock_proxy_last_ts', ?)`, String(ts));
    setLast(now); // pace BEFORE the fetch: a hung GitHub call must not tight-loop the tick
    const base = this.settingValue("unblock_proxy_gh_api_base", "https://api.github.com").replace(/\/$/, "");
    const token = this.env.GH_TOKEN as string | undefined;
    const defaultRepo = this.settingValue("unblock_proxy_default_repo", "state-vector/superpositional");
    const ghGet = this.proxyGhGet(base, token, setLast, now);
    const rows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const cond = String(meta.blocked?.unblock_condition ?? "").trim();
        if (!cond) continue;
        const prev = meta.proxy_check;
        if (prev?.at && now - Number(prev.at) < periodMin * 60_000) continue; // per-card pacing
        const { atoms, unparseable } = parseProxyCondition(cond);
        if (!atoms.length) {
          this.stampProxyCheck(r.id, meta, now, unparseable ? "unparseable" : "no_atoms",
            unparseable ? "condition mentions machine state but no atom parsed — never auto-flips" : null, prev);
          continue;
        }
        const results: { atom: ProxyAtom; ok: boolean; receipt: string }[] = [];
        for (const atom of atoms) results.push({ atom, ...(await this.evalProxyAtom(atom, { ghGet, defaultRepo })) });
        const unresolvable = results.some((x) => !x.ok && x.receipt.startsWith("unresolvable"));
        if (unparseable || unresolvable) {
          // cannot FULLY read the condition — never auto-flip (conservatism law)
          this.stampProxyCheck(r.id, meta, now, unparseable ? "unparseable" : "unresolvable",
            "condition partially machine-checkable — the sweep never flips a card it cannot fully read", prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        if (!results.some((x) => x.ok)) {
          this.stampProxyCheck(r.id, meta, now, "false", null, prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        // the flip: spawn the unblock duty (the machine's caps still apply —
        // ≤1 open unblock child, flood guard on identical exit conditions)
        const openChild = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`, r.id,
        );
        const lastSpawn = meta.last_unblock_spawn;
        // same flood law as the machine's own spawn (machine.ts): only the
        // SAME exit condition within the window floods — a block-time round
        // with this exact condition is already on the case; a later flip
        // past the window spawns a fresh round (the BR#3129 story: the flip
        // came ~20h after the park-time round)
        const flooded =
          lastSpawn && typeof lastSpawn.at === "number" && now - lastSpawn.at < UNBLOCK_FLOOD_MS &&
          String(lastSpawn.exit ?? "") === cond;
        if (openChild || flooded) {
          this.stampProxyCheck(r.id, meta, now, "true", null, prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })), spawned: openChild?.id ?? null, spawn_skipped: openChild ? `existing unblock child ${openChild.id}` : "flood guard" });
          if (prev?.verdict !== "true") {
            this.audit("hub:proxy-watch", "proxy_flip_deferred", r.id, { spawned: openChild?.id ?? null, reason: openChild ? "existing unblock child" : "flood guard" });
          }
          continue;
        }
        const ts = Date.now();
        const rootTitle = String(r.title ?? r.id).replace(/^(?:Unblock:\s*)+/, "");
        const atomLines = results.map((x) => `- "${x.atom.raw}" → ${x.receipt}`).join("\n");
        const created = await this.create(
          {
            type: "task",
            title: `Unblock: ${rootTitle.slice(0, 190)}`,
            session: "", // session-less spawn: the closer stamps it when they claim
            body_md: `Unblock duty for ${r.id} — "${rootTitle}" (auto-spawned by the hub proxy-watch, BR#3361).\n\nBlocked why: ${String(meta.blocked?.reason ?? "").trim() || "see parent"}.\nExit condition: ${cond}\n\nMACHINE PROXY — the hub evaluated the exit condition TRUE at ${new Date(ts).toISOString()} (receipts):\n${atomLines}\n\nThe predicate the card parked on has flipped. Do the terminal work the card promised: execute the exit condition (live re-verify first — this sweep is a trigger, not an authority), transition ${r.id} → in_progress with the resolution note, then close yourself done citing these receipts.\n\nContract: if the live state does NOT hold (the sweep mis-read), record findings via log_progress and close yourself done with the findings — do NOT respawn an unblock task, do not leave yourself open.`,
            roles: ["unblock"],
          },
          "hub:proxy-watch",
        );
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
          created.id, r.id, ts,
        );
        meta.last_unblock_spawn = { at: ts, exit: cond.slice(0, 500) };
        this.stampProxyCheck(r.id, meta, now, "true", null, prev,
          { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })), spawned: created.id });
        this.audit("hub:proxy-watch", "proxy_flip", r.id, { spawned: created.id, atoms: results.map((x) => x.receipt) });
        this.version(r.id, "hub:proxy-watch", "note", `machine proxy flipped TRUE — unblock duty ${created.id} auto-spawned (BR#3361)`, { spawned: created.id });
      } catch (e) {
        this.audit("hub:proxy-watch", "sweep_error", r.id, { error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  }

  // ---------- closure-receipt audit (BR#3361c) ----------
  // The BR#3220 class: a DONE card reported "GH#2337 fully closed" while the
  // issue was OPEN on GitHub — the board reported a closed issue that wasn't.
  // The done gate (done-close-legs) makes receipts mandatory at done time;
  // THIS sweep makes them TRUE: it live-verifies every receipted close leg
  // (issue state + closing comment + guard run) after the done and files a
  // correction duty on any false claim.
  //
  // Settings: `closure_audit_minutes` (default 30, 0 = off),
  // `closure_audit_gh_api_base` (drills), `closure_audit_default_repo`
  // (bare-number legs resolve here for live checks).
  private async closureAuditSweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("closure_audit_minutes", "30"), 10) || 30));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("closure_audit_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('closure_audit_last_ts', ?)`, String(ts));
    setLast(now);
    const base = this.settingValue("closure_audit_gh_api_base", "https://api.github.com").replace(/\/$/, "");
    const token = this.env.GH_TOKEN as string | undefined;
    const defaultRepo = this.settingValue("closure_audit_default_repo", "state-vector/superpositional");
    const ghGet = this.proxyGhGet(base, token, setLast, now);
    // bound the pass: quota is shared — leftovers wait for the next cycle
    const rows = this.state.storage.sql.exec(
      `SELECT id, meta FROM artefacts WHERE type = 'task' AND status = 'done'
       AND json_extract(meta, '$.close_leg_audit.legs') IS NOT NULL
       AND json_extract(meta, '$.close_leg_audit.checked_ts') IS NULL LIMIT 10`,
    ).toArray() as any[];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const audit = meta.close_leg_audit;
        const checks: { repo: string; number: number; issue: string; comment: string; guard: string; ok: boolean }[] = [];
        let allOk = true;
        for (const leg of audit.legs ?? []) {
          const receipt = (audit.receipts ?? []).find((x: any) => x.number === leg.number) ?? {};
          const repo = leg.repo ?? defaultRepo;
          let issue = "not checked", comment = "no comment id in receipt", guard = "no guard run in receipt", ok = true;
          const iss = await ghGet(repo, `/issues/${leg.number}`);
          if (iss.ok) {
            issue = `state=${iss.body?.state}`;
            if (iss.body?.state !== "closed") { ok = false; allOk = false; }
          } else {
            issue = `lookup HTTP ${iss.status}`;
            ok = false; allOk = false; // an unverifiable receipt is not a good receipt
          }
          if (receipt.commentId && /^\d{6,}$/.test(String(receipt.commentId))) {
            const c = await ghGet(repo, `/issues/${leg.number}/comments/${receipt.commentId}`);
            comment = c.ok ? `comment ${receipt.commentId} exists` : `comment ${receipt.commentId} HTTP ${c.status}`;
            if (!c.ok) { ok = false; allOk = false; }
          }
          if (receipt.guardRun && /^\d{6,}$/.test(String(receipt.guardRun))) {
            const g = await ghGet(repo, `/actions/runs/${receipt.guardRun}`);
            guard = g.ok ? `guard run ${receipt.guardRun} exists (${g.body?.conclusion ?? "?"})` : `guard run ${receipt.guardRun} HTTP ${g.status}`;
            // a guard id that resolves nowhere is suspicious but not damning
            // (it may live in another repo) — the issue + comment legs decide
          }
          checks.push({ repo, number: leg.number, issue, comment, guard, ok });
        }
        meta.close_leg_audit.checked_ts = now;
        meta.close_leg_audit.verdict = allOk ? "ok" : "false";
        meta.close_leg_audit.checks = checks;
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
        if (allOk) {
          this.audit("hub:closure-audit", "closure_receipt_ok", r.id, { checks: checks.map((c) => `${c.repo}#${c.number} ${c.issue} ${c.comment}`) });
          continue;
        }
        const detail = checks.map((c) => `${c.repo}#${c.number}: ${c.issue}; ${c.comment}; ${c.guard}`).join(" | ");
        this.audit("hub:closure-audit", "closure_receipt_false", r.id, { detail: detail.slice(0, 300) });
        this.version(r.id, "hub:closure-audit", "note", `CLOSURE RECEIPT AUDIT — FALSE: ${detail.slice(0, 300)}`, { checks });
        // one correction duty per false receipt (flood-guarded)
        const stamp = meta.last_correction_spawn;
        if (!(stamp && typeof stamp.at === "number" && now - stamp.at < UNBLOCK_FLOOD_MS)) {
          const created = await this.create(
            {
              type: "task",
              title: `Correction: false closure receipt on ${r.id}`,
              session: "", // session-less spawn: the closer stamps it when they claim
              body_md: `A done card's closure receipt failed the hub's live audit (BR#3361 — the BR#3220 class: the board reported a closed issue that wasn't).\n\nCard: ${r.id} (done, claims close legs with receipts)\nAudit: ${detail}\n\nContract: (1) verify the live state of each leg first-hand (gh issue view). (2) If the issue is OPEN, the close never happened — execute the close per the card's grammar and correct the card record (a progress note correcting the false claim, citing the real receipt: state=closed + closing-comment id + guard run id). (3) If the issue IS closed and the receipt was merely stale/wrong-shaped, correct the record to the true receipt. (4) Close yourself done citing the corrected receipts.`,
              roles: ["unblock"],
            },
            "hub:closure-audit",
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, r.id, Date.now(),
          );
          meta.last_correction_spawn = { at: now, child: created.id };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
          this.audit("hub:closure-audit", "correction_spawned", r.id, { child: created.id });
        }
      } catch (e) {
        this.audit("hub:closure-audit", "sweep_error", r.id, { error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  }

  private async mergeQueueSweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("merge_sweep_minutes", "15"), 10) || 15));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("merge_sweep_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('merge_sweep_last_ts', ?)`, String(ts));    // pace BEFORE the fetch: a hung GitHub call must not tight-loop the tick
    setLast(now);

    const token = this.env.GH_TOKEN;
    if (!token) {
      this.audit("hub:merge-sweep", "no_identity", null, { note: "GH_TOKEN not configured — the sweep cannot merge as detached-cody (BR#3181); skipping, never merging unauthenticated" });
      return;
    }
    const base = this.settingValue("merge_sweep_gh_api_base", "https://api.github.com").replace(/\/$/, "");
    let repos: string[] = [];
    try {
      const parsed = JSON.parse(this.settingValue("merge_sweep_repos", JSON.stringify(["state-vector/bridge", "state-vector/superpositional"])));
      if (Array.isArray(parsed)) repos = parsed.map(String);
    } catch { repos = []; }
    if (!repos.length) repos = ["state-vector/bridge", "state-vector/superpositional"];
    let methods: Record<string, string> = {};
    try {
      const parsed = JSON.parse(this.settingValue("merge_sweep_methods", JSON.stringify({ "state-vector/bridge": "merge", "state-vector/superpositional": "squash" })));
      if (parsed && typeof parsed === "object") methods = parsed;
    } catch { methods = {}; }

    // PR disposition law knobs (BR#3312/BR#3315): every open PR gets exactly
    // one disposition per pass — merged, closed-with-reason, or advancing
    // with a clock. Default ON; the clock rows fail safe on unknown data.
    const prDispositionEnabled = /^(1|true|on|yes)$/i.test(this.settingValue("pr_disposition_enabled", "1"));
    const prStaleDays = Math.max(1, Math.min(365, parseInt(this.settingValue("pr_stale_days", "7"), 10) || 7));
    const prOrphanDays = Math.max(1, Math.min(365, parseInt(this.settingValue("pr_orphan_days", "3"), 10) || 3));
    const prGraceHours = Math.max(1, Math.min(720, parseInt(this.settingValue("pr_grace_hours", "48"), 10) || 48));

    const ghGet = async (path: string): Promise<any> => {
      const res = await fetch(`${base}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "bridge-merge-sweep (BR#3198)",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (res.status === 403 || res.status === 429) {
        setLast(now + 60 * 60_000); // quota exhausted — back off a full window
        throw new Error(`github rate limited (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
      return res.json();
    };

    const cardRef = (text: string): string | null => {
      const m = /BR#(\d+)/.exec(text ?? "");
      return m ? `BR#${m[1]}` : null;
    };

    /** Append a progress note WITHOUT touching status or claims — receipts and
     *  mechanical-defect notes on cards the sweep must not disturb. */
    const sweepNote = (id: string, note: string) => {
      const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, id);
      if (!row) return;
      const meta = JSON.parse(row.meta ?? "{}");
      meta.last_progress = { note: note.slice(0, 500), sentiment: "neutral", actor: "system:merge-sweep", ts: Date.now() };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), Date.now(), id);
      this.audit("system:merge-sweep", "progress", id, { note: note.slice(0, 500) });
      this.version(id, "system:merge-sweep", "progress", note.slice(0, 500), { note: note.slice(0, 500) });
    };

    /** Terminal-state closure (BR#3312): never silent — the reason comment is
     *  the receipt ON the PR (comment FIRST: a failed comment aborts the
     *  close), then the card note. PRs are reopenable; the card keeps intent. */
    const closeWithReason = async (repo: string, prNumber: number, reason: string, linked: string | null) => {
      const comment = await fetch(`${base}/repos/${repo}/issues/${prNumber}/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "bridge-merge-sweep (BR#3315)",
        },
        body: JSON.stringify({ body: reason }),
      });
      if (!comment.ok) throw new Error(`close-reason comment POST -> HTTP ${comment.status}`);
      const close = await fetch(`${base}/repos/${repo}/issues/${prNumber}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "bridge-merge-sweep (BR#3315)",
        },
        body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
      });
      if (!close.ok) throw new Error(`close PATCH -> HTTP ${close.status}`);
      if (linked) sweepNote(linked, `${reason.slice(0, 380)} — PR #${prNumber} closed by the merge sweep`);
    };

    const results: any[] = [];
    for (const repo of repos) {
      const humanLegs: string[] = [];
      try {
        const pulls = await ghGet(`/repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=100`) as any[];
        // base-green precondition, once per repo per sweep
        const head = await ghGet(`/repos/${repo}/commits/main`);
        const baseSha = String(head?.sha ?? "");
        let baseVerdict: "green" | "red" | "unsettled" | "empty" = "empty";
        if (/^[0-9a-f]{40}$/.test(baseSha)) {
          const runsBody = await ghGet(`/repos/${repo}/commits/${baseSha}/check-runs?per_page=100`);
          baseVerdict = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []).verdict;
        }

        for (const pr of pulls) {
          const prNumber = pr.number;
          try {
            const detail = await ghGet(`/repos/${repo}/pulls/${prNumber}`);
            const prText = `${pr.title ?? ""}\n${pr.body ?? ""}\n${detail.title ?? ""}\n${detail.body ?? ""}`;
            // provenance join (BR#3287): the head branch (bridge/BR-<id>) is the
            // authoritative key; PR text is the fallback.
            const linked = cardRef(prText)
              ?? prCardRef(String(detail?.head?.ref ?? "").replace(/^refs\/heads\//, ""), prText);
            const card = linked ? this.one(`SELECT id, status, owner, meta, updated_ts FROM artefacts WHERE id = ?`, linked) : null;
            const cardStatus = card ? String(card.status) : null;

            // accepted verify lineage: decisions derived_from the linked card
            // whose body/meta cites the current head sha
            let verifyAcceptedAny = false;
            let verifyAcceptedOnHead = false;
            const headSha = String(detail?.head?.sha ?? "");
            if (linked && /^[0-9a-f]{40}$/.test(headSha)) {
              const decisions = this.state.storage.sql.exec(
                `SELECT d.body_md AS body_md, d.meta AS meta FROM relations r
                 JOIN artefacts d ON d.id = r.src_id
                 WHERE r.relation = 'derived_from' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted'`,
                linked,
              ).toArray() as any[];
              verifyAcceptedAny = decisions.length > 0;
              verifyAcceptedOnHead = decisions.some((d: any) =>
                (String(d.body_md ?? "") + String(d.meta ?? "")).includes(headSha.slice(0, 9)),
              );
            }

            const commitsBody = await ghGet(`/repos/${repo}/pulls/${prNumber}/commits?per_page=100`);
            const commits = (commitsBody ?? []).map((c: any) => ({
              sha: String(c?.sha ?? ""),
              verified: c?.commit?.verification?.verified === true,
              ts: Date.parse(String(c?.commit?.committer?.date ?? c?.commit?.author?.date ?? "")),
            }));
            const headChecksBody = await ghGet(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`);
            const headChecks = Array.isArray(headChecksBody?.check_runs) ? headChecksBody.check_runs : [];

            const action = decideMergeAction({
              prNumber, prTitle: String(detail?.title ?? pr.title ?? ""),
              headSha, baseVerdict,
              mergeable: detail?.mergeable ?? null,
              mergeStateStatus: detail?.merge_state_status ?? null,
              commits, headChecks, cardStatus,
              verifyAcceptedAny, verifyAcceptedOnHead,
            });

            // ---- PR disposition law (BR#3312/BR#3315) --------------------
            // activity = max(pr.updated_at, last commit ts): reviews/comments
            // and force-pushes bump updated_at, so the PR's own liveness is
            // the newest of the two.
            const lastActivityTs = [
              Date.parse(String(pr.updated_at ?? "")),
              ...commits.map((c: any) => Number(c?.ts)),
            ].filter(Number.isFinite).reduce<number | null>((m, t) => (m == null || t > m ? t : m), null);
            const prCreatedRaw = Date.parse(String(pr.created_at ?? ""));
            const prCreatedAt = Number.isFinite(prCreatedRaw) ? prCreatedRaw : null;

            // card advancing = in flight with a clock: in_progress/in_review
            // only while the card itself is recently updated (a dead session's
            // card ages out of the shield), blocked only with a park stamped
            // within the stale window (a live unblock condition).
            let cardAdvancing = false;
            let cardOwner: string | null = null;
            let cardTerminalNote: string | null = null;
            if (card) {
              cardOwner = card.owner ? String(card.owner) : null;
              const cmeta = JSON.parse(String(card.meta ?? "{}"));
              const cardUpdated = Number(card.updated_ts ?? 0);
              const windowMs = prStaleDays * 86_400_000;
              if (cardStatus === "in_progress" || cardStatus === "in_review")
                cardAdvancing = cardUpdated > 0 && now - cardUpdated <= windowMs;
              else if (cardStatus === "blocked") {
                const parkTs = Number(cmeta?.blocked?.ts ?? 0);
                cardAdvancing = parkTs > 0 && now - parkTs <= windowMs;
              }
              cardTerminalNote = cmeta?.superseded_reason ? String(cmeta.superseded_reason) : null;
            }

            // provenance: a RESOLVABLE bridge record — the linked card row, or
            // the BR#3287 index (a re-opened formerly-merged PR keeps its row).
            // A BR#-text ref whose card row is gone is absence, not provenance.
            const hasProvenance = card != null
              || !!this.one(`SELECT merge_sha FROM provenance WHERE repo = ? AND pr = ?`, repo, prNumber);

            // escalation episode state, deduped per PR (settings stamp with ts)
            const escKey = `pr_escalated_${repo}_${prNumber}`;
            let escalatedAt: number | null = null;
            let escalationAskId: string | null = null;
            const escRaw = this.settingValue(escKey, "");
            if (escRaw) {
              try {
                const p = JSON.parse(escRaw);
                escalatedAt = Number(p?.ts) || null;
                escalationAskId = p?.ask_id ? String(p.ask_id) : null;
              } catch { escalatedAt = Number(escRaw) || null; }
            }
            const activitySinceEscalation = escalatedAt != null && lastActivityTs != null && lastActivityTs > escalatedAt;
            if (escalatedAt != null && activitySinceEscalation) {
              // owner responded — the episode is resolved, the clock resets
              this.state.storage.sql.exec(`DELETE FROM settings WHERE key = ?`, escKey);
              if (linked) sweepNote(linked, `PR #${prNumber}: owner responded after the escalation — episode resolved, stale clock reset`);
            }

            let disposition: PrDisposition | null = null;
            if (prDispositionEnabled) {
              disposition = decidePrDisposition({
                gate: action, repo, prNumber, now,
                lastActivityTs, cardId: linked, cardStatus, cardAdvancing,
                hasProvenance, prCreatedAt, cardTerminalNote,
                escalatedAt, escalationAskId, activitySinceEscalation,
                prStaleDays, prOrphanDays, prGraceHours,
              });
              if (disposition.kind === "close_superseded" && action.kind !== "close_superseded") {
                // done/rejected card — the law closes what the gate skipped quietly
                await closeWithReason(repo, prNumber, `PR closed by the merge sweep (terminal-state law BR#3312): ${disposition.reason}`, linked);
                results.push({ repo, pr: prNumber, kind: "close_superseded" });
                this.audit("system:merge-sweep", "close_superseded", linked, { repo, pr: prNumber, cause: "card_terminal" });
                continue;
              }
              if (disposition.kind === "close_orphan") {
                await closeWithReason(repo, prNumber, `PR closed by the merge sweep (terminal-state law BR#3312): ${disposition.reason}`, linked);
                results.push({ repo, pr: prNumber, kind: "close_orphan" });
                continue;
              }
              if (disposition.kind === "close_stale") {
                await closeWithReason(repo, prNumber, `PR closed by the merge sweep (terminal-state law BR#3312): ${disposition.reason}`, linked);
                results.push({ repo, pr: prNumber, kind: "close_stale" });
                // the card keeps the work's intent as unclaimed todo — PRs are
                // reopenable, the deliverable outlives its vehicle
                if (linked && card && !["done", "superseded", "rejected", "todo"].includes(cardStatus)) {
                  try {
                    await this.transition(
                      { id: linked, to: "todo", note: `PR #${prNumber} closed by the merge sweep (stale) — work intent stays here as unclaimed todo; revive by re-opening or re-submitting a PR. (${disposition.reason.slice(0, 200)})` },
                      "system:merge-sweep",
                    );
                  } catch (e) {
                    this.audit("system:merge-sweep", "release_card_error", linked, { error: String((e as Error).message ?? e).slice(0, 200) });
                  }
                }
                continue;
              }
              if (disposition.kind === "escalate" && linked && card) {
                const to = cardOwner && isValidAskTarget(cardOwner) && !/^(web|system)/.test(cardOwner) ? cardOwner : "any";
                const created = await this.askCreate(
                  {
                    to,
                    urgency: "normal",
                    question: disposition.question,
                    details: [
                      `**Merge-sweep escalation (terminal-state law BR#3312 — one bound ask per staleness episode).**`,
                      ``,
                      `- PR: https://github.com/${repo}/pull/${prNumber}`,
                      `- card: ${linked} (${cardStatus ?? "no row"}${cardAdvancing ? ", advancing" : ", not advancing"})`,
                      `- last PR activity: ${lastActivityTs != null ? new Date(lastActivityTs).toISOString() : "unknown"} (> ${prStaleDays}d ago)`,
                      ``,
                      `Do one of: **merge** (it is verified/merge-ready), **rebase** (freshen the head), or **close the PR with a reason** — within ${prGraceHours}h. On silence the sweep closes the PR with a reason citing this ask; the card keeps the work's intent as unclaimed todo and the PR is reopenable.`,
                    ].join("\n"),
                    reason: "merge-sweep escalation: PR stale past pr_stale_days with the card not advancing — one bound ask, then close-with-reason",
                    options: ["Merging/rebasing now", "Closing with reason", "Release the card — not mine"],
                    artefact_id: linked,
                  },
                  "system:merge-sweep",
                );
                this.state.storage.sql.exec(
                  `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
                  escKey, JSON.stringify({ ts: now, ask_id: created.id }),
                );
                sweepNote(linked, `${disposition.reason} — escalation ${created.id} filed on ${to}`);
                results.push({ repo, pr: prNumber, kind: "escalate", ask: created.id });
                this.audit("system:merge-sweep", "escalate", linked, { repo, pr: prNumber, ask: created.id, to });
                continue;
              }
              // merge | bounce | passthrough → the pre-law arms below (unchanged)
            }

            if (action.kind === "merge") {
              const method = methods[repo] === "squash" ? "squash" : "merge";
              const mergeRes = await fetch(`${base}/repos/${repo}/pulls/${prNumber}/merge`, {
                method: "PUT",
                headers: {
                  authorization: `Bearer ${token}`,
                  accept: "application/vnd.github+json",
                  "content-type": "application/json",
                  "user-agent": "bridge-merge-sweep (BR#3198)",
                },
                body: JSON.stringify({ merge_method: method }),
              });
              if (mergeRes.ok) {
                const merged = await mergeRes.json().catch(() => ({}));
                const receipt = `${action.receipt} — mergeCommit ${String((merged as any)?.sha ?? "unknown").slice(0, 9)}`;
                if (linked) sweepNote(linked, receipt);
                results.push({ repo, pr: prNumber, kind: "merge", sha: String((merged as any)?.sha ?? "").slice(0, 9) });
                this.audit("system:merge-sweep", "merge", linked, { repo, pr: prNumber, method, receipt: receipt.slice(0, 300) });
              } else if (mergeRes.status === 405 || mergeRes.status === 409) {
                // GitHub raced us: no longer mergeable — bounce like any mechanical defect
                const defect = `PR #${prNumber} merge refused by GitHub (HTTP ${mergeRes.status}) — no longer mergeable/clean. Rebase, resolve, re-push, re-enter the queue`;
                if (linked && cardStatus === "in_review") await this.transition({ id: linked, to: "in_progress", note: defect }, "system:merge-sweep");
                else if (linked) sweepNote(linked, defect);
                results.push({ repo, pr: prNumber, kind: "bounce", defect });
              } else {
                throw new Error(`merge PUT -> HTTP ${mergeRes.status}`);
              }
            } else if (action.kind === "close_superseded") {
              const close = await fetch(`${base}/repos/${repo}/issues/${prNumber}`, {
                method: "PATCH",
                headers: {
                  authorization: `Bearer ${token}`,
                  accept: "application/vnd.github+json",
                  "content-type": "application/json",
                  "user-agent": "bridge-merge-sweep (BR#3198)",
                },
                body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
              });
              if (close.ok) {
                if (linked) sweepNote(linked, `${action.reason} — PR #${prNumber} closed by the merge sweep (superseded-check first)`);
                results.push({ repo, pr: prNumber, kind: "close_superseded" });
                this.audit("system:merge-sweep", "close_superseded", linked, { repo, pr: prNumber });
              } else throw new Error(`close PATCH -> HTTP ${close.status}`);
            } else if (action.kind === "bounce") {
              if (linked && cardStatus === "in_review") {
                await this.transition({ id: linked, to: "in_progress", note: action.defect }, "system:merge-sweep");
              } else if (linked) {
                sweepNote(linked, action.defect);
              }
              results.push({ repo, pr: prNumber, kind: "bounce", defect: action.defect });
              this.audit("system:merge-sweep", "bounce", linked, { repo, pr: prNumber, defect: action.defect.slice(0, 300) });
            } else if (action.kind === "note") {
              if (linked) sweepNote(linked, action.reason);
              results.push({ repo, pr: prNumber, kind: "note" });
            } else if (action.kind === "human_leg") {
              humanLegs.push(action.reason);
              results.push({ repo, pr: prNumber, kind: "human_leg" });
            } else {
              // skip: quiet, no note spam — but the audit trail keeps it honest
              this.audit("system:merge-sweep", "skip", linked, { repo, pr: prNumber, reason: action.reason.slice(0, 300) });
              results.push({ repo, pr: prNumber, kind: "skip", reason: action.reason.slice(0, 120) });
            }
          } catch (e) {
            // one PR's failure must never stop the sweep — log and move on
            this.audit("system:merge-sweep", "pr_error", null, { repo, pr: prNumber, error: String((e as Error).message ?? e).slice(0, 300) });
            results.push({ repo, pr: prNumber, kind: "pr_error", error: String((e as Error).message ?? e).slice(0, 120) });
          }
        }

        // human legs → ONE class ask per repo per episode (rule 5c), deduped
        if (humanLegs.length) {
          const sinkId = this.settingValue("merge_sweep_artefact_id", "BR#3198");
          const title = mergeSweepHumanLegTitle(repo, humanLegs);
          const dup = this.one(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
               AND c.type = 'question' AND c.title = ? LIMIT 1`,
            sinkId, title.slice(0, 200),
          );
          if (dup) {
            this.audit("system:merge-sweep", "human_leg_dupe", String(dup.id), { repo, legs: humanLegs.slice(0, 5) });
          } else {
            const created = await this.askCreate(
              {
                to: "rayh",
                urgency: "normal",
                question: title,
                details: [
                  `**Human-leg merge blockers (BR#3198 class ask — one ask per class, never per PR).**`,
                  ``,
                  ...humanLegs.map((r) => `- ${r}`),
                  ``,
                  `_These are the only defects the standing merge sweep (BR#3198) cannot resolve autonomously. Everything mechanical was bounced with the exact defect on the linked card._`,
                ].join("\n"),
                reason: "merge sweep collected human-leg defects into the single class ask per rule 5c",
                options: ["Acknowledge — on it", "Redirect the class"],
                artefact_id: sinkId,
              },
              "system:merge-sweep",
            );
            this.audit("system:merge-sweep", "human_leg_ask", String(created.id), { repo, legs: humanLegs.slice(0, 5) });
            results.push({ repo, pr: null, kind: "human_leg_ask", ask: created.id });
          }
        }
      } catch (e) {
        this.audit("system:merge-sweep", "repo_error", null, { repo, error: String((e as Error).message ?? e).slice(0, 300) });
        results.push({ repo, pr: null, kind: "repo_error", error: String((e as Error).message ?? e).slice(0, 120) });
      }
    }

    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('merge_sweep_last', ?)`,
      JSON.stringify({
        ts: now,
        merged: results.filter((r) => r.kind === "merge").length,
        bounced: results.filter((r) => r.kind === "bounce").length,
        closed: results.filter((r) => r.kind === "close_superseded").length,
        escalated: results.filter((r) => r.kind === "escalate").length,
        closed_orphan: results.filter((r) => r.kind === "close_orphan").length,
        closed_stale: results.filter((r) => r.kind === "close_stale").length,
        human_legs: results.filter((r) => r.kind === "human_leg").length,
        skipped: results.filter((r) => r.kind === "skip").length,
        results: results.slice(0, 50),
      }),
    );
    const summary = results.filter((r) => ["merge", "bounce", "close_superseded", "close_orphan", "close_stale", "escalate", "human_leg_ask"].includes(r.kind));
    if (summary.length)
      this.audit("system:merge-sweep", "sweep", null, { repos, n: summary.length, actions: summary.slice(0, 20) });
  }

  async eventsSince(since: number, limit: number) {
    // since=0 → the most recent window (newest first, returned oldest-first);
    // since>0 → incremental forward from the cursor.
    const rows = since > 0
      ? this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
          since, limit,
        ).toArray()
      : this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > 0 ORDER BY seq DESC LIMIT ?`,
          limit,
        ).toArray().reverse();
    const events = rows.map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    return { events, last_seq: events.length ? events[events.length - 1].seq : since };
  }

  async board() {
    const tasks = this.state.storage.sql.exec(
      `SELECT id, type, title, status, owner, tags, roles, meta, body_md, status_ts, created_ts, updated_ts, project FROM artefacts
       WHERE type IN ('task','question') ORDER BY updated_ts DESC LIMIT 200`,
    ).toArray().map((t: any) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // flat structure, relations only: child tasks carry part_of, parents get a rollup
    const links = this.state.storage.sql.exec(
      `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`,
    ).toArray();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const parentOf = new Map(links.map((l: any) => [l.src_id, l.dst_id]));
    for (const t of tasks) {
      const parent = parentOf.get(t.id);
      if (parent) t.part_of = parent;
      t.children_open = 0;
      t.children_done = 0;
    }
    for (const l of links as any[]) {
      const parent = byId.get(l.dst_id);
      const child = byId.get(l.src_id);
      if (!parent || !child) continue;
      if (child.status === "done" || child.status === "superseded") parent.children_done++;
      else parent.children_open++;
    }
    // readiness projection (bulk): declared state + evidence maps + stacked bars
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    for (const t of tasks) {
      const q = t.meta.qualification ?? {};
      const declared = q.state ?? (t.meta.qualified === true ? "qualified" : undefined);
      const bars: string[] = q.bars ?? [];
      const parent = t.part_of ? byId.get(t.part_of) : null;
      const pq = parent ? (parent.meta.qualification ?? {}) : {};
      const analysisOk = declared === "qualified"
        || analysisEv.has(t.id)
        || (parent && (pq.state === "qualified" || parent.meta.qualified === true || analysisEv.has(parent.id))) === true;
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      t.qualification = { state: declared ?? (analysisOk ? "qualified" : "open"), how: q.how, by: q.by, bars, unmet_bars: unmet, ready: analysisOk && unmet.length === 0 };
      // claimability projection — same semantics as orient's pool: question
      // tasks and operator gates are never dispatchable; role-tagged tasks
      // dispatch via their gateway; the rest needs qualification evidence.
      const tagsArr: string[] = t.tags ?? [];
      const roleTagged = (t.roles ?? []).some((x: string) => ["analysis", "review", "impl", "unblock"].includes(x));
      const isQ = t.type === "question";
      const gated = t.meta.operator_gated;
      const roleWorkReady = roleTagged && t.qualification.ready !== false ? true : roleTagged;
      t.is_claimable = t.status === "todo" && !isQ && !gated && (roleWorkReady || t.qualification.ready !== false);
      if (!t.is_claimable && t.status === "todo") {
        t.claim_reason = isQ
          ? "question — answered, not claimed (contribute via log_progress)"
          : gated
            ? `operator gated: ${gated} — a human clears the gate`
            : roleTagged ? "" : "needs qualification — a done analysis child, an accepted decision, or the publisher's declaration";
      }
    }
    const sessions = this.state.storage.sql.exec(
      `SELECT s.token_id, s.name, s.worktree, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`,
    ).toArray();
    // open question children: the DERIVED source for awaiting_ask (phase 4 —
    // the marker was a second source of truth that could drift)
    const openAskChildren = this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta
       FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question'
       ORDER BY c.created_ts DESC`,
    ).toArray();
    const askChildOf = new Map<string, any>();
    for (const c of openAskChildren as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const progress = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`,
    ).toArray().map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    const series = this.state.storage.sql.exec(
      `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`,
    ).toArray().map((v: any) => {
      const d = JSON.parse(v.data ?? "{}");
      return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
    });
    return { tasks, sessions, progress, series, agents: this.agentScores() };
  }

  /** Blocker rollup (BR#2645): cluster the blocked cards by machine root key
   *  (rollup.ts) and execute the plan — create ONE boosted ROOT BLOCKER task
   *  per qualifying cluster (≥3 members, no open root for the key), stamp the
   *  queued cards (meta.root_blocker + child_of → board tree + boost cascade).
   *  Idempotent: the plan only stamps cards whose pointer changed, so a re-run
   *  creates no duplicates. Roots close only by agent/human with receipts;
   *  done roots are never reused — a later cluster opens a fresh root. */
  private async rootBlockerRollup(now: number): Promise<{ created: string[]; stamped: number }> {
    const blockedRows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    const cards = blockedRows.map((r) => {
      const meta = JSON.parse(r.meta ?? "{}");
      return { id: r.id, title: r.title, blocked: meta.blocked ?? null, root_blocker: meta.root_blocker ?? null };
    });
    const rootRows = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND tags LIKE ?`,
      `%"${ROOT_BLOCKER_TAG}"%`,
    ).toArray() as any[];
    const roots = rootRows.map((r) => ({ id: r.id, status: r.status, root_key: JSON.parse(r.meta ?? "{}").root_key ?? null }));
    const plan = planRootBlockers(cards, roots);
    const created: string[] = [];
    if (plan.creates.length || plan.stamps.length) {
      const keyToRoot = new Map<string, string>();
      for (const c of plan.creates) {
        try {
          const members = cards.filter((x) => c.members.includes(x.id));
          const res: any = await this.create(
            {
              type: "task",
              title: rootBlockerTitle(c.key, c.members.length),
              body_md: rootBlockerBody(c.key, members),
              tags: [ROOT_BLOCKER_TAG],
              // the sweep HAS analysed the cluster — the root is ready for pickup
              qualified: true,
              meta: { root_key: c.key },
            },
            "system:watchdog",
          );
          if (res?.id) { keyToRoot.set(c.key, res.id); created.push(res.id); }
          this.audit("system:watchdog", "root_blocker_created", res?.id ?? null, { key: c.key, members: c.members });
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `root_blocker:${c.key}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      let stamped = 0;
      for (const s of plan.stamps) {
        try {
          const rootId = s.root ?? keyToRoot.get(s.root_key);
          if (!rootId) continue;
          const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, s.id);
          if (!row) continue;
          const meta = JSON.parse(row.meta ?? "{}");
          if (meta.root_blocker === rootId) continue; // stamp only when changed
          meta.root_blocker = rootId;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(meta), now, s.id,
          );
          // child_of → board tree + boost cascade. Best-effort: the nesting
          // cap and relation limits can reject; the stamp alone still counts.
          const linked = this.one(
            `SELECT 1 AS x FROM relations WHERE src_id = ? AND relation = 'child_of' AND dst_id = ?`,
            s.id, rootId,
          );
          if (!linked) {
            try {
              await this.link({ src: s.id, relation: "child_of", dst: rootId }, "system:watchdog");
            } catch (e) {
              this.audit("system:watchdog", "rollup_link_rejected", s.id, { root: rootId, error: String((e as Error).message ?? e).slice(0, 200) });
            }
          }
          stamped++;
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", s.id, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      // boost the NEW roots — cascades to every linked open card (priority 0)
      for (const rootId of keyToRoot.values()) {
        try {
          await this.boost({ id: rootId, boost: true }, "system:watchdog");
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `boost:${rootId}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      if (created.length || stamped) {
        this.audit("system:watchdog", "root_blocker_rollup", null, { created, stamped });
      }
      return { created, stamped };
    }
    return { created: [], stamped: 0 };
  }

  /** Behaviour signals per agent over the trailing 7-day window, scored via scoreAgent().
   *  Cached per-isolate (30s TTL) — it fans out to several table scans per call and
   *  runs on every board/orient/log_progress; uncached it eats the DO row-read quota. */
  private scoreCache: { at: number; rows: Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> } | null = null;
  private agentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    const now = Date.now();
    if (this.scoreCache && now - this.scoreCache.at < 30_000) return this.scoreCache.rows;
    const rows = this.computeAgentScores();
    this.scoreCache = { at: now, rows };
    return rows;
  }

  private computeAgentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    // Scoring windows (BR#3226): positive behavioural signals accrue over a
    // 7-day window; watchdog penalties (abandonment, reassignment) are
    // point-in-time incidents that decay after 48h so a past incident does
    // not poison current behaviour scores (e.g. the 2026-10-22 outage era).
    const weekTs = Date.now() - 7 * 24 * 60 * 60_000;
    const recentTs = Date.now() - 48 * 60 * 60_000;
    const tokens = this.state.storage.sql.exec(
      `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`,
    ).toArray() as any[];
    const signals = new Map<string, AgentSignals>();
    const sig = (label: string): AgentSignals => {
      let s = signals.get(label);
      if (!s) {
        s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 };
        signals.set(label, s);
      }
      return s;
    };
    for (const t of tokens) sig(t.label); // agents with no activity still get a row
    for (const p of this.state.storage.sql.exec(
      `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
      weekTs,
    ).toArray() as any[]) {
      const s = sig(p.actor);
      const d = JSON.parse(p.data ?? "{}");
      s.progress_count++;
      if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
      if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT a.owner AS owner, COUNT(*) AS n FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ? GROUP BY a.owner`,
      recentTs,
    ).toArray() as any[]) sig(r.owner || "unknown").abandoned += r.n;
    for (const r of this.state.storage.sql.exec(
      `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`, recentTs,
    ).toArray() as any[]) {
      const d = JSON.parse(r.detail ?? "{}");
      sig(d.prev_owner || "unknown").reassigned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
      weekTs,
    ).toArray() as any[]) sig(r.owner).artefacts_created += r.n;
    for (const t of tokens) {
      const s = sig(t.label);
      const tags: string[] = parseTags(t.tags);
      const targets = ["any", t.label, ...tags.map((x: string) => `tag:${x}`)];
      const marks = targets.map(() => "?").join(",");
      s.asks_received = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`, t.label, weekTs, ...targets,
      )?.n ?? 0;
      s.asks_answered_on_time = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 60_000} AND created_ts >= ?`, t.label, weekTs,
      )?.n ?? 0;
      // verification duty backlog: role:review agents carry the pool's stalled
      // verify rounds — each one is an implementer parked in in_review.
      if (tags.includes("role:review")) {
        s.verify_duty_backlog = this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
           AND c.roles LIKE '%"review"%' AND p.status = 'in_review'`,
        )?.n ?? 0;
      }
    }
    return [...signals.entries()]
      .filter(([label]) => !/^(system:|web$)/.test(label))
      .map(([label, s]) => ({ label, ...s, ...scoreAgent(s) }))
      .sort((a, b) => b.score - a.score);
  }

  private async getWithRelations(id: string) {
    const a = await this.get(id);
    const rel = await this.relations(id);
    return { ...a, relations: rel.relations };
  }

  async ensureSchema() {
    // NO early-return flag: this DO's isolate is long-lived, and a flag set
    // on first boot meant every migration added later NEVER ran on the warm
    // singleton — today's schema additions silently broke against production
    // while working on fresh local DBs. Everything here is idempotent by
    // construction (IF NOT EXISTS + guarded ALTERs); the per-fetch cost is a
    // few cheap statements.
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS artefacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        owner TEXT NOT NULL DEFAULT '',
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        src_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (src_id, relation, dst_id)
      );
      -- events: now a VIEW over ledger (migration below)
      CREATE VIRTUAL TABLE IF NOT EXISTS artefacts_fts USING fts5(
        title, body_md, content='artefacts', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS artefacts_ai AFTER INSERT ON artefacts BEGIN
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_ad AFTER DELETE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_au AFTER UPDATE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        tags TEXT NOT NULL DEFAULT '[]',
        principal TEXT,
        transport TEXT NOT NULL DEFAULT 'mcp',
        created_ts INTEGER NOT NULL,
        last_seen_ts INTEGER,
        revoked_ts INTEGER
      );
      -- gateway → dispatched-agent attribution (BR#2455): stamped whenever a
      -- gateway-tagged token claims/progresses as an agent. Feeds Connect's
      -- "gateways with their agents" grouping; audit stays the full trail.
      CREATE TABLE IF NOT EXISTS gateway_agents (
        gateway TEXT NOT NULL,
        agent TEXT NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        PRIMARY KEY (gateway, agent)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        name TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        UNIQUE (token_id, name)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        personal INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        ws TEXT NOT NULL,
        login TEXT NOT NULL,
        UNIQUE (ws, login)
      );
      CREATE TABLE IF NOT EXISTS ws_tokens (
        hash TEXT PRIMARY KEY,
        ws TEXT NOT NULL,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        code TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        type TEXT,
        principal TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ws TEXT,
        label TEXT,
        tags TEXT,
        secret TEXT,
        created_ts INTEGER NOT NULL,
        approved_ts INTEGER,
        last_poll_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        artefact_id TEXT PRIMARY KEY,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS provenance (
        -- PR provenance (BR#3287): sha → PR → task → verify-verdict → agent
        -- session. Board-side storage of record (decision BR#3291); this
        -- table is the DO-local index the lookup endpoint reads.
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        merge_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        task_id TEXT,
        verdict_id TEXT,
        session TEXT,
        signer TEXT NOT NULL,
        merged_at INTEGER NOT NULL,
        stamped_at INTEGER NOT NULL,
        PRIMARY KEY (repo, pr)
      );
      -- artefact_versions: now a VIEW over ledger (migration below)
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        from_label TEXT NOT NULL,
        to_target TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        created_ts INTEGER NOT NULL,
        answered_ts INTEGER
      );
    `);

    // additive columns for DBs created before these existed
    for (const ddl of [
      `ALTER TABLE decisions ADD COLUMN options TEXT`,
      `ALTER TABLE decisions ADD COLUMN urgency TEXT`,
      `ALTER TABLE decisions ADD COLUMN deadline_ts INTEGER`,
      `ALTER TABLE decisions ADD COLUMN asker TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN transport TEXT`,
      `ALTER TABLE artefacts ADD COLUMN status_ts INTEGER`,
      `ALTER TABLE artefacts ADD COLUMN tags TEXT`,
      `ALTER TABLE artefacts ADD COLUMN roles TEXT`,
      `ALTER TABLE embeddings ADD COLUMN dim INTEGER DEFAULT 0`,
      `ALTER TABLE asks ADD COLUMN artefact_id TEXT`,
      `ALTER TABLE artefacts ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE artefacts ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE pairings ADD COLUMN type TEXT`,
      `ALTER TABLE pairings ADD COLUMN principal TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN principal TEXT`,
      `ALTER TABLE sessions ADD COLUMN kind TEXT`,
      `ALTER TABLE sessions ADD COLUMN worktree TEXT`, // BR#3204: where the session's tree lives — board collision visibility
    ]) {
      try { this.state.storage.sql.exec(ddl); } catch { /* column exists */ }
    }

    // ---------- ledger v1: one append-only record (events + versions merged) ----------
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'signal',
      action TEXT NOT NULL,
      artefact_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}'
    )`);
    try {
      const migrated = this.one(`SELECT value FROM settings WHERE key = 'ledger_v1'`);
      if (!migrated) {
        const hasEvents = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'events'`);
        if (hasEvents) {
          this.state.storage.sql.exec(`ALTER TABLE events RENAME TO events_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'signal', op, artefact_id, '', detail FROM events_legacy`);
        }
        const hasVersions = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'artefact_versions'`);
        if (hasVersions) {
          this.state.storage.sql.exec(`ALTER TABLE artefact_versions RENAME TO versions_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'mutation', action, artefact_id, summary, data FROM versions_legacy`);
        }
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ledger_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "ledger_v1", null, { backfilled: !!(hasEvents || hasVersions) });
      } else {
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
      }
    } catch (e) {
      console.log("ledger migration:", String(e).slice(0, 200));
    }

    // sessions.kind backfill: gateway identity via the local token registry
    try {
      this.state.storage.sql.exec(
        `UPDATE sessions SET kind = 'gateway' WHERE kind IS NULL AND token_id IN
          (SELECT id FROM auth_tokens WHERE tags LIKE '%gateway%')`,
      );
    } catch { /* fresh db */ }

    // ---------- asks v2: open legacy asks become question nodes ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_v2'`)) {
        const legacy = this.state.storage.sql.exec(
          `SELECT id, from_label, to_target, question, created_ts, artefact_id FROM asks WHERE status = 'open'`,
        ).toArray() as any[];
        let n = 0;
        for (const a of legacy) {
          const created = await this.create(
            {
              type: "question",
              title: String(a.question ?? "").slice(0, 200),
              body_md: String(a.question ?? ""),
              owner: "",
              meta: { ask: { to: a.to_target ?? "any", from: a.from_label ?? "agent", urgency: "normal", options: [], artefact_id: a.artefact_id || undefined, legacy_id: a.id } },
            },
            "system:migration",
          );
          if (a.artefact_id) {
            const subj = this.one(`SELECT id, meta FROM artefacts WHERE id = ?`, a.artefact_id);
            if (subj) {
              this.state.storage.sql.exec(
                `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                created.id, a.artefact_id, Date.now(),
              );
              const sm = JSON.parse(subj.meta ?? "{}");
              if (sm.awaiting_ask?.ask_id === a.id) sm.awaiting_ask = { ...sm.awaiting_ask, ask_id: created.id };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), a.artefact_id);
            }
          }
          this.state.storage.sql.exec(
            `UPDATE artefacts SET created_ts = ? WHERE id = ?`, Number(a.created_ts ?? Date.now()), created.id,
          );
          this.state.storage.sql.exec(`UPDATE asks SET status = 'migrated' WHERE id = ?`, a.id);
          this.audit("system:migration", "ask_migrated", a.artefact_id || null, { legacy: a.id, node: created.id });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_v2', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "asks_v2", null, { migrated: n });
      }
    } catch (e) {
      console.log("asks_v2 migration:", String(e).slice(0, 200));
    }


    // ---------- asks options backfill: no ask ships button-less ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_options_v1'`)) {
        const nodes = this.state.storage.sql.exec(
          `SELECT id, title, body_md, meta FROM artefacts
           WHERE status NOT IN ('done','superseded') AND (type = 'question' OR (type = 'task' AND tags LIKE '%question%'))`,
        ).toArray() as any[];
        let n = 0;
        for (const node of nodes) {
          const m = JSON.parse(node.meta ?? "{}");
          // legacy-migrated asks: their content is prose — do NOT fabricate
          // options for them (the human answers free-text or reframes)
          if (m.ask?.legacy_id) continue;
          if (!m.ask || (Array.isArray(m.ask.options) && m.ask.options.length >= 2)) continue;
          const text = `${node.title ?? ""} ${node.body_md ?? ""}`;
          let opts: string[] = [];
          // enumerated questions carry their own answers: "(a) … (b) …"
          const parts = text.split(/\([A-Da-d1-4]\)\s+/).map((x: string) => x.trim());
          if (parts.length >= 3) {
            opts = parts.slice(1, 5).map((x: string) => {
              const cut = x.split(/\s+(?:vs\.?|or|—|--)\s+/i)[0];
              return cut.replace(/\s*\n\s*/g, " ").slice(0, 140).trim();
            }).filter((x: string) => x.length >= 2);
          }
          if (opts.length < 2) {
            opts = /GO\/NO-GO|GO or NO-GO|merge GO/i.test(text)
              ? ["GO — proceed as stated", "NO-GO — hold, reason in comment"]
              : ["Approved — proceed as stated", "Hold — reason in comment"];
          }
          m.ask = { ...(m.ask ?? {}), options: opts.slice(0, 4) };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), node.id);
          this.version(node.id, "system:migration", "update", `ask options backfilled (${m.ask.options.length})`, { options: m.ask.options });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_options_v1', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "ask_options_backfilled", null, { nodes: n });
      }
    } catch (e) {
      console.log("asks options backfill:", String(e).slice(0, 200));
    }


    // ---------- tags v1: canonical encoding (defence in depth, SOLID) ----------
    // The tags column historically holds JSON arrays, bare strings and comma
    // lists — parseTags() reads them all, but every SQL tag filter guessed one
    // encoding and silently missed the others. Re-encode EVERYTHING through
    // parseTags (artefacts + auth_tokens); canonical rows write canonical
    // JSON. Reads stay parseTags(); tag SQL filters are now correct forever.
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'tags_v1'`)) {
        let fixed = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM artefacts`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE artefacts SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM auth_tokens`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE auth_tokens SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT token_id, name, kind FROM sessions WHERE kind IS NULL OR kind = ''`).toArray() as any[]) {
          const tok = this.one(`SELECT tags FROM auth_tokens WHERE id = ?`, r.token_id);
          if (tok && parseTags(tok.tags).includes("gateway")) {
            this.state.storage.sql.exec(`UPDATE sessions SET kind = 'gateway' WHERE token_id = ? AND name = ?`, r.token_id, r.name);
            fixed++;
          }
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tags_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "tags_v1", null, { canonicalized: fixed });
      }
    } catch (e) {
      console.log("tags_v1 migration:", String(e).slice(0, 200));
    }

    // ---------- roles_v1: system semantics leave the tag namespace (BR#2983) ----------
    // Tags become 100% inert user labels. Three system meanings move out:
    //   role:* tags      → the roles column (bare names: ["review"])
    //   "question" tag   → type = 'question' (asks v2 nodes)
    //   "attempted" tag  → meta.attempt only (backfilled where missing)
    // The per-row transform is splitSystemTags() in core.ts — unit-tested
    // against every legacy encoding. Idempotent (settings key).
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'roles_v1'`)) {
        let roleRows = 0, questionRows = 0, attemptRows = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, type, tags, meta, updated_ts FROM artefacts`).toArray() as any[]) {
          const tags: string[] = parseTags(r.tags);
          if (!tags.length) continue;
          const meta = JSON.parse(r.meta ?? "{}");
          const out = splitSystemTags(String(r.type ?? ""), tags, meta, Number(r.updated_ts ?? Date.now()));
          if (!out.changed) continue;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET type = ?, tags = ?, roles = ?, meta = ? WHERE id = ?`,
            out.type, out.tags.length ? JSON.stringify(out.tags) : null,
            out.roles.length ? JSON.stringify(out.roles) : null,
            JSON.stringify(out.meta), r.id,
          );
          if (out.roles.length) roleRows++;
          if (out.type !== r.type) questionRows++;
          if (tags.includes("attempted")) attemptRows++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('roles_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "roles_v1", null, { role_rows: roleRows, question_rows: questionRows, attempt_rows: attemptRows });
      }
    } catch (e) {
      console.log("roles_v1 migration:", String(e).slice(0, 200));
    }

    // work enters as UNCLAIMED todo — release currently-todo tasks from their creators
    const projectName = this.settingsMap().project_name || "superpositional";
    this.state.storage.sql.exec(
      `UPDATE artefacts SET project = ? WHERE project = '' AND type = 'task'`, projectName,
    );
    this.state.storage.sql.exec(`UPDATE artefacts SET owner = '' WHERE type = 'task' AND status = 'todo' AND owner != ''`);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    // alarm health: null = not scheduled; a timestamp far in the PAST = a stale
    // alarm the runtime dropped without invoking (observed live: getAlarm stuck
    // 42h in the past, so this arm-guard never re-armed and the watchdog went
    // silent for a day). Either way, arm a fresh tick.
    const alarmAt = await this.state.storage.getAlarm();
    if (alarmAt === null || alarmAt < Date.now()) {
      await this.state.storage.setAlarm(Date.now() + 15_000);
    }
    const url = new URL(request.url);

    // realtime: hibernating WS fanout of audit events
    if (url.pathname === "/ws") return this.handleWs(request);

    // machine-plane self-rename: the bearer token renames its own label.
    // The runner sends its hostname at pair/start and the pair page pre-fills
    // the label from it — but if the approver overrode the label with a
    // gateway name, the agent can fix its own identity without re-pairing.
    // Same write-law as mint (BR#2455): charset, uniqueness, and the gw-*
    // class boundary — a token can never rename across the class line.
    if (url.pathname === "/token.self_revoke") {
      const body: any = await request.json();
      let identity;
      try {
        identity = await this.identify(String(body.bearer ?? ""));
      } catch {
        // unknown or already-revoked: the requested end-state already holds
        return this.json({ ok: true, revoked: null });
      }
      this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), identity.token_id);
      this.audit(identity.label, "self_revoke", identity.token_id, {});
      return this.json({ ok: true, revoked: identity.label });
    }
    if (url.pathname === "/token.rename") {
      const body: any = await request.json();
      const identity = await this.identify(String(body.bearer ?? ""));
      const newLabel = String(body.label ?? "").trim();
      if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(newLabel)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
      const old = this.one(`SELECT label, tags FROM auth_tokens WHERE id = ?`, identity.token_id);
      if (!old) throw new Error("auth token not found");
      if (newLabel !== old.label) {
        if (this.one(`SELECT id FROM auth_tokens WHERE label = ?`, newLabel)) throw new Error(`label '${newLabel}' already exists`);
      }
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET label = ? WHERE id = ?`,
        newLabel, identity.token_id,
      );
      // tasks owned by the old label are NOT reassigned — the agent can
      // release-and-re-claim them, which is the normal flow. But audit it.
      this.audit(identity.label, "rename", null, { from: old.label, to: newLabel });
      return this.json({ ok: true, from: old.label, to: newLabel });
    }

    // human-plane GET mirror — the same error contract as the POST arm: a
    // rejected read returns 400 with the message, never a naked 500 (the GET
    // arm predates the try/catch; metrics.throughput's param validation was
    // the first GET that could throw on user input and exposed the gap)
    if (request.method === "GET") {
      try {
        switch (url.pathname) {
          case "/artefacts": return this.json(await this.list({ type: url.searchParams.get("type") ?? undefined, status: url.searchParams.get("status") ?? undefined, tag: url.searchParams.get("tag") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/artefact": return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
          case "/search": return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/events": return this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
          case "/board": return this.json(await this.board());
          case "/stats": return this.json(await this.stats());
          case "/metrics.throughput": return this.json(await this.metricsThroughput(url.searchParams));
          case "/provenance": { const b = await this.provenanceLookup(url.searchParams); return b ? this.json(b) : this.json({ error: "no bridge provenance for this sha" }, 404); }
          case "/history": return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
          case "/ask": { const a = await this.askGet(String(url.searchParams.get("id"))); return a ? this.json(a) : this.json({ error: "no such ask" }, 404); }
        }
      } catch (e) {
        return this.json({ error: String((e as Error).message ?? e) }, 400);
      }
    }

    const op = url.pathname.slice(1);
    let body: any = {};
    if (request.method === "POST") body = await request.json();
    const isAdmin = request.headers.get("x-kb-admin") === "1";
    const actor = String(body.actor ?? "mcp");

    try {
      switch (op) {
        case "create": return this.json(await this.create(body, actor));
        case "boost": return this.json(await this.boost(body, actor));
        case "get": return this.json(await this.get(String(body.id)));
        case "list": return this.json(await this.list(body));
        case "search": return this.json(await this.search(body));
        case "provenance": { const rec = await this.provenanceBySha(parseProvenanceSha(new URLSearchParams({ sha: String((body as any)?.sha ?? "") }))); return rec ? this.json(rec) : this.json({ error: "no bridge provenance for this sha", sha: String((body as any)?.sha ?? "") }, 404); }
        case "related": return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
        case "enrich": return this.json(await this.enrich(body, actor));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        case "get_history": return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
        // ---- machine-plane identity + sessions + asks ----
        case "auth.identify": return this.json(await this.identify(String(body.bearer ?? "")));
        case "agent.provision": return this.json(await this.agentProvision(body, actor));
        case "self.provision": return this.json(await this.selfProvision(body, actor));
        case "agents.list": return this.json(await this.listAgents());
        case "session.touch": return this.json(await this.sessionTouch(body));
        case "ask.create": return this.json(await this.askCreate(body, actor));
        case "ask.inbox": return this.json(await this.askInbox(body));
        case "ask.answer": return this.json(await this.askAnswer(body, actor));
        case "ask.get": return this.json(await this.askGet(String(body.id ?? "")));
        case "purge_smoke": return this.json(await this.purgeSmoke(body));
        case "ask.reframe": return this.json(await this.askReframe(body, actor));
        case "orient": return this.json(await this.orient(body));
        case "progress.log": return this.json(await this.progressLog(body, actor));
        case "session.alive": {
          const row = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'task' AND status = 'in_progress'`, String(body.id ?? ""));
          if (!row) return this.json({ ok: false, error: "task not in progress" });
          const meta = JSON.parse(row.meta ?? "{}");
          meta.session_alive_ts = Date.now();
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), row.id);
          return this.json({ ok: true });
        }
        case "settings.public": return this.json({ settings: this.publicSettings() });
        case "bootstrap": {
          const m = this.settingsMap();
          return this.json({
            project_name: m.project_name || "Superpositional",
            instructions: composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD),
          });
        }
        // ---- workspace registry (global DO; human plane, owner-checked) ----
        case "ws.seed": return this.json(await this.wsSeed(body.logins ?? []));
        case "ws.list": return this.json(await this.wsList(String(body.login)));
        case "ws.create": return this.json(await this.wsCreate(body, String(body.login)));
        case "ws.join": return this.json(await this.wsJoin(body, String(body.login)));
        case "ws.members": return this.json(await this.wsMembers(body, String(body.login)));
        case "ws.token_register": return this.json(await this.wsTokenRegister(body));
        case "ws.token_lookup": return this.json(await this.wsTokenLookup(body));
        case "ws.pair.start": return this.json(await this.wsPairStart(body));
        case "ws.pair.get": return this.json(await this.wsPairGet(body));
        case "ws.pair.approve": return this.json(await this.wsPairApprove(body));
        case "ws.pair.poll": return this.json(await this.wsPairPoll(body));
        // ---- admin (human plane only; worker sets x-kb-admin after session auth) ----
        case "admin.mint":
        case "admin.list_tokens":
        case "admin.revoke":
        case "admin.token_tags":
        case "admin.settings_get":
        case "admin.settings_set":
        case "admin.stop_line_sweep":
        case "admin.merge_queue_sweep":
        case "admin.provenance_sweep":
        case "admin.unblock_proxy_sweep":
        case "admin.closure_audit_sweep":
          if (!isAdmin) return this.json({ error: "admin only" }, 403);
          if (op === "admin.mint") return this.json(await this.tokenMint(body));
          if (op === "admin.list_tokens") return this.json(await this.tokenList());
          if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
          if (op === "admin.token_tags") return this.json(await this.tokenTags(body));
          if (op === "admin.settings_get") return this.json(await this.settingsGet());
          if (op === "admin.stop_line_sweep") {
            // drill/liveness path for the destination-green sweep (BR#3008):
            // dedupe still applies; pass now=<future epoch ms> to also bypass
            // the cadence window (the next scheduled sweep waits it out).
            await this.stopTheLineSweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'stop_line_last_sweep_ts'`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
          }
          if (op === "admin.merge_queue_sweep") {
            // bootstrap/dispatch path for the standing merge-queue sweep
            // (BR#3198): pass now=<future epoch ms> to bypass the cadence
            // window and run immediately; identity + dedupe rules apply.
            await this.mergeQueueSweep(Number(body.now ?? Date.now()));
            const sweepLast = this.one(`SELECT value FROM settings WHERE key = 'merge_sweep_last'`);
            return this.json({ ok: true, last_sweep: sweepLast ? JSON.parse(sweepLast.value) : null });
          }
          if (op === "admin.provenance_sweep") {
            // drill/backfill path for PR provenance indexing (BR#3287):
            // dedupe per (repo, pr) still applies; pass now=<future epoch ms>
            // to bypass the cadence window and run immediately.
            await this.provenanceSweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'provenance_last_ts'`);
            const n = this.one(`SELECT COUNT(*) AS n FROM provenance`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0), indexed: Number((n as any)?.n ?? 0) });
          }
          if (op === "admin.unblock_proxy_sweep") {
            // drill/liveness path for the unblock-proxy watch (BR#3361a):
            // per-card pacing + caps still apply; pass now=<future epoch ms>
            // to bypass the cadence window and run immediately.
            await this.unblockProxySweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'unblock_proxy_last_ts'`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
          }
          if (op === "admin.closure_audit_sweep") {
            // drill/liveness path for the closure-receipt audit (BR#3361c):
            // the per-pass row cap still applies; pass now=<future epoch ms>
            // to bypass the cadence window and run immediately.
            await this.closureAuditSweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'closure_audit_last_ts'`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
          }
          return this.json(await this.settingsSet(body));
        default: return this.json({ error: `unknown op ${op}` }, 404);
      }
    } catch (e) {
      return this.json({ error: String((e as Error).message ?? e) }, 400);
    }
  }

  // ---------- ops ----------

  private async create(body: any, actor: string) {
    let type = body.type as ArtefactType;
    if (!isArtefactType(type)) throw new Error(`unknown artefact type '${type}' (valid: ${ARTEFACT_TYPES.join(", ")})`);
    const title = String(body.title ?? "");
    let bodyMd = String(body.body_md ?? "");
    const limitErr = checkLimits(title, bodyMd, body.meta);
    if (limitErr) throw new Error(limitErr);

    const seq = (await this.nextSeq(type));
    const id = formatId(seq);
    const ts = Date.now();
    const status = INITIAL_STATUS[type];
    const tags = sanitizeTags(body.tags);
    // roles: the machine's dispatch/gating lanes — structural, NEVER tags
    // (tags are inert user labels; a tag can't change system behaviour)
    const rolesIn = parseRolesInput(body.roles);
    if (rolesIn.ok === false) throw new Error(rolesIn.error);
    const roles = rolesIn.roles;
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // project: explicit override or the deployment's project; tasks enter UNCLAIMED (owner = pool)
    const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
    // owner = claimant, on tasks only (phase 4). Other types record their human
    // actor in meta (proposed_by / ask.from) — one field, one meaning.
    let owner = type === "task" ? String(body.owner ?? "").trim() : "";
    if (type !== "task") {
      const pm = (body.meta ?? {}) as any;
      if (type === "decision" && !pm.proposed_by) pm.proposed_by = actor;
    }
    // qualifications stack: a publisher may declare self-analyzed readiness AND request
    // further confirmation bars (await: ["review"]) before the task goes ready
    const createMeta: any = { ...(body.meta ?? {}) };
    // an ask node REQUIRES options (the human answers by clicking) — enforced
    // here, not just in ask.create, so every door is covered
    if (createMeta.ask && (type === "task" || type === "question")) {
      const opts = Array.isArray(createMeta.ask.options) ? createMeta.ask.options.filter(Boolean) : [];
      if (opts.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (meta.ask.options)");
      if (!String(body.title ?? "").trimEnd().endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?'");
    }
    // classification is structural (phase 3): legacy meta.kind maps to
    // type ("question"), roles (analysis/review) or a plain tag (research) —
    // stored meta never carries kind again
    if (createMeta.kind !== undefined) {
      const k = String(createMeta.kind);
      const kindType = (KIND_TYPE as Record<string, string | undefined>)[k];
      if (kindType && type === "task") type = kindType as ArtefactType;
      const kindRole = (KIND_ROLE as Record<string, string | undefined>)[k];
      if (kindRole && !roles.includes(kindRole as any)) roles.push(kindRole as any);
      const kindTag = (KIND_TAG as Record<string, string | undefined>)[k];
      if (kindTag && !tags.includes(kindTag)) tags.push(kindTag);
      delete createMeta.kind;
    }

    if (type === "task" && (body.qualified === true || (Array.isArray(body.await) && body.await.length))) {
      createMeta.qualification = {
        state: body.qualified === true ? "qualified" : "open",
        how: body.qualified === true ? "self-analyzed" : "open",
        by: actor, ts,
        bars: Array.isArray(body.await) ? body.await.map(String) : [],
      };
    }
    // VERIFY-VERDICT DEDUP (For Me flood fix): verify sessions propose a decision
    // per round — identical findings ("unchanged since round N") presented as
    // fresh decisions buried the human inbox (45 bounce-cards in 4h). Rule:
    // a verdict identical to the last PROPOSED verdict for the same target is
    // applied directly, never proposed. Same verdict + round>=3 → the task
    // BLOCKS for human intervention (the loop is stalled, that's a blocker
    // not a decision). Changed verdict or changed receipts still propose.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
      const verdict = String(createMeta.verdict ?? "").toLowerCase();
      if (target && verdict) {
        const prev = this.one(
          `SELECT id, meta FROM artefacts WHERE type = 'decision' AND status = 'proposed'
           AND json_extract(meta, '$.decision_class') = 'verify-verdict'
           AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
           ORDER BY created_ts DESC LIMIT 1`,
          target, target,
        );
        // receipts fingerprint: any meta keys other than bookkeeping — identical
        // when the verifier found the same world state
        const fp = (m: any) => JSON.stringify(Object.entries(m ?? {})
          .filter(([k]) => !["decision_class", "task", "verify_target", "verdict", "session", "round"].includes(k))
          .sort(([a], [b]) => a.localeCompare(b)));
        const same = prev && String((JSON.parse(prev.meta ?? "{}") as any).verdict ?? "").toLowerCase() === verdict
          && fp(createMeta) === fp(JSON.parse(prev.meta ?? "{}"));
        if (same) {
          const trow = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, target);
          if (trow) {
            const tm = JSON.parse(trow.meta ?? "{}");
            const round = Number(createMeta.round ?? tm.verify_round ?? 0) + 1;
            tm.verify_round = round;
            const prevGauges = tm.last_progress ?? {};
            tm.last_progress = {
              note: `verify round ${round}: verdict ${verdict} UNCHANGED — auto-applied, no new decision card`, sentiment: "neutral", actor, ts: Date.now(),
              completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
              risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
            };
            const alreadyRight = verdict === "bounce" ? trow.status === "in_progress" : trow.status === "done";
            if (!alreadyRight) {
              // 3 identical rounds = the loop is stalled; park it for a human
              if (round >= 3) {
                await this.transition({
                  id: trow.id, to: "blocked",
                  note: `verify loop stalled — ${round} rounds with identical verdict (${verdict}); auto-applied each time, no progress. Needs human intervention.`,
                  unblock_condition: "human: read the verify history on this card; either clear the blocker the verifier keeps naming, or cancel the loop (transition todo and address the task differently)",
                }, "system:verifier");
              } else {
                await this.transition({
                  id: trow.id, to: verdict === "bounce" ? "in_progress" : "done",
                  note: `verify round ${round}: identical verdict (${verdict}) — auto-applied (For Me flood fix; no decision card)`,
                }, "system:verifier");
              }
            } else {
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(tm), Date.now(), trow.id);
            }
            this.audit("system:verifier", "verdict_deduped", id, { target, verdict, round });
            return { id, deduped: true, target, round, note: "identical verdict auto-applied — no decision card created" };
          }
        }
      }
    }
    // verify-verdict cards land in the human inbox (For you) — prepend the
    // plain-English ask (what accepting does, why a human must do it) so the
    // card is self-describing everywhere it renders: popover, notification
    // snippet, MCP reads. After the dedup gate above: only real cards.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      bodyMd = `${verifyVerdictStatement(createMeta)}\n\n${bodyMd.trim()}`.trim();
    }
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, roles, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify({ ...createMeta, session }), owner, ts, ts,
      tags ? JSON.stringify(tags) : null, roles.length ? JSON.stringify(roles) : null, ts, project, actor,
    );
    if (!bodyMd.trim() && (type === "task" || type === "goal")) {
      bodyMd = scaffoldBody(title, owner || actor);
    }
    this.audit(actor, "create", id, { type, title });
    this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [], roles });
    await this.embedArtefact(id, title, bodyMd);
    // GitHub auto-enrichment: "#1886" in the title pulls issue body/labels
    if (this.env.GH_TOKEN) {
      const ref = issueRef(title);
      if (ref) { try { await this.enrichFromGitHub(id, ref); } catch { /* GH unavailable — stay bare */ } }
    }
    if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
    return { id, type, status };
  }

  /** A progress artefact (meta.task → task id) doubles as a heartbeat on that task:
   *  auto-starts todo tasks, re-claims watchdog-abandoned ones, and bumps last_progress.
   *  Agents post updates as progress logs instead of calling log_progress on the task —
   *  without this, the task card never moves. */
  private async progressHeartbeat(metaObj: any, title: string, actor: string) {
    const raw = String(metaObj?.task ?? "").trim();
    if (!raw) return;
    const candidates = [raw, raw.replace(/^#/, "BR#"), `BR#${raw.replace(/^#/, "")}`];
    const t = candidates
      .map((c) => this.one(`SELECT id, type, status, meta, tags, roles FROM artefacts WHERE id = ? AND type IN ('task','question')`, c))
      .find(Boolean);
    if (!t) return;
    const tmeta = JSON.parse(t.meta ?? "{}");
    const tTags: string[] = parseTags(t.tags);
    const tRoles: string[] = parseTags(t.roles);
    const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
    if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id: t.id, to: "in_progress", note: "re-claimed — progress artefact logged" }, actor);
      delete tmeta.blocked;
    } else if (t.status === "todo") {
      // pickup gate applies: only qualified work (or qualifier roles) auto-starts.
      // Questions are never auto-started — contributions don't claim.
      const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
      if (q.ok && t.type !== "question") await this.transition({ id: t.id, to: "in_progress", note: "started — progress artefact logged" }, actor);
    }
    const prevGauges = tmeta.last_progress ?? {};
    tmeta.last_progress = {
      note: title.slice(0, 200), sentiment: "neutral", actor, ts: Date.now(), session: tmeta.session,
      completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
      risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
    };
    delete tmeta.grace_until; // an artefact heartbeat means the agent is active — grace over
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(tmeta), Date.now(), t.id,
    );
    this.version(t.id, actor, "progress", title.slice(0, 500), { note: title.slice(0, 200) });
    this.audit(actor, "progress", t.id, { note: title.slice(0, 200), via: "progress_artefact" });
  }

  /** Human boost: priority 0 in the pickup ranking, above unblock duty.
   *  Cascades to all TRANSITIVE OPEN children (todo/blocked/in_progress) —
   *  a task cannot complete while its children are open, so the dependency
   *  set IS the children. Audited per task; boost ts orders multiple boosts. */
  private async boost(body: any, actor: string) {
    const id = String(body.id ?? "");
    const on = body.boost !== false;
    const row = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "task") throw new Error(`boost applies to tasks, not ${row.type}`);
    const boosted: string[] = [];
    const queue = [id];
    const seen = new Set<string>([id]);
    while (queue.length) {
      const tid = queue.shift()!;
      const t = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, tid);
      if (!t || t.status === "done" || t.status === "superseded") continue;
      const meta = JSON.parse(t.meta ?? "{}");
      if (on) meta.boosted = Date.now();
      else delete meta.boosted;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(meta), Date.now(), t.id,
      );
      this.audit(actor, on ? "boost" : "unboost", t.id, { root: id });
      this.version(t.id, actor, "update", on ? `boosted (priority 0, via ${id})` : `boost removed (via ${id})`, {});
      boosted.push(t.id);
      for (const c of this.state.storage.sql.exec(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ?`, t.id,
      ).toArray() as any[]) {
        if (!seen.has(c.id)) { seen.add(c.id); queue.push(c.id); }
      }
    }
    return { id, boosted, on };
  }

  private async get(id: string) {
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    return this.shape(row);
  }

  private async list(body: any) {
    const conds: string[] = [], params: any[] = [];
    if (body.type) { conds.push("type = ?"); params.push(String(body.type)); }
    if (body.status) { conds.push("status = ?"); params.push(String(body.status)); }
    if (body.tag) { conds.push("tags LIKE ?"); params.push(`%"${String(body.tag).replace(/[^a-z0-9:_-]/g, "")}"%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200))
      .toArray();
    return { artefacts: rows.map((r) => this.shape(r)) };
  }

  /** Hybrid: FTS5 keyword + embedding cosine, merged. Falls back to FTS-only when AI is unavailable. */
  private async search(body: any) {
    const rawQ = String(body.q ?? "");
    const limit = Math.min(Number(body.limit ?? 20), 100);
    const q = ftsQuery(rawQ);
    if (!q) return { artefacts: [], note: "empty query" };
    const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";

    const ftsRows = this.state.storage.sql
      .exec(
        `SELECT a.id FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter} ORDER BY rank LIMIT ?`,
        q, limit,
      )
      .toArray()
      .map((r: any, i: number) => ({ id: r.id, score: 1 / (1 + i) }));

    let vecRows: Array<{ id: string; score: number }> = [];
    let qvec: Float32Array | null = null;
    let qdim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(rawQ, "")] });
        if (Array.isArray(out?.data?.[0])) { qvec = Float32Array.from(out.data[0]); qdim = qvec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!qvec) { qvec = Float32Array.from(trigramVec(embedText(rawQ, ""), TRIGRAM_DIM)); qdim = TRIGRAM_DIM; }
    {
      const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE dim = ?`, qdim).toArray();
      const scored = rows.map((r: any) => {
        const v = new Float32Array(r.vec.buffer ?? r.vec);
        return { id: r.artefact_id, score: cosine(qvec as Float32Array, v) };
      }).filter((r) => r.score > 0.3);
      scored.sort((a, b) => b.score - a.score);
      vecRows = scored.slice(0, limit);
    }

    const merged = hybridMerge(ftsRows, vecRows, limit);
    if (merged.length === 0) return { artefacts: [], note: "no matches (keyword + semantic)" };
    const ids = merged.map((m) => m.id);
    const marks = ids.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec(
      `SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids,
    ).toArray().map((r: any) => this.shape(r));
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const scored = merged
      .map((m) => {
        const r: any = byId.get(m.id);
        return r ? { ...r, _score: m.score, _via: m.via } : null;
      })
      .filter((r): r is any => !!r);
    return { artefacts: scored, hybrid: { keyword: ftsRows.length, semantic: vecRows.length } };
  }

  /** "What relates to X?" — nearest artefacts by embedding. */
  private async related(id: string, limit: number) {
    const row = this.one(`SELECT vec, dim FROM embeddings WHERE artefact_id = ?`, id);
    if (!row) return { artefacts: [], note: "no embedding for artefact" };
    const qvec = new Float32Array(row.vec.buffer ?? row.vec);
    const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE artefact_id != ? AND dim = ?`, id, row.dim).toArray();
    const scored = rows.map((r: any) => {
      const v = new Float32Array(r.vec.buffer ?? r.vec);
      return { id: r.artefact_id, score: cosine(qvec, v) };
    }).filter((r) => r.score > 0.3);
    scored.sort((a, b) => b.score - a.score);
    const ids = scored.slice(0, limit).map((r) => r.id);
    if (ids.length === 0) return { artefacts: [] };
    const marks = ids.map(() => "?").join(",");
    const arts = this.state.storage.sql.exec(`SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids).toArray().map((r: any) => this.shape(r));
    const byId = new Map(arts.map((a: any) => [a.id, a]));
    return { artefacts: ids.map((i) => byId.get(i)).filter((a): a is any => !!a) };
  }

  /**
   * Embed title-weighted text; store as float32 BLOB with the vector dim.
   * Two spaces: Workers AI (prod, 768d) when bound; local hashed-trigram (256d) fallback.
   * Best-effort — never fails the write.
   */
  private async embedArtefact(id: string, title: string, body: string) {
    let vec: number[] | null = null;
    let dim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(title, body)] });
        if (Array.isArray(out?.data?.[0])) { vec = out.data[0]; dim = vec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!vec) {
      vec = trigramVec(embedText(title, body), TRIGRAM_DIM);
      dim = TRIGRAM_DIM;
    }
    const f32 = Float32Array.from(vec);
    this.state.storage.sql.exec(
      `INSERT INTO embeddings (artefact_id, vec, dim) VALUES (?, ?, ?)
       ON CONFLICT(artefact_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
      id, new Uint8Array(f32.buffer), dim,
    );
  }

  private async update(body: any, actor: string) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // any mutation is a heartbeat: abandoned tasks re-claim on first contact
    const preMeta = JSON.parse(row.meta ?? "{}");
    const reclaimed =
      row.status === "blocked" && (preMeta.blocked?.reason ?? "").startsWith("abandoned");
    if (reclaimed) {
      await this.transition({ id, to: "in_progress", note: "re-claimed — agent resumed (heartbeat)" }, actor);
    }
    const title = body.title !== undefined ? String(body.title) : row.title;
    const bodyMd = body.body_md !== undefined ? String(body.body_md) : row.body_md;
    // row.meta predates the re-claim transition — strip the stale blocked record so we don't resurrect it
    const metaObj = body.meta !== undefined ? JSON.parse(JSON.stringify(body.meta)) : JSON.parse(row.meta ?? "{}");
    if (reclaimed) delete metaObj.blocked;
    const meta = JSON.stringify(metaObj);
    if (row.type === "progress") await this.progressHeartbeat(metaObj, title, actor);
    const tags = body.tags !== undefined ? sanitizeTags(body.tags) : row.tags;
    // roles replacement semantics, same as tags (explicit array = replace)
    let roles: string[] | null = parseTags(row.roles);
    if (body.roles !== undefined) {
      const rolesIn = parseRolesInput(body.roles);
      if (rolesIn.ok === false) throw new Error(rolesIn.error);
      roles = rolesIn.roles;
    }
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, roles = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, tags ? JSON.stringify(tags) : null, roles && roles.length ? JSON.stringify(roles) : null, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    const changed = [
      body.title !== undefined && "title", body.body_md !== undefined && "body",
      body.meta !== undefined && "meta", body.tags !== undefined && "tags",
      body.roles !== undefined && "roles",
    ].filter(Boolean);
    this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
    await this.embedArtefact(id, title, bodyMd);
    return { id };
  }

  /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
   *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
  private hasEvidence(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const roleFilter = kind === "analysis"
      ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
      : `c.roles LIKE '%"review"%'`;
    const child = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${roleFilter} LIMIT 1`,
      row.id,
    );
    if (child) return { ok: true, via: child.id };
    const dec = this.one(
      `SELECT d.id AS id FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted' LIMIT 1`,
      row.id,
    );
    if (dec) return { ok: true, via: dec.id };
    return { ok: false };
  }

  /** Swimlane qualification: declared (self-analyzed at intake / preset), pure evidence,
   *  or inherited from the parent's decomposition (the pass that qualified the parent
   *  covered its children). */
  private qualifyCheck(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const meta = JSON.parse(row.meta ?? "{}");
    const q = meta.qualification ?? {};
    if (kind === "analysis" && (meta.qualified === true || q.state === "qualified")) return { ok: true, via: "declared" };
    const ev = this.hasEvidence(row, kind);
    if (ev.ok) return ev;
    const parent = this.one(
      `SELECT p.id AS id, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
      row.id,
    );
    if (parent) {
      const pm = JSON.parse(parent.meta ?? "{}");
      if (kind === "analysis" && (pm.qualified === true || (pm.qualification ?? {}).state === "qualified"))
        return { ok: true, via: `parent:${parent.id}` };
      const sib = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${kind === "analysis"
           ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
           : `c.roles LIKE '%"review"%'`} LIMIT 1`,
        parent.id,
      );
      if (sib) return { ok: true, via: `sibling:${sib.id}` };
    }
    return { ok: false };
  }

  /** Requested-but-unmet qualification bars (qualifications stack: a publisher may
   *  self-qualify AND ask for further confirmation before the task goes ready). */
  /** Bars that can actually gate a CLAIM: things satisfiable before work
   *  starts (human sign-off, an accepted decision...). Qualifier-role bars
   *  (role:analysis/review/impl/unblock) are NOT enforceable pre-claim —
   *  they demand a done role child of the task itself, i.e. a review of
   *  work the gate prevents from existing (the Oct-20 empty-pool incident:
   *  10/10 backlog items unclaimable, runner churning failed claims).
   *  Roles are playbooks, not gates — the done-gate already enforces
   *  review-before-completion where it belongs. */
  private enforceableBars(bars: string[]): string[] {
    return bars.filter((b) => !/^(?:role:)?(analysis|review|impl|unblock)$/.test(String(b)));
  }

  private unmetBars(row: any): string[] {
    const meta = JSON.parse(row.meta ?? "{}");
    const bars: string[] = (meta.qualification ?? {}).bars ?? [];
    return this.enforceableBars(bars).filter((b) => !this.hasEvidence(row, /review/.test(b) ? "review" : "analysis").ok);
  }

  /** Bulk evidence for readiness projections: done role-tagged children per parent +
   *  accepted decisions per task. Review evidence also satisfies the analysis kind. */
  private qualificationEvidence(): { analysisEv: Set<string>; reviewEv: Set<string> } {
    const analysisEv = new Set<string>(), reviewEv = new Set<string>();
    for (const k of this.state.storage.sql.exec(
      `SELECT r.dst_id AS pid, c.roles AS roles FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`,
    ).toArray() as any[]) {
      const roles: string[] = parseTags(k.roles);
      if (roles.includes("review")) { reviewEv.add(k.pid); analysisEv.add(k.pid); }
      else if (roles.includes("analysis")) analysisEv.add(k.pid);
    }
    for (const d of this.state.storage.sql.exec(
      `SELECT r.dst_id AS tid FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND d.type = 'decision' AND d.status = 'accepted'`,
    ).toArray() as any[]) { analysisEv.add(d.tid); reviewEv.add(d.tid); }
    return { analysisEv, reviewEv };
  }

  /** Agent roles for an actor label (empty for humans "web" and system actors). */
  private actorTagsFor(label: string): string[] {
    if (!label || /^(web|system:)/.test(label)) return [];
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    try { return parseTags(row?.tags); } catch { return []; }
  }

  /** Every rejected transition is audited (transition_rejected: actor, from, to,
   *  reason) — gaming the gates is visible in the Log and costs behaviour score.
   *  The rejection then goes through the breach door: storms raise ONE card. */
  private async transition(body: any, actor: string) {
    try {
      return await this.doTransition(body, actor);
    } catch (e) {
      const id = String(body?.id ?? "");
      const to = String(body?.to ?? "");
      if (id) {
        const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
        this.audit(actor, "transition_rejected", id, {
          from: cur?.status, to, reason: String((e as Error)?.message ?? e).slice(0, 300),
        });
        try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
        // BR#3361 (b): the auto-derivation half of terminal-leg ownership.
        // A done rejected by done-close-legs derives the close-duty child
        // (flood-guarded: one per legs-shape per hour) so the very next
        // attempt has an owner to point at — no orphan terminal legs.
        if (String((e as Error)?.message ?? "").includes("[rule: done-close-legs]")) {
          try { await this.spawnCloseLegDuty(id, actor, String((e as Error)?.message ?? "")); } catch (se) {
            this.audit(actor, "close_leg_spawn_error", id, { error: String((se as Error).message ?? se).slice(0, 300) });
          }
        }
      }
      throw e;
    }
  }

  /** BR#3361 (b): the close-duty child a rejected done auto-derives. One per
   *  legs-shape per flood window; carries the receipt contract and the
   *  close-then-complete-parent contract so the leg ends owned. The legs
   *  come from the gate's own rejection message — the authoritative list. */
  private async spawnCloseLegDuty(parentId: string, actor: string, rejectionMessage: string): Promise<void> {
    const row = this.one(`SELECT id, title, body_md, meta, status FROM artefacts WHERE id = ?`, parentId);
    if (!row || row.status === "done") return; // leg executed between rejection and spawn
    const ts = Date.now();
    const meta = JSON.parse(row.meta ?? "{}");
    const listed = /not receipted: ([^—]+)—/.exec(rejectionMessage)?.[1] ?? "";
    const legs: CloseLeg[] = [...listed.matchAll(/(?:(?:([A-Za-z0-9-]+)\/([A-Za-z0-9.-]+))?#|#)(\d+)/g)].map((m) => ({
      repo: m[1] && m[2] ? `${m[1]}/${m[2]}` : null,
      number: Number(m[3]),
      raw: m[0],
    }));
    if (!legs.length) return;
    const stamp = meta.last_close_leg_spawn;
    const shape = legs.map(legLabel).join(",");
    if (stamp && typeof stamp.at === "number" && ts - stamp.at < UNBLOCK_FLOOD_MS && String(stamp.legs ?? "") === shape) return;
    // one live close-leg duty per parent at a time — the machine's cap shape
    const live = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.roles LIKE '%"unblock"%' AND (c.title || ' ' || c.body_md) LIKE '%close-leg duty%' LIMIT 1`,
      parentId,
    );
    if (live) {
      meta.last_close_leg_spawn = { at: ts, legs: shape, child: live.id };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
      return;
    }
    const rootTitle = String(row.title ?? "").replace(/^(?:Unblock:\s*)+/, "");
    const legLines = legs.map((l) => `- close ${legLabel(l)}${l.repo ? ` (${l.repo})` : " (repo: resolve from the card's context — bare-number legs take the project's default paperwork repo)"}`).join("\n");
    const created = await this.create(
      {
        type: "task",
        title: `Close-leg duty: ${rootTitle.slice(0, 160)}`.slice(0, 200),
        session: "", // session-less spawn: the closer stamps it when they claim (a
        // pre-attributed child would trip review-separation against the real closer)
        body_md: `Terminal close-leg duty for ${parentId} — "${rootTitle}".\n\nThe parent's done was gate-rejected by done-close-legs (BR#3361): its Done-when ends in a terminal GitHub close leg that was not receipted. The hub auto-derived this duty so the leg has an owner — no orphan terminal legs.\n\nLegs:\n${legLines}\n\nEvery receipt must carry: ${RECEIPT_CONTRACT}.\n\nContract: (1) verify live state first (gh issue view <N> --repo <repo> --json state). If the issue is already CLOSED, capture the receipt and close yourself done citing it. If it is OPEN: execute the close per the parent's grammar (bug-corpus scenario id, or scenario: none with justification), capture the receipt, close yourself done with the receipt in the note. (2) Then transition ${parentId} → done citing the receipt — the parent's gate accepts a receipted note or this closed child.`,
        roles: ["unblock"],
      },
      actor,
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, parentId, ts,
    );
    meta.last_close_leg_spawn = { at: ts, legs: shape, child: created.id };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
    this.audit(actor, "create", created.id, { type: "task", auto: "close_leg", parent: parentId, legs: shape });
    this.version(parentId, actor, "note", `close leg(s) ${shape} unowned at done — auto-derived close-duty child ${created.id} (BR#3361)`, { child: created.id, legs: shape });
  }

  /** Lazy SQL-backed context for the machine rules — a guard only queries
   *  what it actually reads, so cheap transitions stay cheap. */
  private ruleCtx(row: any, body: any, id: string, tTags: string[]): RuleCtx {
    return {
      qualify: (kind) => {
        // Bar-based claim gate: a claim is legal unless the task DECLARES
        // enforceable bars that are unmet. Task tags declare the KIND of work
        // (analysis/impl/review) for the dispatched session's delivery
        // contract; there are no agent roles and no default qualification
        // requirement — separation of duties lives in the session-history
        // check, not here.
        const unmet = this.unmetBars(row);
        return unmet.length === 0 ? { ok: true, via: "no-bars" } : { ok: false };
      },
      unmetBars: () => this.unmetBars(row),
      session: () => this.resolveSession(body, String(body?.token_id ?? "")),
      evidence: (eid) => this.one(`SELECT type, tags, roles, meta FROM artefacts WHERE id = ?`, eid),
      parent: () =>
        this.one(
          `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
          id,
        ),
      openChildren: () =>
        this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')`,
          id,
        )?.n ?? 0,
      // verify-of-verify / nesting-cap guard: the spawn-blocker reason or null
      spawnGuard: () => {
        let cursor = id, depth = 0;
        while (depth < 10) {
          const p = this.one(
            `SELECT p.id AS id, p.roles AS roles FROM relations r JOIN artefacts p ON p.id = r.dst_id
             WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
          );
          if (!p) return null;
          depth++;
          if (parseTags(p.roles).includes("review")) return `ancestor ${p.id} is a review task — verify-of-verify is blocked`;
          if (depth >= 3) return `nesting depth ${depth} would exceed the child_of cap of 3`;
          cursor = p.id;
        }
        return null;
      },
      // newest OPEN verify round (reuse candidate) — a re-handoff re-enters the
      // same round instead of stacking a fresh card per bounce cycle
      openVerifyChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"review"%' ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // at most ONE live unblock child per parent, ever (cap ≤1 open)
      openUnblockChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // BR#3361: the task's own body (Done-when section source for the
      // terminal close-leg gate)
      cardBody: () => String(row.body_md ?? ""),
      // BR#3361 terminal-leg ownership: a CLOSED child that owns the leg —
      // its title/body names both the close and the issue number
      closeLegChildClosed: (leg: CloseLeg) => {
        const hit = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done'
             AND (c.title || ' ' || c.body_md) LIKE '%close%'
             AND (c.title || ' ' || c.body_md) LIKE ${"?"}
             AND c.roles LIKE '%"unblock"%' LIMIT 1`,
          id, `%#${leg.number}%`,
        );
        return !!hit;
      },
      // recent version-log rows (newest first) for the server-side silent-churn fold
      recentEvents: () =>
        (this.state.storage.sql.exec(
          `SELECT ts, actor, action, summary FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 50`,
          id,
        ).toArray() as any[]).map((r) => ({ ts: Number(r.ts), actor: String(r.actor), action: String(r.action), summary: String(r.summary ?? "") })),
    };
  }

  private async doTransition(body: any, actor: string) {
    const id = String(body.id ?? "");
    const to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // ---- the law: one table, one executor (machine.ts). Legality AND every
    // spawn/escalate/supersede decision come back as a typed Verdict
    // (Applied | Rejection); this function persists and executes the effects,
    // it never invents legality or decisions. ----
    const tTags: string[] = parseTags(row.tags);
    const tRoles: string[] = parseTags(row.roles);
    const ts0 = Date.now();
    const verdict = await decide(
      { id, type: row.type, status: row.status, to, roles: tRoles, tags: tTags, meta: JSON.parse(row.meta ?? "{}"), actor, body, owner: row.owner, now: ts0 },
      this.ruleCtx(row, body, id, tTags),
    );
    if (verdict.ok === false) throw new Error(`${verdict.message} [rule: ${verdict.rule}]`);
    // (B) subprocess class: a declared block on a long/handed-off op, with a
    // budget. The watchdog pauses until the budget lapses; past it the
    // subprocess = declared silence while STILL WORKING: the task stays
    // in_progress (it isn't blocked — nothing else must finish first). The
    // watchdog pauses until the declared budget lapses; past it the sweep
    // converts the silence to abandoned. Blocked is reserved for tasks
    // awaiting OTHER tasks/decisions.
    const isSubprocess = body.class === "subprocess";
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : undefined;
    const ts = ts0;
    const meta = JSON.parse(row.meta ?? "{}");
    if (isSubprocess && row.type === "task" && row.status === "in_progress") {
      const bm = Math.max(1, Math.min(1440, Number(body.budget_minutes) || 0));
      if (!bm) throw new Error("class: subprocess requires budget_minutes (1-1440) — a declared window without a deadline never trips, which is worse than abandonment");
      meta.subprocess = { reason: String(body.note ?? body.reason ?? "").trim(), budget_minutes: bm, deadline_ts: ts + bm * 60_000, ts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ?, status_ts = ? WHERE id = ?`,
        JSON.stringify(meta), ts, ts, id,
      );
      this.audit(actor, "transition", id, { from: row.status, to: "in_progress (subprocess)", note: String(body.note ?? ""), class: "subprocess", budget_minutes: bm });
      this.version(id, actor, "transition", `subprocess declared — watchdog paused until +${bm}m — ${String(body.note ?? "").slice(0, 120)}`, { from: row.status, to: "in_progress", class: "subprocess" });
      return { id, status: "in_progress", subprocess: true };
    }
    // stamp the executor's meta_patch (value `undefined` deletes the key),
    // then normalize the blocked record to the FINAL status — the churn
    // redirect lands blocked with its own reason + unblock condition.
    for (const [k, v] of Object.entries(verdict.meta_patch)) {
      if (v === undefined) delete meta[k];
      else meta[k] = v;
    }
    if (verdict.status === "blocked") {
      if (!meta.blocked)
        meta.blocked = { reason: String(body.note ?? body.reason ?? "").trim(), unblock_condition: String(body.unblock_condition ?? "").trim(), ts };
      delete meta.subprocess; // a real block supersedes a declared subprocess window
    } else if (meta.blocked) {
      delete meta.blocked; // unblocking clears the dead-end record
    }
    // claim semantics: in_progress on a task claims it for the actor (system actors don't steal claims)
    let owner = row.owner;
    // claim only on fresh pickup or abandoned re-claim — a review bounce returns to the AUTHOR
    const bounceFromReview = row.status === "in_review";
    // gateway attribution: a gateway-tagged token is infrastructure — it claims
    // on behalf of the agent it dispatched as (ADR BR#899). body.agent names
    // that agent; mcp.ts only forwards it when the token carries the "gateway"
    // tag, so a plain agent token cannot attribute its work elsewhere.
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.type === "task" && verdict.status === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
      owner = attributedAgent ?? actor;
    }
    // identity phase 2: ownership references the stable principal when the
    // acting token carries one (labels are display; principals are the anchor)
    const actingPrincipal = typeof body.token_id === "string" && body.token_id
      ? this.one(`SELECT principal FROM auth_tokens WHERE id = ?`, body.token_id)?.principal
      : null;
    if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && actingPrincipal) {
      owner = actingPrincipal;
    }
    // attribution bookkeeping (BR#2455): when a gateway-tagged token acts as
    // another agent, record the gateway→agent edge for Connect grouping. The
    // token row is the authority — a forged body.gateway without the tag no-ops.
    if (attributedAgent && attributedAgent !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, attributedAgent);
    }
    // session attribution: stamp which session claimed/acted, first-wins, resolved
    // explicit → the token's most recent session (agents pass session on orient only)
    if (row.type === "task" && !meta.session) {
      const sess = await this.resolveSession(body, String(body.token_id ?? ""));
      if (sess) meta.session = String(sess).slice(0, 120);
    }
    // (release ownership, churn escalate/redirect and the attempt stamp are
    // executor decisions now — machine.ts RULES + effects, BR#2420 F4)
    // separation of duties, mechanical: a session that completed the analysis
    // child cannot carry the parent into implementation. If the parent is
    // claimed by the same session, release it — impl requires a fresh claim
    // (fresh session). The claim gate will then allow it (evidence session ≠ new session).
    if (row.type === "task" && verdict.status === "done" && tRoles.includes("analysis")) {
      const parent = this.one(
        `SELECT p.id AS id, p.status AS status, p.owner AS owner, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, id,
      );
      const implSession = parent ? JSON.parse(parent.meta ?? "{}").session : undefined;
      const analysisSession = JSON.parse(row.meta ?? "{}").session;
      if (parent?.status === "in_progress" && implSession && analysisSession && implSession === analysisSession) {
        await this.transition(
          { id: parent.id, to: "todo", note: `analysis complete (${id}) — released for fresh-claim implementation` },
          "system:separation",
        );
      }
    }
    // (done open-children gate lives in machine.ts RULES — BR#2420)
    // BR#3361 (c): a done card that claims close legs must be auditable —
    // stamp the legs + the parsed receipts from the done note so the
    // closure-receipt audit sweep can live-verify them post-done (the
    // BR#3220 class: a done card reporting a close that never happened).
    if (row.type === "task" && verdict.status === "done") {
      const doneNote = String(body?.note ?? body?.resolution ?? body?.reason ?? "").trim();
      const legs = parseCloseLegs(`${doneWhenSection(String(row.body_md ?? ""))}\n${doneNote}`);
      if (legs.length) {
        meta.close_leg_audit = {
          ts,
          legs: legs.map((l) => ({ repo: l.repo, number: l.number })),
          receipts: legs.map((l) => ({ ...l, ...(parseClosureReceipt(doneNote, l) ?? { closed: false, commentId: null, guardRun: null }) })),
          checked_ts: null,
        };
      }
    }
    // BR#3361 (d): duplicate-executor fence, visible half. A transition by a
    // session that is NOT the stamped executor while the executor's liveness
    // is fresh is observable (audit duplicate_executor) — the BR#3348 class:
    // two executor sessions doing the same GH paperwork concurrently.
    // Advisory: additive contributions (log_progress) are legitimate and
    // never audited here; this fires on state-changing ops only, and only
    // when the acting session named itself (an unnamed session on a shared
    // token is ambiguous — the token's last-session fallback must not frame
    // the holder's own session).
    try {
      const holder = JSON.parse(row.meta ?? "{}");
      const actingSession = body.session ? await this.resolveSession(body, String(body.token_id ?? "")) : undefined;
      const holderSession = holder.session;
      if (
        row.type === "task" && row.status === "in_progress" &&
        holderSession && actingSession && holderSession !== actingSession
      ) {
        const holderAlive = Math.max(holder.last_progress?.ts ?? 0, holder.session_alive_ts ?? 0, row.updated_ts ?? 0);
        if (Date.now() - holderAlive <= 10 * 60_000) {
          this.audit("system:fence", "duplicate_executor", id, {
            holder: holderSession, actor: actingSession, from: row.status, to,
          });
        }
      }
    } catch { /* the fence is observability — never blocks the gate */ }
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ?, tags = ? WHERE id = ?`,
      verdict.status, ts, JSON.stringify(meta), ts, verdict.owner_clear ? "" : owner, JSON.stringify(tagsForWrite(verdict, tTags)), id,
    );
    // post-conditions on the single write path: violations are breaches (a
    // loud audited trail), never silent repairs.
    const violations = checkInvariants({ type: row.type, status: verdict.status, roles: tRoles, tags: tTags, meta });
    if (violations.length) {
      this.audit("system:invariants", "invariant_violation", id, { violations, from: row.status, to: verdict.status });
      this.version(id, "system:invariants", "note", `INVARIANT VIOLATION after ${row.status} → ${verdict.status}: ${violations.join("; ")}`, { violations });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    }
    if (verdict.status === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, {
      from: row.status, to: verdict.status, note: body.note ?? "", sentiment,
      ...(attributedAgent ? { agent: attributedAgent } : {}),
    });
    this.version(id, actor, "transition", `${row.status} → ${verdict.status}${body.note ? ` — ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to: verdict.status, note: body.note ?? "" });
    // verify-verdict decisions are actionable: the human's answer DOES the
    // thing, not just records it. Accepting a VERIFIED verdict closes the
    // verified task (the accepted decision satisfies its done-gate via the
    // supports link). Accepting a BOUNCE verdict bounces the task back to
    // work with the findings. Without this, verdicts pile up as prose and the
    // human's click changes nothing — 35 proposed decisions taught us that.
    if (row.type === "decision" && verdict.status === "accepted") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        const isBounce = String(dm.verdict ?? "").toLowerCase() === "bounce";
        if (target) {
          // verifiers often apply their own verdict before proposing it — the
          // task is already done/bounced. Ratification must be a clean no-op,
          // not an "apply failed" error the human has to interpret.
          const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, target);
          const already = cur && (isBounce ? cur.status === "in_progress" : cur.status === "done");
          if (already) {
            this.audit(actor, "verdict_already_applied", target, { decision: id, status: cur.status });
          } else try {
            await this.transition(
              {
                id: target,
                to: isBounce ? "in_progress" : "done",
                note: isBounce
                  ? `verdict ${id} rejected by human — bounce with the verifier's findings`
                  : `verdict ${id} accepted by human — closed on a verified (non-void) verdict`,
              },
              actor,
            );
            this.audit(actor, "verdict_applied", target, { decision: id, effect: isBounce ? "bounced" : "closed" });
          } catch (e) {
            // gate refused (e.g. open children) — surface it on the decision
            // instead of silently swallowing the human's click
            const msg = String((e as Error).message ?? e).slice(0, 300);
            this.audit("decision:verdict", "apply_failed", target, { decision: id, error: msg });
            this.version(id, "decision:verdict", "note", `verdict apply failed on ${target}: ${msg}`, { target, error: msg });
          }
        }
      }
    }
    // ---- execute the effects the executor decided (do.ts never decides) ----
    let verifyTaskId: string | undefined;
    for (const fx of verdict.effects) {
      switch (fx.kind) {
        case "spawn_verify": {
          // verification duty: entering review spawns the Verify task into the
          // unclaimed pool. A verifier (any agent, fresh session) picks it up,
          // checks receipts, completes it, then closes the parent (done) or
          // bounces it (in_progress with findings).
          const rootTitle = row.title.replace(/^(?:Verify:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Verify: ${rootTitle.slice(0, 200)}`,
              body_md: `Verification duty for ${id} — "${rootTitle}".\n\nYOU ARE THE MERGE AUTHORITY — substance review AND the merge click are both yours (standing order BR#3033: base green + checks green + verified signatures + mergeable → merge, no human gate).\n\nVERIFY GATE — mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident):\n1. FIRST, before any substance check: gh pr view <N> --json mergeable,mergeStateStatus,reviewDecision and confirm every commit signature isValid=true. If mergeable=false / CONFLICTING / any unsigned commit: STOP — zero substance checks, NO ask to the human.\n2. Bounce to impl: transition ${id} in_progress with the mechanical defect ("PR #N unmergeable — unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push.").\n3. Broken signing environment (key unavailable / NO_USER): file ONE ask for the whole class, never per PR.\n4. "Sole unmet leg = human merge gate" is only valid for a MERGEABLE, checks-green, substance-verified PR. "Accept the unsigned commit" is never an option.\n\nThen double-check, don't reimplement: confirm the receipts (PR: ${fx.pr ?? "see note"}, merge state, findings) and that the work matches the task.\n\nMERGE: when substance AND mergeability both hold, YOU merge the PR (gh pr merge <N> — merge-commit, the repo convention) citing the merge sha. Done-with-receipts = merged + reviewed + merge sha in the note. Problems found → bounce the parent back to impl with findings (in_review → in_progress, one round, N bounces — impl fixes and re-enters the SAME round). The loop runs until YOU merge and close.`,
              roles: ["review"],
            },
            actor,
          );
          verifyTaskId = created.id;
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "verification", parent: id });
          break;
        }
        case "reuse_verify": {
          verifyTaskId = fx.verify;
          this.audit("system:separation", "verify_reused", id, { verify: fx.verify });
          break;
        }
        case "skip_verify_spawn": {
          this.audit("system:guard", "spawn_skipped", id, { auto: "verification", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "spawn_unblock": {
          // every blocked task gets an unblock child — the executor already
          // ran the cap (≤1 open per parent) and the flood guard; this is the
          // only spawn site and it only executes.
          const rootTitle = row.title.replace(/^(?:Unblock:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Unblock: ${rootTitle.slice(0, 200)}`,
              session: "", // session-less spawn: the unblock contract is "then a
              // FRESH session" — a pre-attributed child would trip review-separation against the legitimate closer
              body_md: `Unblock duty for ${id} — "${rootTitle}".\n\nBlocked why: ${fx.reason || "see parent"}.\nExit condition: ${fx.exit_condition || "none recorded — read the card and history, then decide: clear the block, re-scope the task, or escalate via ask_agent"}.\n\nContract: check whether the exit condition now holds (live receipts, GitHub state, answered decision). If it holds: transition ${id} to in_progress with the resolution note, then close yourself done citing what unblocked it. If it does not: record findings via log_progress and close yourself done with the findings — do NOT respawn an unblock task, do not leave yourself open.`,
              roles: ["unblock"],
            },
            actor,
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "unblock", parent: id });
          meta.last_unblock_spawn = { at: ts, exit: fx.exit_condition };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
          break;
        }
        case "skip_unblock_spawn": {
          this.audit(actor, "spawn_skipped", id, { auto: "unblock", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "supersede_children": {
          // children are ephemeral: when the parent moves on, their round
          // closes. keep_newest keeps the newest verify child alive across a
          // bounce — the bounce re-enters the SAME round (the churn that
          // drowned the pool was 3-6 cards per parent).
          const kids = this.state.storage.sql.exec(
            `SELECT c.id AS id, c.status AS status, c.meta AS meta, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.roles LIKE ? ORDER BY c.updated_ts DESC`,
            id, `%"${fx.tag}"%`,
          ).toArray() as any[];
          kids.forEach((v, i) => {
            if (fx.keep_newest && i === 0) return;
            const vm = JSON.parse(v.meta ?? "{}");
            vm.superseded_reason = fx.cause;
            this.state.storage.sql.exec(
              `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
              JSON.stringify(vm), ts, ts, v.id,
            );
            this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: fx.cause });
            this.version(v.id, "system:separation", "transition", fx.cause, { from: v.status, to: "superseded" });
          });
          break;
        }
        case "escalate": {
          this.audit("system:churn-guard", "escalated", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, duty: tRoles[0] ?? "unknown" });
          // a NOTE, not a second transition row: the applied transition above
          // already stamped the real from→to. A duplicate transition stamp
          // with the stale pre-applied from broke the version-log chain and
          // re-fired the replay breach on every later transition (BR#3322).
          this.version(id, "system:churn-guard", "note", `escalated to human — verdict duties cannot block (attempts ${fx.attempts}, silent cycles ${fx.silent_cycles})`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
        case "release_redirect": {
          this.audit("system:churn-guard", "release_redirected", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, from: row.status });
          // same: the redirect IS the applied transition — explain it as a note
          this.version(id, "system:churn-guard", "note", `release redirected to blocked — ${fx.attempts} attempts without completion`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
      }
    }
    // replay consistency: fold the version log forward and compare with the
    // stored state — fold(events) != stored_state is itself a breach
    // (BR#2419 item 6).
    try { await this.replayCheck(id); } catch { /* fail-soft: the log fold never blocks a legal write */ }
    return { id, status: verdict.status, ...(sentiment ? { sentiment } : {}), verify_task: verifyTaskId };
  }

  private async link(body: any, actor: string) {
    const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
    if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
    const src = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, srcId);
    const dst = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, dstId);
    if (!src || !dst) throw new Error("both src and dst must exist");
    const verdict = validateRelation(rel, src.type as ArtefactType, dst.type as ArtefactType);
    if (verdict.ok === false) throw new Error(verdict.reason);
    // verify-of-verify is structurally impossible: a verify task can never be
    // a child of a verify task (or of an unblock task — same ephemerality).
    // Enforced here at the relation level, not just the auto-spawn path.
    if (rel === "child_of") {
      const childRoles = parseTags((src as any).roles);
      const parentRoles = parseTags((dst as any).roles);
      if (childRoles.includes("review") && (parentRoles.includes("review") || parentRoles.includes("unblock")))
        throw new Error(`link rejected: ${srcId} is a verify task — verify tasks are terminal-at-birth and cannot nest under ${parentRoles.includes("review") ? "another verify" : "an unblock"} task`);
      if (childRoles.includes("unblock") && (parentRoles.includes("unblock") || parentRoles.includes("review")))
        throw new Error(`link rejected: ${srcId} is an unblock task — unblock tasks are terminal-at-birth and cannot nest under another ephemeral task`);
    }
    // nesting depth cap: child_of chains max 3 deep — references give structure,
    // not unbounded trees (verify recursion taught us this the hard way)
    if (rel === "child_of") {
      let cursor = dstId, depth = 0, hit: string | undefined;
      while (depth < 10) {
        const p = this.one(
          `SELECT p.id AS id FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
        );
        if (!p) break;
        depth++;
        if (depth >= 3) { hit = `${dstId} is already 3 levels deep in a child_of chain — nesting is capped at 3 to keep the task graph flat`; break; }
        cursor = p.id;
      }
      if (hit) throw new Error(`link rejected: ${hit}`);
    }
    const count = this.one(
      `SELECT COUNT(*) AS n FROM relations WHERE src_id = ?`, srcId,
    ) as any;
    if (Number(count.n) >= LIMITS.relationsPerArtefact)
      throw new Error(`artefact ${srcId} already has ${LIMITS.relationsPerArtefact} relations`);
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, ?, ?, ?)`,
      srcId, rel, dstId, Date.now(),
    );
    this.audit(actor, "link", srcId, { relation: rel, dst: dstId });
    return { src: srcId, relation: rel, dst: dstId };
  }

  private async relations(id: string) {
    const out = this.state.storage.sql.exec(
      `SELECT relation, dst_id AS artefact_id, 'out' AS dir FROM relations WHERE src_id = ?
       UNION ALL
       SELECT relation, src_id AS artefact_id, 'in' AS dir FROM relations WHERE dst_id = ?`,
      id, id,
    ).toArray();
    return { id, relations: out };
  }

  /** Task-done throughput (BR#2937): done transitions per bucket + cumulative,
   *  aggregated from ledger mutation rows (true transition events — immune to
   *  later status flips) with a status_ts fallback for rows whose history has
   *  compacted. Read-only; no audit (reads don't ledger). */
  private async metricsThroughput(sp: URLSearchParams) {
    const parsed = parseThroughputParams(sp.get("bucket"), sp.get("range"));
    if ("error" in parsed) throw new Error(parsed.error);
    const now = Date.now();
    const from = now - parsed.rangeDays * 86_400_000;
    // task ids — only tasks count (decisions/goals have their own lifecycles)
    const taskIds = new Set(
      (this.state.storage.sql.exec(`SELECT id FROM artefacts WHERE type = 'task'`).toArray() as any[]).map((r) => String(r.id)),
    );
    // done transition events in range (LIKE prefilter, JSON.parse for truth —
    // data carries {from, to}; ask-answer rows carry {status:'done'} instead)
    const events: Array<{ ts: number; artefact_id: string }> = [];
    for (const r of this.state.storage.sql.exec(
      `SELECT ts, artefact_id, data FROM ledger
       WHERE kind = 'mutation' AND action = 'transition' AND ts >= ? AND data LIKE '%"to":"done"%'`,
      from,
    ).toArray() as any[]) {
      let to = "";
      try { to = String(JSON.parse(r.data ?? "{}").to ?? ""); } catch { continue; }
      if (to !== "done" || !taskIds.has(String(r.artefact_id))) continue;
      events.push({ ts: Number(r.ts), artefact_id: String(r.artefact_id) });
    }
    // compaction fallback: currently-done tasks with no done-transition row
    const fallback = (this.state.storage.sql.exec(
      `SELECT id, status_ts FROM artefacts WHERE type = 'task' AND status = 'done' AND status_ts >= ?`,
      from,
    ).toArray() as any[]).map((r) => ({ id: String(r.id), status_ts: Number(r.status_ts) }));
    const buckets = aggregateThroughput(events, fallback, { bucket: parsed.bucket, rangeDays: parsed.rangeDays, now });
    return {
      bucket: parsed.bucket,
      range_days: parsed.rangeDays,
      from_ts: buckets[0]?.t ?? from,
      to_ts: now,
      total: buckets.reduce((n, b) => n + b.n, 0),
      buckets,
    };
  }

  private async stats() {
    const byType = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const tick = this.one(`SELECT value FROM settings WHERE key = 'watchdog.last_tick'`);
    const sweep = this.one(`SELECT value FROM settings WHERE key = 'watchdog.sweep'`);
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    let watchdog: Record<string, unknown> | undefined;
    try {
      const recent = this.state.storage.sql.exec(
        `SELECT op, ts FROM events WHERE artefact_id = 'watchdog' ORDER BY seq DESC LIMIT 3`,
      ).toArray() as any[];
      watchdog = {
        last_tick: tick ? Number(tick.value) : 0,
        next_alarm_ts: await this.state.storage.getAlarm(),
        recent_events: recent.map((e) => ({ op: e.op, age_min: Math.round((Date.now() - Number(e.ts)) / 60000) })),
        open_asks: openAsks,
        ...(sweep ? JSON.parse(sweep.value) : {}),
      };
    } catch { /* older sweep shape */ }
    return { counts: byType, watchdog };
  }

  /**
   * Fine-grained progress from a working agent: note + sentiment, shown live on the board.
   * Optional self-reported gauge fields: completion_pct, confidence_pct, risk_pct, context_pct (0–100).
   * completion = how far along; confidence = belief the result is right; risk = chance of
   * failure/drift. Correlated, not the same — charted as separate series.
   */
  private async progressLog(body: any, actor: string) {
    const id = String(body.id ?? "");
    const note = String(body.note ?? body.did ?? "").trim().slice(0, 500);
    const will = String(body.will ?? "").trim().slice(0, 500);
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : "neutral";
    const pct = (v: any) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined);
    const completion_pct = pct(body.completion_pct);
    const confidence_pct = pct(body.confidence_pct);
    const risk_pct = pct(body.risk_pct);
    const context_pct = pct(body.context_pct);
    const row = this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const meta = JSON.parse(row.meta ?? "{}");
    const m = this.settingsMap();
    const myScore = this.agentScores().find((a) => a.label === actor);
    const scoreLine = myScore
      ? `\n\nYour behaviour score: ${myScore.score}/100 (${myScore.grade}).` + (myScore.hints.length ? ` ${myScore.hints.join(" ")}` : "")
      : "";
    const instructions = composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD) + (m.bootstrap_md ? `\n${m.bootstrap_md}` : "") + scoreLine;
    // Re-claim: logging progress on a watchdog-abandoned task flips it back to
    // in_progress (the unblock condition the watchdog promised). Subprocess
    // blocks re-claim the same way — the agent is back, the subprocess resolved.
    // Legitimately blocked tasks (human reasons) keep their status until explicitly resumed.
    const isSubprocessBlock = meta.blocked?.class === "subprocess";
    // gateway attribution (ADR BR#899): re-claims via gateway tokens attribute
    // to the dispatched agent, same as ordinary claims
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.status === "blocked" && ((meta.blocked?.reason ?? "").startsWith("abandoned") || isSubprocessBlock)) {
      await this.transition({ id, to: "in_progress", note: isSubprocessBlock ? "re-claimed — subprocess resolved" : "re-claimed — agent resumed (heartbeat)", gateway: body.gateway, agent: body.agent }, actor);
      delete meta.blocked; // transition cleared it in DB — don't resurrect it here
    } else if (row.status === "todo") {
      // progress on an unclaimed task = intent to work it. Claim if allowed;
      // otherwise say WHY instead of silently logging into a card that never moves.
      const tRoles: string[] = parseTags(row.roles);
      // questions: contributions never claim — the author closes with an ADR
      if (row.type === "question") {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: "contribution logged on a question — questions are answered, not claimed. The author weighs contributions and closes it with an ADR (decision artefact, derived_from this task).",
        };
      }
      const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
      const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
      if (!q.ok) {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED — ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete an analysis child task, link an accepted decision, or pick qualified work. Analysis/review-role agents may claim unqualified work.`,
        };
      }
      await this.transition({ id, to: "in_progress", note: "started — progress logged", gateway: body.gateway, agent: body.agent }, actor);
    }
    // (A) declared grace: a silence window for a long op, made while still
    // running. Requires a will (what the silence is FOR). Cleared by the next
    // ordinary log (the agent is back). Watchdog honors it until it lapses.
    const gm = Math.max(0, Math.min(60, Number(body.grace_minutes) || 0));
    let graceUntil: number | undefined;
    if (gm > 0) {
      if (!will) throw new Error("grace_minutes requires a will — declare what you will be doing during the silence (e.g. 're-index runs, silence ~25m')");
      graceUntil = Date.now() + gm * 60_000;
      meta.grace_until = graceUntil;
    } else {
      delete meta.grace_until; // ordinary log = agent is back
      // an ordinary log on a task with a declared subprocess window = the
      // subprocess resolved (or the agent is back mid-window) — clear it
      delete meta.subprocess;
    }
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // gateway attribution: progress made by a gateway token on behalf of a
    // dispatched agent shows the AGENT as the actor on cards (ADR BR#899) —
    // the gateway stays in the audit trail as the actor of record.
    const progressActor = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : actor;
    if (progressActor !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, progressActor); // gateway→agent edge (BR#2455)
    }
    const prev = meta.last_progress ?? {};
    meta.last_progress = {
      note, will: will || undefined, sentiment, actor: progressActor, ts: Date.now(), session: session ?? meta.session,
      completion_pct:  completion_pct  ?? prev.completion_pct,
      confidence_pct:  confidence_pct  ?? prev.confidence_pct,
      risk_pct:        risk_pct        ?? prev.risk_pct,
      context_pct:     context_pct     ?? prev.context_pct,
    };
    if (session && !meta.session) meta.session = session;
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(meta), Date.now(), id,
    );
    this.audit(actor, "progress", id, { note, sentiment, will: will || undefined });
    this.version(id, actor, "progress", note, { note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct });
    return {
      id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct,
      grace_until: graceUntil, instructions,
    };
  }

  // ---------- the breach door: one fold, one open card per (task, class) ----------
  /** The single breach door (BR#2419 item 6): fold recent audit events for a
   *  task into breach cards. One OPEN card per (task, class) key —
   *  reoccurrences coalesce onto the open card, never spawn duplicates.
   *  Call sites: every transition_rejected, invariant_violation,
   *  spawn_skipped and replay_mismatch lands here through the fold. */
  private async foldBreaches(taskId: string) {
    const since = Date.now() - BREACH_WINDOW_MS * 8; // look back several windows
    const rows = this.state.storage.sql.exec(
      `SELECT ts, op, detail FROM events WHERE artefact_id = ? AND ts > ?
        AND op IN ('transition_rejected','invariant_violation','spawn_skipped','replay_mismatch')
        ORDER BY seq ASC LIMIT 200`,
      taskId, since,
    ).toArray() as any[];
    if (!rows.length) return;
    const openKeys = new Set<string>();
    for (const b of this.state.storage.sql.exec(
      `SELECT meta FROM artefacts WHERE type = 'task' AND status NOT IN ('done','superseded') AND meta LIKE ?`,
      `%"breach_key":"${taskId}|%`,
    ).toArray() as any[]) {
      let m: any = {};
      try { m = JSON.parse(b.meta ?? "{}"); } catch { /* garbage meta is not a breach */ }
      if (typeof m?.breach_key === "string") openKeys.add(m.breach_key);
    }
    const breaches = detectBreaches(
      rows.map((r) => {
        let d: any = {};
        try { d = JSON.parse(r.detail ?? "{}"); } catch { /* tolerate junk detail */ }
        const reason = String(d?.reason ?? (Array.isArray(d?.violations) ? d.violations[0] : "") ?? "unknown");
        return { ts: Number(r.ts), task: taskId, op: String(r.op), reason };
      }),
      openKeys,
    );
    for (const b of breaches) {
      const created = await this.create(
        {
          type: "task",
          title: `Breach: ${b.klass} on ${taskId} — ${b.count} event${b.count === 1 ? "" : "s"}`,
          body_md: `Structural breach detected server-side (fold over the audit stream).\n\n- class: ${b.klass}\n- task: ${taskId}\n- events: ${b.count} in the window (first ${new Date(b.first_ts).toISOString()}, last ${new Date(b.last_ts).toISOString()})\n- sample: ${b.sample}\n\nOne open card per (task, class) — reoccurrences coalesce here instead of spawning duplicates. Investigate the cause (get_history on ${taskId}, the Log), fix the loop, then close this card with what you found.`,
          tags: ["breach", `breach:${b.klass}`],
        },
        "system:breach",
      );
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ? WHERE id = ?`,
        JSON.stringify({ breach_key: b.key, breach_task: taskId, breach_class: b.klass, breach_count: b.count }),
        created.id,
      );
      this.audit("system:breach", "breach_raised", created.id, { key: b.key, task: taskId, klass: b.klass, count: b.count });
      this.version(created.id, "system:breach", "create", `breach card raised — ${b.klass} on ${taskId} (${b.count} events)`, { key: b.key, sample: b.sample });
    }
  }

  /** Replay consistency (BR#2419 item 6): fold the version log's transition
   *  chain forward and compare with the stored status. A mismatch — or a
   *  broken chain (an event's `from` doesn't match the folded state:
   *  forged, deleted, or out-of-order history) — is a replay_mismatch event
   *  through the breach door. */
  private async replayCheck(id: string) {
    const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
    if (!row) return;
    const versions = (
      this.state.storage.sql.exec(
        `SELECT action, data FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 200`,
        id,
      ).toArray() as any[]
    ).reverse();
    if (!versions.length) return;
    const events = versions.map((v) => {
      let d: any = {};
      try { d = JSON.parse(v.data ?? "{}"); } catch { /* tolerate junk rows */ }
      return { action: String(v.action), data: d };
    });
    const fold = replayStatus("", events);
    if (fold.status && fold.status !== row.status) {
      // the law: fold(events) != stored_state is itself a breach (BR#2419 item 6)
      this.audit("system:replay", "replay_mismatch", id, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      this.version(id, "system:replay", "note", `REPLAY MISMATCH: version log folds to '${fold.status}' (${fold.breaks} chain break${fold.breaks === 1 ? "" : "s"}) but stored status is '${row.status}'`, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    } else if (fold.tailBreak) {
      // The newest transition row didn't chain (a stale/duplicate stamp or a
      // silent status write just landed). The fold healed past it — but fresh
      // damage is audited the moment it happens, while historical gaps
      // (pre-gate rows, BR#3322) re-anchor silently instead of re-firing the
      // breach on every transition forever.
      this.audit("system:replay", "chain_break", id, { breaks: fold.breaks });
    }
  }

  private async getHistory(artefactId: string, limit = 100) {
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
       WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`,
      artefactId, Math.min(limit, 200),
    ).toArray().map((r: any) => ({ ...r, data: JSON.parse(r.data ?? "{}") }));
    return { artefact_id: artefactId, versions: rows };
  }

  // ---------- identity, sessions, asks, settings, orient ----------

  /** Resolve a bearer secret to an agent identity; touches last_seen. */
  private async identify(bearer: string) {
    if (!bearer) throw new Error("missing bearer");
    const hash = await hashAuthToken(bearer);
    let row = this.one(`SELECT id, label, tags, principal, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    if (!row) {
      // absorb dev-mode write-visibility hiccups right after mint
      await new Promise((r) => setTimeout(r, 250));
      row = this.one(`SELECT id, label, tags, principal, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    }
    if (!row) throw new Error("unknown auth token");
    if (row.revoked_ts) throw new Error("auth token revoked");
    this.state.storage.sql.exec(`UPDATE auth_tokens SET last_seen_ts = ? WHERE id = ?`, Date.now(), row.id);
    return { token_id: row.id, label: row.label, tags: parseTags(row.tags), principal: row.principal ?? null };
  }

  /**
   * Connected identities, separated by class (BR#2455): `gateways` are the
   * infrastructure tokens (each with the agent labels it dispatched recently),
   * `agents` is everyone else. MCP peers never see gateways inside the agents
   * array — a gateway is not an agent.
   */
  private async listAgents() {
    const cutoff = Date.now() - 10 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT label, tags, transport, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY last_seen_ts DESC`,
    ).toArray().filter((a) => !a.revoked_ts);
    const shape = (a: any) => ({
      label: a.label,
      tags: parseTags(a.tags),
      transport: a.transport ?? "mcp",
      online: a.last_seen_ts >= cutoff,
      last_seen_ts: a.last_seen_ts,
    });
    const agents = rows.filter((a) => !tagsSayGateway(a.tags)).map((a: any) => ({ ...shape(a), tags: [] }));
    const gateways = rows.filter((a) => tagsSayGateway(a.tags)).map((g: any) => ({
      ...shape(g),
      agents: this.state.storage.sql.exec(
        `SELECT agent AS label, last_seen_ts FROM gateway_agents WHERE gateway = ? ORDER BY last_seen_ts DESC LIMIT 20`,
        g.label,
      ).toArray(),
    }));
    return { agents, gateways, note: "bridge routes between agents — gateways are listed separately with the agents they dispatched; transport shows how each is reachable today (mcp) or next (a2a, acp-proxy, board)" };
  }

  /** Does this label's token carry the gateway tag? (attribution authority) */
  private isGatewayActor(label: string): boolean {
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    return !!row && tagsSayGateway(row.tags);
  }

  /** Stamp/refresh the gateway→dispatched-agent edge (Connect grouping). */
  private gatewayTouch(gateway: string, agent: string) {
    this.state.storage.sql.exec(
      `INSERT INTO gateway_agents (gateway, agent, last_seen_ts) VALUES (?, ?, ?)
       ON CONFLICT(gateway, agent) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      gateway.slice(0, 80), agent.slice(0, 80), Date.now(),
    );
  }

  /** The session a write belongs to: explicit, else the token's most recent session. */
  private async resolveSession(body: any, tokenId: string): Promise<string | undefined> {
    if (body.session !== undefined) {
      const named = String(body.session ?? "").trim();
      // an explicitly EMPTY session is anonymous (hub/auto-spawned children
      // start session-less so the token's last-session fallback cannot
      // misattribute them — the first real session to act stamps the card)
      if (!named) return undefined;
      await this.sessionTouch({ token_id: tokenId, session: named, worktree: body.worktree }).catch(() => {});
      return named;
    }
    const row = this.one(
      `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`, tokenId,
    ) as any;
    return row?.name ?? undefined;
  }

  /** Register/refresh a session. Names are unique per auth token.
   *  `worktree` (BR#3204): where the session's git tree lives — surfaced on
   *  orient so the board can spot two sessions sharing a checkout. */
  private async sessionTouch(body: any) {
    const token_id = String(body.token_id ?? "");
    const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
    const worktree = String(body.worktree ?? "").trim().slice(0, 400) || null;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO sessions (token_id, name, kind, worktree, first_seen_ts, last_seen_ts)
       VALUES (?, ?, (SELECT CASE WHEN tags LIKE '%gateway%' THEN 'gateway' END FROM auth_tokens WHERE id = ?), ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts, kind = COALESCE(kind, excluded.kind),
         worktree = COALESCE(excluded.worktree, sessions.worktree)`,
      token_id, name, token_id, worktree, ts, ts,
    );
    return { session: name, worktree };
  }

  private async askCreate(body: any, actor: string) {
    const to = String(body.to ?? "any");
    const question = String(body.question ?? "").trim();
    if (!question) throw new Error("question is required");
    // the question IS the ask — one answerable sentence ending in '?'.
    // Reports, receipts and narrative belong in details (body_md).
    if (question.length > 240) throw new Error("question must be the ask itself, one sentence ≤240 chars — put reports/receipts in details");
    if (!question.endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?' (you sent a status report, not a question)");
    const details = String(body.details ?? "").trim();
    // WHY IT'S ESCALATED is not optional for human-directed asks: "merge PR
    // #84?" is unanswerable without "review is red but rebuttable per guidance".
    const reason = String(body.reason ?? "").trim().slice(0, 400);
    if (!reason && (to === "human" || to === "ray")) throw new Error("asks to a human must state why they are escalated instead of automatic (reason: '…')");
    if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
    const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
    // asks REQUIRE options: the human answers by clicking one of 2-4 buttons
    // (free-text refinement lives in the detail view). No options = rejected
    // at the contract, not a button-less ask the UI can't surface.
    // options are strings the human clicks — objects are flattened to their
    // label-ish field and [object Object] garbage never stores
    const options = [...new Set((Array.isArray(body.options) ? body.options : [])
      .map((o: any) => typeof o === "string" ? o
        : String(o?.label ?? o?.text ?? o?.value ?? o?.title ?? ""))
      .map((x: string) => x.trim())
      .filter((x: string) => x && !/\[object\s*object\]/i.test(x))
      .map((x: string) => x.slice(0, 200)))].slice(0, 8);
    if (options.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (options: ['GO', 'NO-GO'])");
    // urgency is an ASK vocabulary (contract v2 — the same words the FlowsHub
    // ingest accepts and DecisionCard renders; "time-sensitive" = the urgent
    // NOW chip), not a progress sentiment. Validating with isSentiment made
    // every urgent ask collapse to a normal-looking one: the urgent door
    // silently failed (found wiring BR#3008's stop-the-line sweep).
    const urgency = body.urgency === "time-sensitive" ? "time-sensitive" : "normal";

    // the ask IS a question node: BR#-numbered, child_of its subject, answered
    // by transition. The legacy asks row is no longer written.
    if (artefactId) {
      const dup = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
           AND c.type = 'question' AND c.title = ? LIMIT 1`,
        artefactId, question.slice(0, 200),
      );
      if (dup) throw new Error(`an identical ask is already open: ${dup.id} — answer or reframe it instead of re-asking`);
    }
    const created = await this.create(
      {
        type: "question",
        title: question.slice(0, 200),
        body_md: details || question,
        owner: "",
        meta: { ask: { to, urgency, options, from: actor, reason: reason || undefined, artefact_id: artefactId || undefined } },
      },
      actor,
    );
    const id = created.id;
    let taskStatus: string | undefined;
    if (artefactId) {
      const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
      if (!row) throw new Error(`no such artefact: ${artefactId}`);
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
        id, artefactId, Date.now(),
      );
      if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
        if (row.status === "in_progress") {
          // blocked-on-ask (rule 6): the ask pauses the subject and the ANSWER
          // auto-resumes it — the unblock condition IS the ask, so the gate's
          // no-dead-end rule holds and askAnswer's resume leg finds it parked
          // with a live path out (this flip previously hard-failed: the
          // transition went out with a note but no unblock condition).
          await this.transition({
            id: artefactId, to: "blocked",
            note: `blocked on ${to}: ${question.slice(0, 100)}`,
            unblock_condition: `answer ask ${id}`,
          }, actor);
          taskStatus = "blocked";
        }
      }
    }
    this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
    return { id, ask: id, question, artefact_id: artefactId || undefined, options, urgency, task_status: taskStatus };
  }
  private async askInbox(body: any) {
    const label = String(body.label ?? "");
    // nodes are the inbox; open legacy rows are shown until the v2 migration
    // converts them (they then read status 'migrated' and vanish naturally)
    const nodes = this.state.storage.sql.exec(
      `SELECT id, meta, created_ts FROM artefacts
       WHERE type = 'question' AND status IN ('todo','in_progress','blocked')
       ORDER BY created_ts DESC LIMIT 50`,
    ).toArray() as any[];
    const inbox = nodes
      .map((n) => {
        const m = JSON.parse(n.meta ?? "{}");
        if (!m.ask) return null;
        const out: any = { id: n.id, from_label: m.ask.from ?? "agent", to_target: m.ask.to ?? "any", question: n.title, created_ts: n.created_ts, node: true };
        if (m.ask.reframe) out.reframe = m.ask.reframe;
        return out;
      })
      .filter((x): x is any => !!x && (x.to_target === "any" || x.to_target === label || true));
    const open = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    const sent = this.state.storage.sql.exec(
      `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    return { inbox: [...inbox, ...open], sent };
  }


  /** Reframe: the human kicks an ask back to the asker to restructure.
   *  Feedback is recorded on the node and surfaces in the asker's inbox.
   *  Deliberately does NOT answer/resume — the parent stays parked until
   *  a structured re-ask or an explicit answer. */
  private async askReframe(body: any, actor: string) {
    const id = String(body.id ?? "");
    const feedback = String(body.feedback ?? "").trim().slice(0, 1000) ||
      "REFRAME — restructure per the ask contract: one imperative question ≤240 chars, 2-8 one-click options, and why this is escalated instead of automatic.";
    const node = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'question'`, id);
    if (!node) throw new Error(`no such ask: ${id}`);
    const m = JSON.parse(node.meta ?? "{}");
    m.ask = { ...(m.ask ?? {}), reframe: { by: actor, feedback, ts: Date.now() } };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), id);
    this.version(id, actor, "update", `ask reframed by human — ${feedback.slice(0, 160)}`, { reframe: m.ask.reframe });
    this.audit(actor, "ask_reframe", id, { feedback: feedback.slice(0, 200) });
    return { id, reframe: m.ask.reframe };
  }

  /** Admin cleanup: supersede smoke/test rows created in the last 48h. Audited per row. */
  private async purgeSmoke(body: any) {
    const cutoff = Date.now() - 48 * 60 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT id, status FROM artefacts WHERE type = 'task'
         AND status NOT IN ('done','superseded')
         AND created_ts > ?
         AND (title LIKE 'smoke%' OR title LIKE 'phase-2 smoke%' OR title LIKE 'smoke %')`,
      cutoff,
    ).toArray() as any[];
    const now = Date.now();
    for (const r of rows) {
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'superseded', status_ts = ?, updated_ts = ? WHERE id = ?`,
        now, now, r.id,
      );
      this.version(r.id, "system:cleanup", "transition", `purged smoke-test row (was ${r.status})`, { from: r.status, to: "superseded" });
      this.audit("system:cleanup", "transition", r.id, { from: r.status, to: "superseded", reason: "smoke purge" });
    }
    return { purged: rows.map((r: any) => r.id) };
  }

  /** Human handle for an ask: ASK-<subject>-<ordinal> ("ASK-BR-2466-2" = the
   *  2nd ask on that task). The opaque row key stays internal plumbing. */
  private askDisplay(row: { id: string; artefact_id: string | null; created_ts: number }) {
    if (!row.artefact_id) return row.id;
    const ord = this.one(
      `SELECT COUNT(*) AS n FROM asks WHERE artefact_id = ? AND created_ts <= ?`,
      row.artefact_id, row.created_ts,
    ) as any;
    return `ASK-${String(row.artefact_id).replace(/#/g, "-")}-${Number(ord?.n ?? 1)}`;
  }

  private async askGet(id: string) {
    const row = this.one(
      `SELECT id, from_label, to_target, question, status, artefact_id, answer, answered_by, answered_ts, created_ts
         FROM asks WHERE id = ?`, id,
    );
    if (!row) return null;
    return {
      id: row.id, display: this.askDisplay(row), from: row.from_label, to: row.to_target, question: row.question,
      options: [] as string[], urgency: "normal", status: row.status,
      artefact_id: row.artefact_id ?? undefined,
      answer: row.answer ?? undefined, answered_by: row.answered_by ?? undefined,
      answered_ts: row.answered_ts ?? undefined, created_ts: row.created_ts,
    };
  }

  private async askAnswer(body: any, actor: string) {
    const id = String(body.id ?? "");
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw new Error("answer is required");

    // question-node asks (BR#): answer on the node, resume the subject
    if (/^BR#\d+$/.test(id)) {
      const node = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, id);
      if (!node) throw new Error(`no such ask: ${id}`);
      const m = JSON.parse(node.meta ?? "{}");
      if (m.ask?.answer) throw new Error(`ask ${id} already answered`);
      m.ask = { ...(m.ask ?? {}), answer: answer.slice(0, 4000), answered_by: actor, answered_ts: Date.now() };
      // questions complete directly (todo → done) — the claimant status machine
      // is for work items, not for Q&A nodes
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, status = 'done', status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(m), now, now, id,
      );
      // stamp the real from→to — a status change with no from/to is a silent
      // mutation as far as the replay fold is concerned (BR#3322)
      this.version(id, actor, "transition", `answered by ${actor}: ${answer.slice(0, 200)}`, { from: node.status, to: "done", answer: answer.slice(0, 200) });
      let taskStatus: string | undefined;
      const subject = this.one(
        `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? ORDER BY r.created_ts DESC LIMIT 1`, id,
      );
      if (subject) {
        const sm = JSON.parse(subject.meta ?? "{}");
        if (sm.awaiting_ask?.ask_id === id) {
          delete sm.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), subject.id);
        }
        if (subject.status === "blocked") {
          await this.transition({
            id: subject.id, to: "in_progress",
            note: `ask ${id} answered — resumed: ${answer.slice(0, 100)}`,
          }, `system:question(${actor})`);
          taskStatus = "in_progress";
        }
      }
      this.audit(actor, "answer", subject?.id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
      return { id, status: "answered", artefact_id: subject?.id, task_status: taskStatus };
    }

    // legacy asks-row asks (ASK-…) — kept until in-flight rows drain
    const row = this.one(`SELECT status, artefact_id FROM asks WHERE id = ?`, id);
    if (!row) throw new Error(`no such ask: ${id}`);
    if (row.status !== ASK_OPEN) throw new Error(`ask ${id} already ${row.status}`);
    this.state.storage.sql.exec(
      `UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_ts = ? WHERE id = ?`,
      answer.slice(0, 4000), actor, Date.now(), id,
    );
    let taskStatus: string | undefined;
    if (row.artefact_id) {
      const t = this.one(`SELECT status, meta FROM artefacts WHERE id = ?`, String(row.artefact_id));
      if (t) {
        const meta = JSON.parse(t.meta ?? "{}");
        if (meta.awaiting_ask?.ask_id === id) {
          delete meta.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), String(row.artefact_id));
        }
        if (t.status === "blocked") {
          await this.transition({
            id: String(row.artefact_id), to: "in_progress",
            note: `decision ${id} answered — resumed: ${answer.slice(0, 100)}`,
          }, `system:decision(${actor})`);
          taskStatus = "in_progress";
        }
      }
    }
    this.audit(actor, "answer", row.artefact_id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
    return { id, status: ASK_ANSWERED, artefact_id: row.artefact_id ?? undefined, task_status: taskStatus };
  }
  private async orient(body: any) {
    // open question children: DERIVED awaiting_ask (phase 4 — no marker cache)
    const askChildOf = new Map<string, any>();
    for (const c of this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' ORDER BY c.created_ts DESC`,
    ).toArray() as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const counts = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const openStatuses = ["draft", "proposed", "active", "open", "todo", "in_progress", "blocked"];
    const marks = openStatuses.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT id, type, title, status, owner, meta, updated_ts FROM artefacts
       WHERE status IN (${marks}) ORDER BY updated_ts DESC LIMIT 30`,
      ...openStatuses,
    ).toArray().map((t: any) => {
      // agents orienting need the blocked context inline — the exit condition
      // is the actionable part of a blocked card
      if (t.type === "task") {
        const m = JSON.parse(t.meta ?? "{}");
        if (m.blocked) { t.blocked_reason = (m.blocked.reason ?? "").slice(0, 200); t.unblock_condition = (m.blocked.unblock_condition ?? "").slice(0, 200); }
        if (m.subprocess) t.subprocess = { reason: (m.subprocess.reason ?? "").slice(0, 120), deadline_ts: m.subprocess.deadline_ts };
        // BR#3361 (d): the executor lease, visible — sessions doing paperwork
        // on a card can see WHO holds it before acting (the advisory half of
        // the duplicate-executor fence; the audit half fires on transitions)
        if (m.session && ["in_progress", "in_review"].includes(t.status)) t.executor_session = m.session;
        delete t.meta;
      }
      return t;
    });
    // per-role steering: active steering artefacts — universal (no role:* tag)
    // plus any whose role:* tags match the caller's — delivered at orient and
    // at dispatch. The mechanism the merge ladder rides (BR#2799).
    const steeringRows = this.state.storage.sql.exec(
      `SELECT id, title, body_md, tags, roles FROM artefacts
       WHERE type = 'steering' AND status = 'active' ORDER BY updated_ts DESC LIMIT 20`,
    ).toArray();
    const steering = (steeringRows as any[])
      .map((s: any) => ({ id: s.id, title: s.title, body_md: String(s.body_md ?? "").slice(0, 1500), tags: parseTags(s.tags), roles: parseTags(s.roles) }))
      .filter((s: any) => {
        const roles: string[] = s.roles ?? [];
        return roles.length === 0 || roles.some((r: string) => tags.includes(`role:${r}`));
      });
    const askPlaceholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const askMarks = askPlaceholders.map(() => "?").join(",");
    const pendingAsks = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${askMarks})
       ORDER BY created_ts DESC LIMIT 10`,
      label, ...askPlaceholders,
    ).toArray();
    const settings = this.settingsMap();
    const projectName = settings.project_name || "Superpositional";
    // my_tasks for a gateway includes the work of the agents it dispatched
    // (gateway_agents edges): the gateway is the dispatcher and resumer of its
    // workers — owner labels churn with pairings, the gateway does not. This
    // is what makes "same gateway immediately resumes its work" real.
    // machine/agent naming: dispatched workers are labelled <gateway>.<agent>,
    // so a gateway's my_tasks is a prefix glob — its own label plus everything
    // under it — with the gateway_agents edges kept for legacy unprefixed
    // workers.
    const myTasks = this.state.storage.sql.exec(
      `SELECT id, title, status, meta FROM artefacts WHERE type = 'task' AND status IN ('todo','in_progress','in_review','blocked')
       AND (owner = ? OR substr(owner, 1, length(?) + 1) = ? || '/'
            OR owner IN (SELECT agent FROM gateway_agents WHERE gateway = ?)
            OR owner = ?)
       ORDER BY updated_ts DESC LIMIT 10`,
      label, label, label, label, body.principal ?? null,
    ).toArray().map((t: any) => {
      // BR#3361 (d): your tasks carry the executor lease — if another live
      // session holds a task of yours, you see it before acting on it
      const m = JSON.parse(t.meta ?? "{}");
      if (m.session) t.executor_session = m.session;
      delete t.meta;
      return t;
    });
    // dispatch surface: unclaimed todo tasks + BLOCKED tasks awaiting an agent
    // (a blocked card with an unblock condition is actionable — unblocking is
    // priority work). Rank-then-slice: fetch the full open pool FIRST, rank in
    // JS, then cut the top 10. The old 40-newest window was the Oct-20
    // frozen-backlog bug — churn (every claim/progress bumps updated_ts)
    // constantly displaced older-but-ranked items, so they were invisible to
    // the runner and sat in Backlog "blocked" forever.
    const pool = this.state.storage.sql.exec(
      `SELECT id, type, title, tags, roles, meta, project, updated_ts, status FROM artefacts
       WHERE type = 'task' AND status IN ('todo','blocked') AND (owner = '' OR status = 'blocked')
       ORDER BY updated_ts DESC LIMIT 400`,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // gateway callers dispatch sessions and never claim blocked work —
    // resolving an unblock condition is role:unblock duty. Ten blocked cards
    // rank above plain todo and filled the dispatch slice, starving the
    // runner (every claim refused for a missing resolution). Gateways get
    // the claimable surface; agents still see blocked work to reason about.
    const callerIsGateway = tags.some((t) => t.toLowerCase() === "gateway");
    const dispatchPool = callerIsGateway ? pool.filter((t: any) => t.status !== "blocked") : pool;
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    const qualIds = new Set(
      (this.state.storage.sql.exec(
        `SELECT id FROM artefacts WHERE type = 'task'
         AND (json_extract(meta, '$.qualification.state') = 'qualified' OR json_extract(meta, '$.qualified') = 1)`,
      ).toArray() as any[]).map((r) => r.id),
    );
    const parentQualified = new Set<string>();
    const verifyParents = new Map<string, any>();
    for (const l of this.state.storage.sql.exec(
      `SELECT r.src_id, r.dst_id, p.status AS pstatus, p.title AS ptitle, p.owner AS powner
       FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of'`,
    ).toArray() as any[]) {
      if (qualIds.has(l.dst_id) || analysisEv.has(l.dst_id)) parentQualified.add(l.src_id);
      if (l.pstatus === "in_review") verifyParents.set(l.src_id, l);
    }
    const unclaimedWork = dispatchPool.filter((t: any) => {
      const need: string[] = t.roles ?? [];
      const m = JSON.parse(t.meta ?? "{}");
      const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : undefined);
      const qualified = declared === "qualified" || analysisEv.has(t.id) || parentQualified.has(t.id);
      const bars: string[] = m.qualification?.bars ?? [];
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      // task tags declare the KIND of work (analysis/impl/review) — a
      // playbook for the dispatched session, never a worker requirement.
      // Qualification is bar-based only: a task is gated when it DECLARES
      // enforceable bars and they are unmet. There are no agent roles — tags
      // on tasks declare the KIND of work (analysis/impl/review), never a
      // requirement about the worker. The old default-gate (untagged =
      // needs_qualification) starved the queue: fresh, claimable tasks sat
      // behind a concept nobody signed up for.
      t.needs_qualification = unmet.length > 0;
      if (need.length) t.target_roles = need;
      // gateways dispatch sessions; qualification-gated work is role:analysis
      // duty (exactly what a qualify-or-close child task is). Leaving it in
      // the gateway's slice let the oldest gated tasks occupy all 10 slots
      // forever — the runner cycled them while claimable work sat behind.
      return callerIsGateway ? !t.needs_qualification : true;
    }).sort((a: any, b: any) => {
      // ranking: release-parked-work levers first (verify duty + unblock
      // duty), then blocked-with-condition, questions, plain todo.
      const rank = (t: any) => {
        const m = JSON.parse(t.meta ?? "{}");
        // human boost: priority 0, above unblock duty — the human's explicit
        // "process this (and its dependencies) first" (BR#911)
        if (m.boosted) return -1;
        // release-parked-work levers FIRST, above everything claimable:
        // verify duty (an in_review task parks its owner until a fresh
        // session rules) and unblock duty share rank 0. Verify starved below
        // blocked-with-condition (2026-10-24, Ray): ranks 0-1 filled the
        // 10-slot slice, verify children never surfaced, impls piled up
        // in_review while new impl todo kept getting claimed.
        if (t.roles?.includes("unblock")) return 0;
        if (verifyParents.has(t.id)) return 0;
        if (t.status === "blocked" && (m.blocked?.unblock_condition ?? "").trim()) return 1;
        if (t.type === "question") return 3;
        return 4;
      };
      return rank(a) - rank(b) || a.updated_ts - b.updated_ts;
    }).slice(0, 10).map((t: any) => {
      // pool traits — the pattern: computed per row, never stored flags. Clients
      // speak domain language (is_question, is_claimable, previously_attempted),
      // and every claimability blocker here is enforced at the claim gate —
      // a trait that lies is worse than no trait. Extend both together.
      const m = JSON.parse(t.meta ?? "{}");
      // blocked rows: surface the exit condition — the whole point is that an
      // agent can read WHY and decide whether it can clear it.
      if (t.status === "blocked") {
        t.blocked_reason = (m.blocked?.reason ?? "").slice(0, 300);
        t.unblock_condition = (m.blocked?.unblock_condition ?? "").slice(0, 300);
        t.awaiting_ask = askChildOf.get(t.id)?.id ?? m.awaiting_ask?.ask_id;
        t.is_claimable = !!t.unblock_condition; // resume via transition in_progress with resolution
        if (!t.unblock_condition) t.claim_reason = "blocked without an unblock condition — open the card, resolve or re-scope it";
      }
      // questions are a TYPE (asks v3 / BR#2983) — the pickup model, never a tag
      t.is_question = t.type === "question" || isQuestionTask(m) || false;
      const gated = m.operator_gated;
      if (t.status !== "blocked") {
        t.is_claimable = !t.is_question && !gated;
        if (!t.is_claimable) {
          t.claim_reason = t.is_question
            ? "question — answered, not claimed (contribute via log_progress {id, did})"
            : `operator gated: ${gated} — a human clears the gate`;
        }
      }
      if (m.attempt) {
        t.previously_attempted = {
          by: m.attempt.by, attempts: m.attempt.attempts,
          last_reason: m.attempt.last_reason ?? undefined,
          last_will: m.last_progress?.will ? String(m.last_progress.will).slice(0, 200) : undefined,
          note: `task was attempted ${m.attempt.attempts}x before (last by ${m.attempt.by}${m.attempt.last_reason ? ` — came back: ${String(m.attempt.last_reason).slice(0, 120)}` : ""}). VERIFY before working: search_knowledge + get_artefact — the work may already be done (then transition → done) or partially done (continue from the last will: ${m.last_progress?.will ? `"${String(m.last_progress.will).slice(0, 120)}"` : "none recorded"}).`,
        };
      }
      return t;
    });
    // role playbooks (settings.roles.{analysis,impl,...}) composed for this agent's tags
    const rolesSettings = typeof settings.roles === "object" && settings.roles ? settings.roles : {};
    const kindSettings = typeof settings.playbooks === "object" && settings.playbooks ? settings.playbooks : {};
    const isCron = tags.includes("cadence:cron");
    const kindPlaybook =
      (isCron ? kindSettings.cron : kindSettings.interactive)
      ?? (isCron ? DEFAULT_CRON_PLAYBOOK : "");
    const playbooks = tags
      .filter((t) => t.startsWith("role:"))
      .map((t) => ({ role: t.slice(5), playbook: resolveRolePlaybook(rolesSettings, t.slice(5)) }))
      .filter((p) => typeof p.playbook === "string" && p.playbook.trim());
    // reaper: sort out my abandoned work at check-in (see reapAbandoned)
    const staleMinS = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = staleMinS ? Math.max(1, Math.min(120, parseInt(staleMinS.value, 10) || 10)) : 10;
    const actionRequired = this.reapAbandoned(label, staleMin);
    // verification_stalled: an in_review parent's verify child is unclaimed — the
    // parent's owner is parked waiting on a verdict that only pickup can produce.
    // Tell the waiting owner (this is a pickup problem, not a review problem) and
    // any role:review agent (pickup is their duty). 48h = stalled.
    const stalledVerify = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, p.title AS parent_title, p.owner AS parent_owner, c.updated_ts AS age_ts
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'
          AND p.updated_ts < ?`,
      [Date.now() - 48 * 60 * 60 * 1000],
    ).toArray() as any[];

    const reviewPending = stalledVerify.filter(v => v.parent_owner === label).map(v => ({
      task_id: v.verify_task,
      parent_id: v.parent_id,
      parent_title: v.parent_title,
      age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
      message: `Verification for '${v.parent_title}' (Task ${v.parent_id}) is stalled — verify task ${v.verify_task} unclaimed for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
      required_action: "CLAIM_VERIFY_TASK",
    }));

    const reviewDuty = tags.includes('role:review')
      ? stalledVerify.filter(v => v.parent_owner !== label).map(v => ({
        task_id: v.verify_task,
        parent_id: v.parent_id,
        parent_title: v.parent_title,
        age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
        message: `Stalled review: '${v.parent_title}' (Task ${v.parent_id}) has unclaimed verify task ${v.verify_task} for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
        required_action: "PICKUP_REVIEW",
      }))
      : [];

    const verificationNotices = [...reviewPending, ...reviewDuty];
    // gauge debt: owned work in flight whose last log carries no gauges. The
    // board's gauges drive prioritisation and attention scoring — an agent that
    // stops reporting them goes blind on the board. Surface the debt at every
    // orient so the behaviour is corrected while the task is live, not after.
    const gaugeDebt = (this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts
       WHERE type = 'task' AND owner = ? AND status IN ('in_progress','blocked')
       AND (json_extract(meta, '$.last_progress.completion_pct') IS NULL
            AND json_extract(meta, '$.last_progress.confidence_pct') IS NULL
            AND json_extract(meta, '$.last_progress.risk_pct') IS NULL
            AND json_extract(meta, '$.last_progress.context_pct') IS NULL)
       ORDER BY updated_ts DESC LIMIT 10`,
      label,
    ).toArray() as any[]).map((t) => ({ id: t.id, title: t.title }));
    const gaugeDebtNote = gaugeDebt.length
      ? `\n\nGAUGE DEBT — these in-flight tasks have no reported gauges. Your next log_progress on each must include completion_pct, confidence_pct, risk_pct and context_pct (0-100) — the board cannot prioritise or score your work without them: ${gaugeDebt.map((t) => `${t.id} "${t.title.slice(0, 60)}"`).join("; ")}.`
      : "";
    const my_score = this.agentScores().find((a) => a.label === label)
      ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 }) };
    // score optimisation is an explicit standing directive: the agent sees its
    // number, its grade, and the concrete actions that raise it — every
    // check-in, not as trivia at the bottom of the payload.
    const scoreDirective = `\n\nYOUR SCORE: ${my_score.score}/100 (${my_score.grade}). Optimise for it — it gates which work you can claim and whether your tasks survive. ${my_score.hints.length ? "Actions that raise it now: " + my_score.hints.join(" ") : "No deductions — keep heartbeats ≤10m, finish with receipts, answer asks fast."}`;
    return {
      project: projectName,
      instructions: composeBootstrap(projectName, settings.board ?? DEFAULT_BOARD)
        + (settings.bootstrap_md ? `\n${settings.bootstrap_md}` : "")
        + (kindPlaybook ? `\n\nYOUR KIND: ${isCron ? "cron" : "interactive"}\n${kindPlaybook}` : "")
        + playbooks.map((p) => `\n\nYOUR ROLE: ${p.role}\n${p.playbook}`).join("")
        + gaugeDebtNote
        + scoreDirective,
      board: settings.board ?? DEFAULT_BOARD,
      counts,
      open_artefacts: open,
      my_tasks: myTasks,
      unclaimed_work: unclaimedWork,
      steering,
      my_roles: tags.filter((t) => t.startsWith("role:")),
      pending_asks: pendingAsks,
      action_required: actionRequired.length || verificationNotices.length
        ? [...actionRequired, ...verificationNotices]
        : undefined,
      gauge_debt: gaugeDebt.length ? gaugeDebt : undefined,
      my_score,
    };
  }

  /**
   * Reaper: runs at orient (check-in). Blocked-abandoned tasks:
   *  - OWN tasks: activity within the stale window → prompt to check in
   *    (log_progress re-claims); no activity → penalty (score counts the
   *    reaper event) and reassignment.
   *  - ANYONE'S stale-abandoned tasks: reassigned after the stale window —
   *    a vanished agent's claim must not park work forever. Runs at ANY
   *    orient, so the next check-in by any agent sweeps the whole board.
   */
  private reapAbandoned(label: string, staleMin: number): string[] {
    const out: string[] = [];
    const now = Date.now();
    const staleMs = staleMin * 60_000;
    for (const t of this.state.storage.sql.exec(
      `SELECT id, title, meta, tags, status_ts, updated_ts, owner FROM artefacts
       WHERE type = 'task' AND status = 'blocked' AND (owner = ? OR owner != '')`, label,
    ).toArray() as any[]) {
      const meta = JSON.parse(t.meta ?? "{}");
      const reason = String(meta.blocked?.reason ?? "");
      const isAbandoned = reason.startsWith("abandoned");
      // Gate-rejection blocks (runner handoff rejected, churn guard) carry an
      // unblock condition and an unblock child — they get a much longer fuse
      // than abandonment. But if NOTHING moved for a full day the block is a
      // dead end too: release the task back to the pool with the error history
      // on the card (the BR#584-class 123-attempt rows were this).
      const isStuckGate = reason.startsWith("runner:") || reason.startsWith("churn guard:");
      if (!isAbandoned && !isStuckGate) continue;
      const idleLimit = isAbandoned ? staleMs : 24 * 60 * 60_000;
      const idleDesc = isAbandoned ? `silent >${staleMin}m after abandonment` : `no movement >24h after a gate-rejection block`;
      const mine = t.owner === label;
      const ownerLabel = t.owner || label;
      const wasDoing = mine && meta.last_progress?.will ? ` Your last will: "${String(meta.last_progress.will).slice(0, 150)}".` : "";
      const lastOwn = this.one(
        `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`, t.id, ownerLabel,
      )?.ts ?? 0;
      const idleFor = now - Math.max(lastOwn, t.updated_ts ?? 0);
      if (mine && idleFor < idleLimit) {
        if (isAbandoned) {
          out.push(
            `${t.id} "${t.title}" is marked abandoned but you were active on it recently.${wasDoing} log_progress on it NOW to re-claim, then keep the ≤${staleMin}m heartbeat.`,
          );
        }
        continue;
      }
      if (idleFor < idleLimit) continue; // someone else's, still fresh-ish — leave it
      const tags: string[] = parseTags(t.tags);
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      // REWORK-LOOP ESCALATION: past 5 attempts this is not bad luck — it's a
      // loop (claim → stall → watchdog-bounce → blocked → release → claim…).
      // Re-releasing just runs the same cycle again. Park it blocked-for-human:
      // only a human (web/human actor) may release it from here on.
      if (attempts >= 5) {
        meta.blocked = {
          reason: `rework loop detected — ${attempts} dispatch attempts without completion (last release reason: ${reason.slice(0, 160)}). Re-running again would repeat the cycle; escalated to a human.`,
          unblock_condition: "human: review the attempt history (get_history) — either fix what keeps failing, re-scope the task, or transition it todo yourself to deliberately continue",
          ts: now,
        };
        meta.attempt = { by: ownerLabel, at: now, attempts, last_reason: reason.slice(0, 200) };
        this.state.storage.sql.exec(
          `UPDATE artefacts SET tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
        );
        this.audit("system:reaper", "loop_escalated", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
        // a NOTE, not a transition row — the status does not change here; a
        // transition stamp without from/to is invisible to the replay fold
        // and masquerades as a move that never happened (BR#3322)
        this.version(t.id, "system:reaper", "note", `rework loop escalated to human — ${attempts} attempts without completion`, { prev_owner: ownerLabel, attempts });
        out.push(
          `${t.id} "${t.title}" REWORK LOOP (${attempts} attempts) — escalated to a human instead of re-releasing. Blocked-for-human until reviewed.`,
        );
        continue;
      }
      meta.attempt = { by: ownerLabel, at: now, attempts };
      delete meta.blocked;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
      );
      this.audit("system:reaper", "reassign", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
      // the reassign IS a status change (blocked → todo, the loop's WHERE
      // clause pins `status = 'blocked'`) — stamp the real from/to so the
      // replay fold can chain it (the from/to-less stamp was a silent
      // mutation that broke every later fold — BR#3322's Oct-20 shape)
      this.version(t.id, "system:reaper", "transition", `reassigned — ${ownerLabel} ${idleDesc} (attempt ${attempts})`, { from: "blocked", to: "todo", prev_owner: ownerLabel });
      out.push(
        mine
          ? `${t.id} "${t.title}" was REASSIGNED: you ${idleDesc}.${wasDoing} Your score is penalised. It is now unclaimed todo, tagged "attempted" (attempt ${attempts}) — partial work may exist. Do not blindly restart it: search_knowledge + get_artefact first.`
          : `${t.id} "${t.title}" was REASSIGNED: ${ownerLabel} ${idleDesc} (attempt ${attempts}) — back to unclaimed todo for any agent to pick up.`,
      );
    }
    return out;
  }

  /** Project-facing settings only (safe for any authenticated agent). */
  private publicSettings() {
    const m = this.settingsMap();
    return { project_name: m.project_name, board: m.board ?? DEFAULT_BOARD, bootstrap_md: m.bootstrap_md };
  }

  private settingsMap(): Record<string, any> {
    const rows = this.state.storage.sql.exec(`SELECT key, value FROM settings`).toArray();
    const map: Record<string, any> = {};
    for (const r of rows as any[]) map[r.key] = JSON.parse(r.value);
    return map;
  }

  // ---------- admin ops (human plane) ----------

  /** stable DO slug for this instance's workspace (set by the registry at creation) */
  private wsSlug(): string {
    const m = this.settingsMap() as Record<string, any>;
    return typeof m.ws_slug === "string" ? m.ws_slug : "";
  }

  // ---- workspace registry (lives in the "global" KB DO; owner-checked, no admin flag) ----

  /** one-time import of the legacy hard-coded membership list */
  private async wsSeed(logins: string[]) {
    const now = Date.now();
    const slug = DEFAULT_WS_SLUG;
    // this DO *is* the default workspace — stamp it so tokens minted here embed the slug
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('ws_slug', ?)`,
      JSON.stringify(slug),
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, 1, ?)`,
      slug, logins[0] ?? "legacy", now,
    );
    for (const login of logins) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
      );
    }
    return { ok: true, seeded: logins };
  }

  private async wsList(login: string) {
    const rows = this.state.storage.sql.exec(
      `SELECT w.slug, w.owner, w.personal, w.created_ts,
              EXISTS(SELECT 1 FROM workspace_members m WHERE m.ws = w.slug AND m.login = ?) AS member
         FROM workspaces w ORDER BY w.created_ts ASC`,
      login,
    ).toArray();
    return {
      workspaces: rows.map((r) => ({
        slug: r.slug, owner: r.owner, personal: !!r.personal,
        created_ts: r.created_ts, member: !!r.member,
      })),
    };
  }

  /** create: owner = caller; they become the first member; personal workspaces are <login> */
  private async wsCreate(body: any, login: string) {
    const slug = String(body.slug ?? "").trim();
    if (slug === "global" || slug === "legacy") throw new Error("reserved workspace name");
    if (slug !== login && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) {
      throw new Error("slug must be 2-40 chars [a-z0-9-] (or your username for a personal ws)");
    }
    if (this.one(`SELECT slug FROM workspaces WHERE slug = ?`, slug)) {
      throw new Error(`workspace '${slug}' already exists`);
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, ?, ?)`,
      slug, login, slug === login ? 1 : 0, now,
    );
    this.state.storage.sql.exec(
      `INSERT INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
    );
    // provision the KB DO for this workspace immediately: schema init + ws_slug
    // stamp so tokens minted there embed this workspace's slug
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(slug)));
    await stub.fetch("https://kb/bootstrap", { method: "POST", body: "{}" }).catch(() => {});
    await stub.fetch("https://kb/admin.settings_set", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ settings: { ws_slug: slug } }),
    }).catch(() => {});
    return { ok: true, slug };
  }

  /** join: only the owner of an existing workspace can add members */
  private async wsJoin(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    if (w.owner !== login) throw new Error("only the workspace owner can add members");
    const who = String(body.login ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(who)) throw new Error("bad github login");
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, who,
    );
    return { ok: true, ws: slug, login: who };
  }

  private async wsMembers(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login);
    if (w.owner !== login && !member) throw new Error("not a member of this workspace");
    const rows = this.state.storage.sql.exec(
      `SELECT login FROM workspace_members WHERE ws = ? ORDER BY login`, slug,
    ).toArray();
    return { ws: slug, owner: w.owner, members: rows.map((r) => r.login) };
  }

  /** Central registry of opaque token → workspace, written at mint time so /mcp
   *  can route without the workspace slug being embedded in the secret. */
  private async wsTokenRegister(body: any) {
    const hash = String(body.hash ?? ""), ws = String(body.ws ?? "");
    if (!/^[0-9a-f]{64}$/.test(hash) || !isWsSlug(ws)) throw new Error("bad token registration");
    this.state.storage.sql.exec(
      `INSERT INTO ws_tokens (hash, ws, created_ts) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET ws = excluded.ws`,
      hash, ws, Date.now(),
    );
    return { ok: true };
  }

  private async wsTokenLookup(body: any) {
    const row = this.one(`SELECT ws FROM ws_tokens WHERE hash = ?`, String(body.hash ?? ""));
    return { ws: row?.ws ?? null };
  }

  // ---- device pairing (lives in the registry DO) ----
  // GitHub-like device flow, but bridge-native: the device shows a code, the
  // human approves it in the web UI (picking workspace + roles), and the device
  // polls its token once. The approver never holds the credential.

  static PAIR_TTL_MS = 15 * 60_000;
  static PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I

  private pairCode(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const chars = [...bytes].map((b) => KnowledgeHub.PAIR_ALPHABET[b % KnowledgeHub.PAIR_ALPHABET.length]);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
  }

  private pairPurge() {
    const cutoff = Date.now() - KnowledgeHub.PAIR_TTL_MS;
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE created_ts < ?`, cutoff);
    // hard cap on pending rows so /api/pair/start can't be spammed into bloat
    const n = this.one(`SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending'`)?.n ?? 0;
    if (n > 100) {
      this.state.storage.sql.exec(
        `DELETE FROM pairings WHERE status = 'pending' AND code NOT IN (
           SELECT code FROM pairings WHERE status = 'pending' ORDER BY created_ts DESC LIMIT 100)`,
      );
    }
  }

  private async wsPairStart(body: any) {
    this.pairPurge();
    const code = this.pairCode();
    const now = Date.now();
    // the DEVICE declares its class at start; the approver never chooses —
    // streams cannot cross because the request, not the human, sets the type.
    // Pairing IS a gateway act (agents are provisioned by gateways, never
    // self-paired), so an absent/unrecognized type defaults to gateway —
    // legacy CLIs that predate the field pair as gateways too.
    const type = body.type === "agent" ? "agent" : "gateway";
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    this.state.storage.sql.exec(
      `INSERT INTO pairings (code, device, type, principal, status, created_ts) VALUES (?, ?, ?, ?, 'pending', ?)`,
      // host is the DISPLAY name (BR#899: labels display, the device
      // credential anchors); body.device fallback covers desktops predating
      // the field rename
      code, String(body.host ?? body.device ?? "device").slice(0, 80), type, principal, now,
    );
    return { code, type, expires_ts: now + KnowledgeHub.PAIR_TTL_MS };
  }

  private async wsPairGet(body: any) {
    const row = this.one(
      `SELECT device, type, status, created_ts, ws, label FROM pairings WHERE code = ?`,
      String(body.code ?? "").trim().toUpperCase(),
    );
    if (!row) return { status: "expired" };
    if (row.status === "pending" && Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, row.code);
      return { status: "expired" };
    }
    return { status: row.status, device: row.device, type: row.type ?? "agent", created_ts: row.created_ts, ws: row.ws, label: row.label };
  }

  private async wsPairApprove(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const ws = String(body.ws ?? "").trim();
    const label = String(body.label ?? "").trim();
    const login = String(body.login ?? "").toLowerCase();
    const row = this.one(`SELECT code, created_ts, status, device, type, principal FROM pairings WHERE code = ?`, code);
    if (!row || row.status !== "pending") throw new Error("pairing code not pending");
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      throw new Error("pairing code expired");
    }
    // class was declared by the DEVICE at pair/start — the approver cannot
    // change it, only name the identity and pick the workspace
    const gateway = row.type === "gateway";
    const tags = gateway ? ["gateway"] : Array.isArray(body.tags) ? body.tags.map((t: any) => String(t)).slice(0, 10) : [];
    if (!isWsSlug(ws)) throw new Error("bad workspace slug");
    // reserved roots: _-prefixed labels are system namespaces (_direct for
    // directly connected agents) — a gateway may not take one, so
    // _direct/* ownership can never be impersonated by a paired device
    if (/^_/.test(label)) throw new Error(`labels beginning with '_' are reserved system roots (got '${label}')`);
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._/-]");
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, ws, login);
    if (!member) throw new Error(`you are not a member of workspace '${ws}'`);
    // mint in the target workspace's DO (registers hash → ws in the central
    // registry); the token flows to the DEVICE via poll, never to the approver
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(ws)));
    const mintRes = await stub.fetch("https://kb/admin.mint", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ label, tags, principal: row.principal ?? null }),
    });
    const minted = await (mintRes as any).json();
    if (!(mintRes as any).ok || !minted.secret) {
      throw new Error(String(minted?.error ?? "token mint failed"));
    }
    if (minted.reassociated) {
      this.audit(login, "pair.reassociate", code, { device: row.device, ws, label, token: minted.id });
    }
    this.state.storage.sql.exec(
      `UPDATE pairings SET status = 'authorized', ws = ?, label = ?, tags = ?, secret = ?, approved_ts = ? WHERE code = ?`,
      ws, label, JSON.stringify(tags), minted.secret, Date.now(), code,
    );
    this.audit(login, "pair.approve", code, { device: row.device, ws, label });
    return { ok: true, ws, label };
  }

  private async wsPairPoll(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const row = this.one(`SELECT code, status, secret, ws, label, tags, created_ts, last_poll_ts FROM pairings WHERE code = ?`, code);
    if (!row) return { status: "expired" };
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "expired" };
    }
    // slow-down: devices poll every ~3s; faster than 1.5s gets backed off
    if (row.last_poll_ts && Date.now() - row.last_poll_ts < 1500) {
      return { status: "slow_down" };
    }
    this.state.storage.sql.exec(`UPDATE pairings SET last_poll_ts = ? WHERE code = ?`, Date.now(), code);
    if (row.status === "pending") return { status: "pending" };
    if (row.status === "denied") {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "denied" };
    }
    // authorized: one-time read — the token leaves the registry exactly once
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
    return {
      status: "authorized",
      token: row.secret,
      ws: row.ws,
      label: row.label,
      tags: row.tags ? JSON.parse(row.tags) : [],
    };
  }

  /** Gateway-provisioned agent tokens (per agent, not per session).
   *  A gw-* caller mints (or rotates) a token FOR a worker it spawns — the
   *  worker's bridge MCP carries this token, so its board actions attribute
   *  to the agent, not the gateway. Secrets are shown once; the gateway
   *  stores them. Exists w/o rotate = { exists: true } (no secret re-exposed). */
  private async agentProvision(body: any, actor: string) {
    const caller = String(body.provisioned_by ?? actor);
    // gateway is a token trait: the caller's TAG provisions, its name is irrelevant
    if (!this.isGatewayActor(caller)) throw new Error(`agent provisioning requires a gateway-class caller ('${caller}' does not carry the gateway tag)`);
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error(`agent label '${label}' must be 2-40 chars [a-zA-Z0-9._-]`);
    // a namespaced label (<gateway>/<agent>) may only live under the
    // provisioning gateway's own prefix — otherwise an agent label could
    // squat inside another gateway's ownership glob
    if (label.includes("/") && !label.startsWith(`${caller}/`)) {
      throw new Error(`namespaced label '${label}' must live under the provisioning gateway's own namespace ('${caller}/...')`);
    }
    const rotate = body.rotate === true;
    const ts = Date.now();
    const existing = this.one(`SELECT id, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (existing && !rotate) {
      if (existing.revoked_ts) throw new Error(`token '${label}' was revoked — provision with rotate to re-mint`);
      return { exists: true, id: existing.id, label };
    }
    if (existing) {
      // label is UNIQUE across ALL rows (schema: `label TEXT NOT NULL UNIQUE`),
      // so the old revoke-then-INSERT could NEVER satisfy it — rotate 400'd
      // with SQLITE_CONSTRAINT_UNIQUE on its first real exercise (2026-10-24;
      // the runner's rotate-retry exposed it). Rotate = replace the row
      // outright: DELETE + INSERT. The audit trail is the history (a revoked
      // row authenticates nothing); sessions.token_id has no FK — an orphaned
      // reference renders label-less in the registry join, harmless.
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE label = ?`, label);
      this.audit(caller, "rotate", label, { old: existing.id, replaced: true });
    }
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const tags = JSON.stringify(["provisioned", `by:${caller}`]);
    try {
      this.state.storage.sql.exec(
        `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
        id, label, hash, tags, body.principal ?? null, ts,
      );
    } catch (e) {
      // Race: two concurrent rotates of the same label (parallel dispatch
      // sessions under one agent label are normal in this fleet) can both
      // pass the lookup, DELETE, then collide on the INSERT — the loser must
      // converge to update-in-place, never 400 (a provisioning 400 strands
      // the runner with a dead token and no repair).
      if (!String(e).includes("UNIQUE")) throw e;
      const racer = this.one(`SELECT id FROM auth_tokens WHERE label = ?`, label) as any;
      if (!racer) throw e;
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
        hash, tags, racer.id,
      );
      id = racer.id as string;
      this.audit(caller, "rotate", label, { replaced: true, raced: true });
    }
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws }),
      });
    }
    this.audit(caller, "agent_provision", id, { label, rotate: existing ? true : false });
    return { id, label, secret, provisioned_by: caller };
  }

  /** Gateway self-provision (credential-class ADR, desktop gateway leg):
   *  the human session mints THIS device's gateway-class token — the login
   *  IS the human approval. ONE device credential: hub-vended on first
   *  provision (returned to the desktop, stored, never regenerated),
   *  presented on every later provision — replace-by-PRINCIPAL rotates the
   *  gateway token in place (Ray 2026-10-23: one random generation approach;
   *  no IOPlatformUUID, no client-side p_*). Label = bare hostname slug
   *  (display only, BR#899); class = tags ["gateway"]. Audit op
   *  `self_provision` stamped with the web actor. */
  private async selfProvision(body: any, actor: string) {
    const login = String(body.login ?? "").trim();
    if (!login) throw new Error("self-provision requires the session login (worker-derived)");
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : "";
    const label = selfProvisionLabel(body.host);
    const ws = this.wsSlug() || String(body.ws ?? "");
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    const mintTags = JSON.stringify(["gateway"]);
    const register = (h: string) =>
      (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG))).fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash: h, ws }),
      });
    let id: string;
    let vended: string | undefined;
    // same machine, token rotation in place: match by principal first; the
    // deterministic label (same host -> same label) is the fallback when the
    // principal reset (config wipes regenerate it) — the machine re-claims
    // its identity by name, and the rotation stamps the fresh principal.
    let own = principal ? this.one(`SELECT id, label FROM auth_tokens WHERE principal = ?`, principal) as any : null;
    if (!own) {
      own = this.one(`SELECT id, label FROM auth_tokens WHERE label = ?`, label) as any;
    }
    if (own) {
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = ?, revoked_ts = NULL WHERE id = ?`,
        hash, label, mintTags, principal, own.id,
      );
      id = own.id as string;
      await register(hash);
    } else {
      // first provision: the hub VENDS the device credential (one random
      // generation approach — generateAuthToken is the only generator)
      vended = principal || generateAuthToken();
      id = `at_${crypto.randomUUID().slice(0, 8)}`;
      try {
        this.state.storage.sql.exec(
          `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
          id, label, hash, mintTags, vended, Date.now(),
        );
      } catch (e) {
        // Race: a concurrent self-provision (a parallel dispatch loop on the
        // same machine, or a 401-repair storm after a rotation) inserted the
        // same deterministic label between our lookup and this INSERT —
        // SQLITE_CONSTRAINT_UNIQUE on label. Converge to replace-in-place
        // instead of failing the repair: a failed repair is a hard logout
        // (dispatch.rs), so this path must never 400 on the label collision.
        if (!String(e).includes("UNIQUE")) throw e;
        const racer = this.one(`SELECT id, principal FROM auth_tokens WHERE label = ?`, label) as any;
        if (!racer) throw e;
        this.state.storage.sql.exec(
          `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
          hash, mintTags, racer.id,
        );
        id = racer.id as string;
        // the surviving row's principal is the credential of record — return
        // it so the desktop stores what actually authenticates
        if (racer.principal) vended = racer.principal as string;
      }
      await register(hash); // registry failure fails the mint — never misroute
    }
    this.audit(actor, "self_provision", null, { label, principal: vended ?? principal, login, ws, token_id: id, replaced: !!own });
    return { secret, label, ws, id, principal: vended ?? principal };
  }

  private async tokenMint(body: any) {
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
    // the only '/' allowed in a human-minted label is the reserved
    // _direct/ root — directly connected agents live there
    if (label.includes("/") && !label.startsWith("_direct/")) {
      throw new Error("labels cannot contain '/' — only the reserved _direct/ root (directly connected agents) may");
    }
    // The device credential (principal) is the rotation anchor — BR#2711 §2:
    // labels are display; the hub-vended, generate-once-never-change
    // credential keys replace-on-re-pair (no IOPlatformUUID, no device_id —
    // both withdrawn).
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    // Replace semantics (pairing is an approval): the same machine re-pairing
    // rotates its token — renamed or not — and re-using a label REPLACES the
    // token that held it. A name has exactly one live token; nothing
    // accumulates, nothing dead-ends on "already exists".
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let own = principal ? this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE principal = ?`, principal) : null;
    const byLabel = this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (own && byLabel && own.id !== byLabel.id) {
      // renaming this machine onto another token's name: that identity is
      // replaced (the human approved the pairing; one name, one live token)
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE id = ?`, byLabel.id);
      this.audit("pair", "replace", byLabel.id, { label });
    }
    const target = (own && !byLabel) ? own : (byLabel ?? own);
    if (target) {
      // the vended class rides with the replacement: a gateway pairing must
      // not leave the row carrying the replaced token's stale tags
      const mintTags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = COALESCE(?, principal), revoked_ts = NULL WHERE id = ?`,
        hash, label, JSON.stringify(mintTags), principal, target.id,
      );
      const ws = this.wsSlug();
      if (ws) {
        const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
        await reg.fetch("https://kb/ws.token_register", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, ws }),
        });
      }
      this.audit("pair", "reassociate", target.id, { label });
      return { id: target.id, label, secret, reassociated: true };
    }
    const tags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
    const transport = (TRANSPORTS as readonly string[]).includes(body.transport) ? body.transport : "mcp";
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, label, hash, JSON.stringify(tags), transport, principal, ts,
    );
    // register hash → workspace in the central registry so /mcp routes this
    // token here. Registry failure must fail the mint — a silently unregistered
    // token would misroute to the default workspace.
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws }),
      });
    }
    this.audit("admin", "mint", id, { label, transport, tags });
    return { id, label, tags, transport, secret }; // secret shown exactly once
  }

  private async tokenList() {
    const rows = this.state.storage.sql.exec(
      `SELECT id, label, tags, transport, created_ts, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY created_ts DESC`,
    ).toArray();
    const sessions = this.state.storage.sql.exec(
      `SELECT token_id, name, first_seen_ts, last_seen_ts FROM sessions ORDER BY last_seen_ts DESC`,
    ).toArray();
    // gateway → dispatched-agent edges for Connect's grouping (BR#2455)
    const gateway_agents = this.state.storage.sql.exec(
      `SELECT gateway, agent, last_seen_ts FROM gateway_agents ORDER BY last_seen_ts DESC LIMIT 200`,
    ).toArray();
    return { tokens: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })), sessions, gateway_agents };
  }

  private async tokenRevoke(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), id);
    this.audit("admin", "revoke", id, { label: row.label });
    return { id, revoked: true };
  }

  /** Update an agent's tags (roles/capabilities) in place — no re-mint, the secret stays valid. */
  private async tokenTags(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label, tags FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    const tags = sanitizeTags(body.tags);
    this.state.storage.sql.exec(
      `UPDATE auth_tokens SET tags = ? WHERE id = ?`,
      tags ? JSON.stringify(tags) : "[]", id,
    );
    this.audit("admin", "tags", id, { label: row.label, tags: tags ?? [] });
    return { id, label: row.label, tags: tags ?? [] };
  }

  private async settingsGet() {
    return { settings: this.settingsMap() };
  }

  private async settingsSet(body: any) {
    const entries = Object.entries(body.settings ?? {}).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
    if (entries.length === 0) throw new Error("no valid settings keys (lowercase [a-z0-9_])");
    for (const [k, v] of entries) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        k, JSON.stringify(v),
      );
      this.audit("admin", "settings", k, {});
    }
    return { settings: this.settingsMap() };
  }

  // ---------- GitHub enrichment ----------

  private ghCache = new Map<string, { ts: number; data: any }>();

  private async ghIssue(num: number): Promise<any | null> {
    if (!this.env.GH_TOKEN) return null;
    const repo = this.settingsMap().github_repo ?? "state-vector/superpositional";
    const key = `${repo}#${num}`;
    const hit = this.ghCache.get(key);
    if (hit && Date.now() - hit.ts < 600_000) return hit.data;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
        headers: {
          authorization: `Bearer ${this.env.GH_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "bridge-kb",
        },
      });
      if (!r.ok) return null;
      const data = await r.json();
      this.ghCache.set(key, { ts: Date.now(), data });
      return data;
    } catch { return null; }
  }

  /** Pull issue body/labels into a bare artefact. Idempotent via the "## From GitHub" marker. */
  private async enrichFromGitHub(id: string, num: number) {
    const row = this.one(`SELECT title, body_md, tags, updated_ts FROM artefacts WHERE id = ?`, id);
    if (!row || (row.body_md ?? "").includes("## From GitHub")) return null;
    const issue = await this.ghIssue(num);
    if (!issue) return null;
    const labels: string[] = (issue.labels ?? []).map((l: any) => String(l.name ?? l));
    const body = `${row.body_md ?? ""}\n## From GitHub — #${num}\n**${issue.title}** · state: ${issue.state}${labels.length ? ` · labels: ${labels.join(", ")}` : ""}\n\n${String(issue.body ?? "").slice(0, 2000)}\n`;
    const existing = parseTags(row.tags);
    const merged = [...new Set([...existing, ...labels.map((l) => l.toLowerCase().replace(/[^a-z0-9:_-]/g, "-"))])].slice(0, 10);
    this.state.storage.sql.exec(
      `UPDATE artefacts SET body_md = ?, tags = ?, updated_ts = ? WHERE id = ?`,
      body, JSON.stringify(merged), Date.now(), id,
    );
    await this.embedArtefact(id, row.title, body);
    this.audit("system", "enrich", id, { issue: num });
    return id;
  }

  /** Enrich one or all bare, issue-referencing tasks. */
  private async enrich(body: any, actor: string) {
    if (!this.env.GH_TOKEN) throw new Error("GH_TOKEN not configured — GitHub enrichment unavailable");
    const targets = body.id
      ? [String(body.id)]
      : this.state.storage.sql.exec(
          `SELECT id, title, body_md FROM artefacts
           WHERE type = 'task' AND status = 'open' OR (type = 'task' AND status IN ('todo','in_progress','blocked'))
           ORDER BY updated_ts DESC LIMIT 50`,
        ).toArray()
          .filter((r: any) => !(r.body_md ?? "").includes("## From GitHub"))
          .map((r: any) => r.id);
    const done: string[] = [];
    for (const id of targets) {
      const row = this.one(`SELECT title, body_md FROM artefacts WHERE id = ?`, id);
      if (!row) continue;
      const num = issueRef(row.title);
      if (num && !(row.body_md ?? "").includes("## From GitHub")) {
        const r = await this.enrichFromGitHub(id, num);
        if (r) done.push(id);
      }
    }
    this.audit(actor, "enrich", null, { count: done.length });
    return { enriched: done };
  }

  // ---------- helpers ----------

  /** THE append-only ledger — every mutation (kind 'mutation') and every
   *  signal (kind 'signal') is one row in one sequence. events/artefact_versions
   *  are views over this. */
  private ledgerWrite(kind: 'signal' | 'mutation', actor: string, action: string, artefactId: string | null, summary: string, data: object): { seq: number; ts: number } {
    const ts = Date.now();
    const r = this.state.storage.sql.exec(
      `INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      ts, actor, kind, action, artefactId, summary.slice(0, 500), JSON.stringify(data),
    ).toArray()[0] as any;
    return { seq: Number(r?.seq ?? 0), ts };
  }

  /** Append-only per-artefact history: every mutation gets one mutation row. */
  private version(artefactId: string, actor: string, action: string, summary: string, data: object = {}) {
    const { seq, ts } = this.ledgerWrite('mutation', actor, action, artefactId, summary, data);
    // remember it so the paired audit() broadcast reuses this row instead of
    // writing a second signal row for the same fact
    this._lastMutation = { key: `${artefactId}:${action}`, seq, ts, actor, action, artefactId, data };
  }

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    const key = `${artefactId}:${op}`;
    let seq: number; let ts: number;
    const last = this._lastMutation;
    if (last && last.key === key && Date.now() - last.ts < 5_000) {
      // same fact already recorded as a mutation — broadcast THAT row, no second write
      ({ seq, ts } = last);
      this.broadcastEvent({ seq, ts, actor: last.actor, op: last.action, artefact_id: last.artefactId, detail: last.data });
      this._lastMutation = null;
      this.scoreCache = null;
      return;
    }
    ({ seq, ts } = this.ledgerWrite('signal', actor, op, artefactId, "", detail));
    this.broadcastEvent({ seq, ts, actor, op, artefact_id: artefactId, detail });
    // every mutation can move behaviour signals — drop the 30s score cache so
    // board reads after writes are fresh (the cache exists for DO row-read quota)
    this.scoreCache = null;
  }

  private _lastMutation: { key: string; seq: number; ts: number; actor: string; action: string; artefactId: string | null; data: object } | null = null;

  private async nextSeq(_type: ArtefactType): Promise<number> {
    const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
    let max = 0;
    for (const r of rows as any[]) {
      const m = /^BR#(\d+)$/.exec(String(r.id));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  // :any on purpose — rows come back as Record<string, SqlStorageValue> and every
  // caller immediately narrows to the columns it selected; the per-site casts the
  // strict ratchet will want are deferred until that pass (BR#2505 guard landed
  // non-strict on purpose).
  private one(query: string, ...params: any[]): any {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  private shape(row: any): any {
    return { ...row, meta: JSON.parse(row.meta ?? "{}"), tags: parseTags(row.tags), roles: parseTags(row.roles) };
  }

  private json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}

// re-export for the worker entry's type-free JS import
export { idSeq };

/** Final tags to write: the executor's tags_add merged into the row's tags. */
function tagsForWrite(verdict: Extract<Awaited<ReturnType<typeof decide>>, { ok: true }>, base: string[]): string[] {
  if (!verdict.tags_add.length) return base;
  const t = [...base];
  for (const x of verdict.tags_add) if (!t.includes(x)) t.push(x);
  return t;
}
